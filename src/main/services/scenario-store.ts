import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { request } from 'undici';
import {
  ALL_SCENARIO_MODES,
  type ScenarioEnvelope,
  type ScenarioListItem,
  type ScenarioMeta,
  type ScenarioMode,
  type ScenarioPayload
} from '../../shared/domain.js';

export const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/sorayama/genshin-team-advisor-data/main/manifest.json';

export interface ScenarioStoreOptions {
  bundledDir: string;
  cacheDir: string;
  productionCacheDir?: string;
  manifestUrl?: string;
  manifestTimeoutMs?: number;
  fetchImpl?: typeof request;
}

interface RemoteManifest {
  updatedAt?: string;
  scenarios?: Partial<Record<ScenarioMode, { url: string; sha256?: string; expiresAt?: string }>>;
}

const STALE_GRACE_MS = 24 * 60 * 60 * 1000;

function isScenarioEnvelope(value: unknown): value is ScenarioEnvelope<ScenarioPayload> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ScenarioEnvelope<ScenarioPayload>>;
  return (
    typeof candidate.mode === 'string' &&
    typeof candidate.meta === 'object' &&
    candidate.meta !== null &&
    'scenario' in candidate
  );
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isStale(meta: ScenarioMeta, now = Date.now()): boolean {
  const expiresAt = Date.parse(meta.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return now - expiresAt > STALE_GRACE_MS;
}

export class ScenarioStore {
  private readonly bundledDir: string;
  private readonly cacheDir: string;
  private readonly manifestUrl: string;
  private readonly productionCacheDir?: string;
  private readonly manifestTimeoutMs: number;
  private readonly cache = new Map<ScenarioMode, ScenarioEnvelope<ScenarioPayload>>();
  private readonly fetchImpl: typeof request;
  private manifestFailureCount = 0;

  constructor(options: ScenarioStoreOptions) {
    this.bundledDir = options.bundledDir;
    this.cacheDir = options.cacheDir;
    this.productionCacheDir = options.productionCacheDir;
    this.manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
    this.manifestTimeoutMs = options.manifestTimeoutMs ?? 3_000;
    this.fetchImpl = options.fetchImpl ?? request;
  }

  /**
   * Boot: load every mode from cache (preferred) or bundled (fallback). This is
   * synchronous-by-spirit — every call resolves with a value even on first run.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await Promise.all(
      ALL_SCENARIO_MODES.map(async (mode) => {
        const envelope = await this.loadFromDisk(mode);
        this.cache.set(mode, envelope);
      })
    );
  }

  list(): ScenarioListItem[] {
    return ALL_SCENARIO_MODES.map((mode) => {
      const env = this.cache.get(mode);
      const meta: ScenarioMeta = env?.meta ?? this.fallbackMeta();
      return {
        mode,
        meta: { ...meta, stale: meta.stale ?? isStale(meta) }
      };
    });
  }

  getScenario(mode: ScenarioMode): ScenarioEnvelope<ScenarioPayload> {
    const env = this.cache.get(mode);
    if (!env) {
      throw new Error(`Scenario not loaded: ${mode}`);
    }
    return {
      ...env,
      meta: { ...env.meta, stale: env.meta.stale ?? isStale(env.meta) }
    };
  }

  /**
   * Pull the manifest, then update any modes whose remote `updatedAt` is newer
   * than what we have on disk. Caller decides cadence (startup, every 6h, etc.).
   */
  async refresh(opts: { mode?: ScenarioMode; force?: boolean } = {}): Promise<ScenarioMode[]> {
    let manifest: RemoteManifest | undefined;
    try {
      manifest = await this.fetchManifest();
      this.manifestFailureCount = 0;
    } catch (error) {
      this.manifestFailureCount += 1;
      console.warn(
        `[scenario-store] manifest fetch failed (#${this.manifestFailureCount}):`,
        error instanceof Error ? error.message : error
      );
      return [];
    }

    if (!manifest?.scenarios) return [];

    const targets = opts.mode ? [opts.mode] : ALL_SCENARIO_MODES;
    const refreshed: ScenarioMode[] = [];

    for (const mode of targets) {
      const entry = manifest.scenarios[mode];
      if (!entry?.url) continue;
      const current = this.cache.get(mode);
      const remoteUpdatedAt = manifest.updatedAt ?? '';
      if (!opts.force && current && current.meta.sourceVersion === remoteUpdatedAt) continue;

      try {
        const envelope = await this.downloadScenario(mode, entry.url, entry.sha256);
        const updated: ScenarioEnvelope<ScenarioPayload> = {
          ...envelope,
          meta: {
            ...envelope.meta,
            source: 'remote',
            sourceVersion: remoteUpdatedAt || envelope.meta.sourceVersion,
            fetchedAt: new Date().toISOString(),
            expiresAt: entry.expiresAt ?? envelope.meta.expiresAt
          }
        };
        await this.writeCache(mode, updated);
        this.cache.set(mode, updated);
        refreshed.push(mode);
      } catch (error) {
        console.warn(
          `[scenario-store] remote refresh ${mode} failed:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    return refreshed;
  }

  markStale(mode: ScenarioMode): void {
    const env = this.cache.get(mode);
    if (!env) return;
    this.cache.set(mode, { ...env, meta: { ...env.meta, stale: true } });
  }

  /** For diagnostics / refresher's WebFetch fallback gate (v0.7+). */
  getManifestFailureCount(): number {
    return this.manifestFailureCount;
  }

  async getDataManagementSnapshot(): Promise<{
    count: number;
    clearableCount: number;
    sizeBytes?: number;
    updatedAt?: string;
    fingerprint: string;
  }> {
    const files = await Promise.all(
      this.dataManagementCacheFiles().map(async ({ key, filePath }) => {
        try {
          const [bytes, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
          return {
            key,
            size: stat.size,
            hash: createHash('sha256').update(bytes).digest('hex')
          };
        } catch {
          return { key, size: 0, hash: 'missing' };
        }
      })
    );
    const updatedAt = [...this.cache.values()]
      .map(({ meta }) => meta.fetchedAt)
      .sort((left, right) => right.localeCompare(left))[0];
    const clearable = files.filter(({ hash }) => hash !== 'missing');
    return {
      count: this.cache.size,
      clearableCount: clearable.length,
      sizeBytes: clearable.reduce((total, { size }) => total + size, 0),
      ...(updatedAt ? { updatedAt } : {}),
      fingerprint: createHash('sha256')
        .update(JSON.stringify(files.map(({ key, hash }) => ({ key, hash }))))
        .digest('hex')
    };
  }

  async clearDownloadedCache(): Promise<number> {
    let removed = 0;
    for (const { filePath } of this.dataManagementCacheFiles()) {
      try {
        await fs.unlink(filePath);
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await this.init();
    return removed;
  }

  private dataManagementCacheFiles(): Array<{ key: string; filePath: string }> {
    const legacy = ALL_SCENARIO_MODES.map((mode) => ({
      key: `legacy:${mode}`,
      filePath: path.join(this.cacheDir, `${mode}.json`)
    }));
    const production = this.productionCacheDir
      ? ALL_SCENARIO_MODES.map((mode) => ({
          key: `production:${mode}`,
          filePath: path.join(this.productionCacheDir!, 'production', `${mode}.json`)
        }))
      : [];
    return [...legacy, ...production];
  }

  private async loadFromDisk(mode: ScenarioMode): Promise<ScenarioEnvelope<ScenarioPayload>> {
    const cachePath = path.join(this.cacheDir, `${mode}.json`);
    try {
      const cached = await fs.readFile(cachePath, 'utf8');
      const parsed = JSON.parse(cached);
      if (isScenarioEnvelope(parsed)) return parsed;
    } catch {
      // miss → fall through to bundled
    }
    const bundledPath = path.join(this.bundledDir, `${mode}.json`);
    const raw = await fs.readFile(bundledPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isScenarioEnvelope(parsed)) {
      throw new Error(`Bundled scenario ${mode} has invalid shape`);
    }
    return parsed;
  }

  private async writeCache(
    mode: ScenarioMode,
    envelope: ScenarioEnvelope<ScenarioPayload>
  ): Promise<void> {
    const cachePath = path.join(this.cacheDir, `${mode}.json`);
    await fs.writeFile(cachePath, JSON.stringify(envelope, null, 2), 'utf8');
  }

  private async fetchManifest(): Promise<RemoteManifest> {
    const response = await this.fetchImpl(this.manifestUrl, {
      method: 'GET',
      headersTimeout: this.manifestTimeoutMs,
      bodyTimeout: this.manifestTimeoutMs
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`manifest HTTP ${response.statusCode}`);
    }
    const text = await response.body.text();
    return JSON.parse(text) as RemoteManifest;
  }

  private async downloadScenario(
    mode: ScenarioMode,
    url: string,
    expectedSha?: string
  ): Promise<ScenarioEnvelope<ScenarioPayload>> {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headersTimeout: this.manifestTimeoutMs,
      bodyTimeout: this.manifestTimeoutMs * 2
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`scenario ${mode} HTTP ${response.statusCode}`);
    }
    const buf = Buffer.from(await response.body.arrayBuffer());
    if (expectedSha) {
      const actual = sha256(buf);
      if (actual !== expectedSha.toLowerCase()) {
        throw new Error(`scenario ${mode} sha256 mismatch (got ${actual})`);
      }
    }
    const parsed = JSON.parse(buf.toString('utf8'));
    if (!isScenarioEnvelope(parsed)) {
      throw new Error(`scenario ${mode} payload invalid`);
    }
    if (parsed.mode !== mode) {
      throw new Error(`scenario ${mode} mode mismatch (got ${parsed.mode})`);
    }
    return parsed;
  }

  private fallbackMeta(): ScenarioMeta {
    const now = new Date().toISOString();
    return {
      fetchedAt: now,
      sourceVersion: 'unknown',
      expiresAt: now,
      source: 'bundled',
      stale: true
    };
  }
}
