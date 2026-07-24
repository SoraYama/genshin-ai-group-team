import { createHash, randomUUID } from 'node:crypto';
import { promises as nodeFileSystem } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { ephemeralGuideMatchSchema, sourceCitationSchema } from '../../shared/advisor-knowledge.js';
import { guideResearchTaskSchema, type GuideResearchTask } from './knowledge-coverage-gate.js';

export const GUIDE_RESEARCH_CACHE_FILENAME = 'guide-research.json';
export const GUIDE_RESEARCH_CACHE_SCHEMA_VERSION = 1;
export const GUIDE_RESEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const GUIDE_RESEARCH_CACHE_MAX_ENTRIES = 100;
export const GUIDE_RESEARCH_CACHE_MAX_BYTES = 2 * 1024 * 1024;

const cacheKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const knowledgeVersionSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: true }).max(40);
const boundedTextSchema = z.string().trim().min(1).max(500);

const ephemeralCitationSchema = sourceCitationSchema.extend({
  trust: z.literal('ephemeral-web')
});

export const ephemeralGuideCacheValueSchema = z
  .object({
    trust: z.literal('ephemeral-web'),
    matches: z.array(ephemeralGuideMatchSchema).min(1).max(256),
    citations: z.array(ephemeralCitationSchema).min(1).max(512),
    applicability: z
      .object({
        characterNames: z.array(z.string().trim().min(1).max(80)).max(32),
        scenarioTags: z.array(z.string().trim().min(1).max(80)).max(32),
        buildSignals: z.array(z.string().trim().min(1).max(120)).max(32)
      })
      .strict(),
    conflicts: z.array(boundedTextSchema).max(64),
    researchedAt: timestampSchema,
    contentObservedAt: timestampSchema.optional(),
    validUntil: timestampSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.matches.map(({ id }) => id),
      ['matches'],
      context
    );
    addDuplicateIssues(
      value.citations.map(({ id }) => id),
      ['citations'],
      context
    );
    const citationIds = new Set(value.citations.map(({ id }) => id));
    value.matches.forEach((match, matchIndex) => {
      match.citationIds.forEach((citationId, citationIndex) => {
        if (!citationIds.has(citationId)) {
          context.addIssue({
            code: 'custom',
            path: ['matches', matchIndex, 'citationIds', citationIndex],
            message: 'Ephemeral match citation IDs must resolve in this cache value'
          });
        }
      });
    });
    if (containsForbiddenSensitiveText(value)) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Guide research values cannot contain account or credential material'
      });
    }
  });

export type EphemeralGuideCacheValue = z.infer<typeof ephemeralGuideCacheValueSchema>;

const cacheEntrySchema = z
  .object({
    key: cacheKeySchema,
    knowledgeVersion: knowledgeVersionSchema,
    trust: z.literal('ephemeral-web'),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    value: ephemeralGuideCacheValueSchema
  })
  .strict()
  .superRefine(({ createdAt, expiresAt }, context) => {
    const createdTime = Date.parse(createdAt);
    const expiryTime = Date.parse(expiresAt);
    if (expiryTime - createdTime !== GUIDE_RESEARCH_CACHE_TTL_MS) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Guide research entries must use the fixed 24-hour TTL'
      });
    }
  });

const cacheDocumentSchema = z
  .object({
    schemaVersion: z.literal(GUIDE_RESEARCH_CACHE_SCHEMA_VERSION),
    entries: z.array(cacheEntrySchema).max(GUIDE_RESEARCH_CACHE_MAX_ENTRIES)
  })
  .strict()
  .superRefine(({ entries }, context) => {
    addDuplicateIssues(
      entries.map(({ key }) => key),
      ['entries'],
      context
    );
  });

type CacheDocument = z.infer<typeof cacheDocumentSchema>;
type CacheEntry = CacheDocument['entries'][number];

export interface GuideResearchCacheFileSystem {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  writeFile(filePath: string, contents: string, encoding: 'utf8'): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  stat(filePath: string): Promise<{ size: number }>;
}

export type GuideResearchCacheDiagnosticCode =
  | 'GUIDE_RESEARCH_CACHE_INVALID'
  | 'GUIDE_RESEARCH_CACHE_UNREADABLE';

export interface GuideResearchCacheDiagnostic {
  code: GuideResearchCacheDiagnosticCode;
  file: typeof GUIDE_RESEARCH_CACHE_FILENAME;
}

export type GuideResearchCacheErrorCode =
  | 'GUIDE_RESEARCH_CLOCK_INVALID'
  | 'GUIDE_RESEARCH_ENTRY_TOO_LARGE'
  | 'GUIDE_RESEARCH_SELECTION_CHANGED'
  | 'GUIDE_RESEARCH_WRITE_FAILED';

export class GuideResearchCacheError extends Error {
  override readonly name = 'GuideResearchCacheError';

  constructor(
    readonly code: GuideResearchCacheErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface GuideResearchCacheOptions {
  filePath: string;
  fileSystem?: GuideResearchCacheFileSystem;
  now?: () => number;
  onDiagnostic?: (diagnostic: GuideResearchCacheDiagnostic) => void;
}

export interface GuideResearchCacheLookup {
  task: GuideResearchTask;
  knowledgeVersion: string;
}

export interface GuideResearchCachePut extends GuideResearchCacheLookup {
  value: EphemeralGuideCacheValue;
}

export interface GuideResearchCacheSnapshot {
  count: number;
  sizeBytes?: number;
  updatedAt?: string;
  fingerprint: string;
}

interface LoadedCache {
  document: CacheDocument;
  sizeBytes?: number;
  fingerprint: string;
}

const MISSING_FINGERPRINT = createHash('sha256')
  .update('guide-research-cache:missing')
  .digest('hex');
const UNREADABLE_FINGERPRINT = createHash('sha256')
  .update('guide-research-cache:unreadable')
  .digest('hex');

export function resolveGuideResearchCachePath(userDataDirectory: string): string {
  if (!path.isAbsolute(userDataDirectory)) {
    throw new Error('Guide research userData directory must be absolute');
  }
  return path.join(userDataDirectory, 'cache', GUIDE_RESEARCH_CACHE_FILENAME);
}

export function computeGuideResearchCacheKey(task: unknown, knowledgeVersion: unknown): string {
  const parsedTask = guideResearchTaskSchema.parse(task);
  const parsedKnowledgeVersion = knowledgeVersionSchema.parse(knowledgeVersion);
  return createHash('sha256')
    .update(canonicalJson({ task: parsedTask, knowledgeVersion: parsedKnowledgeVersion }))
    .digest('hex');
}

export class GuideResearchCache {
  readonly filePath: string;

  private readonly fileSystem: GuideResearchCacheFileSystem;
  private readonly now: () => number;
  private readonly onDiagnostic?: (diagnostic: GuideResearchCacheDiagnostic) => void;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: GuideResearchCacheOptions) {
    assertIsolatedCachePath(options.filePath);
    this.filePath = options.filePath;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.now = options.now ?? Date.now;
    this.onDiagnostic = options.onDiagnostic;
  }

  async get(input: GuideResearchCacheLookup): Promise<EphemeralGuideCacheValue | undefined> {
    const lookup = parseLookup(input);
    await this.writeQueue;
    const now = this.currentTime();
    const loaded = await this.load(now);
    const key = computeGuideResearchCacheKey(lookup.task, lookup.knowledgeVersion);
    const entry = loaded.document.entries.find((candidate) => candidate.key === key);
    return entry === undefined ? undefined : cloneValue(entry.value);
  }

  async put(input: GuideResearchCachePut): Promise<EphemeralGuideCacheValue> {
    const lookup = parseLookup(input);
    const value = ephemeralGuideCacheValueSchema.parse(input.value);
    return this.enqueueWrite(async () => {
      const now = this.currentTime();
      const createdAt = new Date(now).toISOString();
      const key = computeGuideResearchCacheKey(lookup.task, lookup.knowledgeVersion);
      const entry = cacheEntrySchema.parse({
        key,
        knowledgeVersion: lookup.knowledgeVersion,
        trust: 'ephemeral-web',
        createdAt,
        expiresAt: new Date(now + GUIDE_RESEARCH_CACHE_TTL_MS).toISOString(),
        value
      });
      const singleEntryDocument = documentWith([entry]);
      if (documentBytes(singleEntryDocument) > GUIDE_RESEARCH_CACHE_MAX_BYTES) {
        throw new GuideResearchCacheError(
          'GUIDE_RESEARCH_ENTRY_TOO_LARGE',
          'Ephemeral guide research entry exceeds the cache file limit'
        );
      }

      const loaded = await this.load(now);
      const entries = loaded.document.entries.filter(
        ({ key: candidateKey }) => candidateKey !== key
      );
      entries.push(entry);
      const bounded = enforceLimits(entries);
      await this.atomicWrite(documentWith(bounded));
      return cloneValue(value);
    });
  }

  async getSummary(): Promise<Omit<GuideResearchCacheSnapshot, 'fingerprint'>> {
    const snapshot = await this.getDataManagementSnapshot();
    const summary = { ...snapshot } as Partial<GuideResearchCacheSnapshot>;
    delete summary.fingerprint;
    return summary as Omit<GuideResearchCacheSnapshot, 'fingerprint'>;
  }

  async getDataManagementSnapshot(): Promise<GuideResearchCacheSnapshot> {
    await this.writeQueue;
    const now = this.currentTime();
    const loaded = await this.load(now);
    const updatedAt = newestCreatedAt(loaded.document.entries);
    return {
      count: loaded.document.entries.length,
      ...(loaded.sizeBytes === undefined ? {} : { sizeBytes: loaded.sizeBytes }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      fingerprint: loaded.fingerprint
    };
  }

  async clearAll(expected: { count: number; fingerprint: string }): Promise<number> {
    return this.enqueueWrite(async () => {
      const now = this.currentTime();
      const loaded = await this.load(now);
      if (
        expected.count !== loaded.document.entries.length ||
        expected.fingerprint !== loaded.fingerprint
      ) {
        throw new GuideResearchCacheError(
          'GUIDE_RESEARCH_SELECTION_CHANGED',
          'Ephemeral guide research cache changed; confirm again'
        );
      }
      try {
        await this.fileSystem.unlink(this.filePath);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw new GuideResearchCacheError(
            'GUIDE_RESEARCH_WRITE_FAILED',
            'Ephemeral guide research cache could not be cleared'
          );
        }
      }
      return loaded.document.entries.length;
    });
  }

  private currentTime(): number {
    const value = this.now();
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > 8_640_000_000_000_000 - GUIDE_RESEARCH_CACHE_TTL_MS
    ) {
      throw new GuideResearchCacheError(
        'GUIDE_RESEARCH_CLOCK_INVALID',
        'Guide research cache clock is invalid'
      );
    }
    return value;
  }

  private async load(now: number): Promise<LoadedCache> {
    let raw: string;
    try {
      raw = await this.fileSystem.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return {
          document: documentWith([]),
          sizeBytes: 0,
          fingerprint: MISSING_FINGERPRINT
        };
      }
      this.diagnostic('GUIDE_RESEARCH_CACHE_UNREADABLE');
      return { document: documentWith([]), fingerprint: UNREADABLE_FINGERPRINT };
    }

    const sizeBytes = Buffer.byteLength(raw, 'utf8');
    const fingerprint = createHash('sha256').update(raw).digest('hex');
    if (sizeBytes > GUIDE_RESEARCH_CACHE_MAX_BYTES) {
      this.diagnostic('GUIDE_RESEARCH_CACHE_INVALID');
      return { document: documentWith([]), sizeBytes, fingerprint };
    }
    try {
      const parsed = cacheDocumentSchema.parse(JSON.parse(raw));
      const entries = parsed.entries.filter((entry) => isEntryCurrent(entry, now));
      return { document: documentWith(entries), sizeBytes, fingerprint };
    } catch {
      this.diagnostic('GUIDE_RESEARCH_CACHE_INVALID');
      return { document: documentWith([]), sizeBytes, fingerprint };
    }
  }

  private async atomicWrite(document: CacheDocument): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(
      directory,
      `.${GUIDE_RESEARCH_CACHE_FILENAME}.${randomUUID()}.tmp`
    );
    const contents = JSON.stringify(document);
    try {
      await this.fileSystem.mkdir(directory, { recursive: true });
      await this.fileSystem.writeFile(temporaryPath, contents, 'utf8');
      await this.fileSystem.rename(temporaryPath, this.filePath);
    } catch {
      try {
        await this.fileSystem.unlink(temporaryPath);
      } catch {
        // Cleanup is best-effort; errors remain redacted behind the stable write error below.
      }
      throw new GuideResearchCacheError(
        'GUIDE_RESEARCH_WRITE_FAILED',
        'Ephemeral guide research cache could not be written'
      );
    }
  }

  private diagnostic(code: GuideResearchCacheDiagnosticCode): void {
    this.onDiagnostic?.({ code, file: GUIDE_RESEARCH_CACHE_FILENAME });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function parseLookup(input: GuideResearchCacheLookup): GuideResearchCacheLookup {
  return {
    task: guideResearchTaskSchema.parse(input.task),
    knowledgeVersion: knowledgeVersionSchema.parse(input.knowledgeVersion)
  };
}

function documentWith(entries: CacheEntry[]): CacheDocument {
  return cacheDocumentSchema.parse({
    schemaVersion: GUIDE_RESEARCH_CACHE_SCHEMA_VERSION,
    entries
  });
}

function enforceLimits(entries: CacheEntry[]): CacheEntry[] {
  const bounded = [...entries];
  while (
    bounded.length > GUIDE_RESEARCH_CACHE_MAX_ENTRIES ||
    documentBytes(documentWith(bounded)) > GUIDE_RESEARCH_CACHE_MAX_BYTES
  ) {
    const oldest = [...bounded].sort(compareOldest)[0];
    if (oldest === undefined) break;
    bounded.splice(
      bounded.findIndex(({ key }) => key === oldest.key),
      1
    );
  }
  return bounded;
}

function compareOldest(left: CacheEntry, right: CacheEntry): number {
  const createdDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return createdDifference === 0 ? left.key.localeCompare(right.key) : createdDifference;
}

function documentBytes(document: CacheDocument): number {
  return Buffer.byteLength(JSON.stringify(document), 'utf8');
}

function isEntryCurrent(entry: CacheEntry, now: number): boolean {
  const createdAt = Date.parse(entry.createdAt);
  const expiresAt = Date.parse(entry.expiresAt);
  return createdAt <= now && now <= expiresAt;
}

function newestCreatedAt(entries: CacheEntry[]): string | undefined {
  return entries.reduce<string | undefined>(
    (newest, { createdAt }) =>
      newest === undefined || Date.parse(createdAt) > Date.parse(newest) ? createdAt : newest,
    undefined
  );
}

function cloneValue(value: EphemeralGuideCacheValue): EphemeralGuideCacheValue {
  return ephemeralGuideCacheValueSchema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot encode non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Canonical JSON supports only JSON-compatible values');
}

function assertIsolatedCachePath(filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error('Guide research cache path must be absolute');
  }
  const normalized = path.normalize(filePath);
  if (
    path.basename(normalized) !== GUIDE_RESEARCH_CACHE_FILENAME ||
    path.basename(path.dirname(normalized)) !== 'cache'
  ) {
    throw new Error('Guide research cache path must target the userData cache directory');
  }
  const pathSegments = normalized.split(path.sep);
  const resourcesIndex = pathSegments.lastIndexOf('resources');
  if (resourcesIndex >= 0 && pathSegments[resourcesIndex + 1] === 'knowledge') {
    throw new Error('Trusted knowledge resources cannot be used as an ephemeral cache directory');
  }
}

function addDuplicateIssues(
  values: readonly string[],
  pathPrefix: Array<string | number>,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [...pathPrefix, index],
        message: 'IDs must be unique'
      });
    }
    seen.add(value);
  });
}

function containsForbiddenSensitiveText(value: EphemeralGuideCacheValue): boolean {
  const privateText = [
    ...value.matches.flatMap(({ id, subjectId, summary }) => [id, subjectId, summary]),
    ...value.citations.flatMap(({ id, sourceId, title }) => [id, sourceId, title]),
    ...value.applicability.characterNames,
    ...value.applicability.scenarioTags,
    ...value.applicability.buildSignals,
    ...value.conflicts
  ];
  if (
    privateText.some(
      (text) =>
        /(?:authorization|cookie|api[-_ ]?key|raw[-_ ]?message|sdk[-_ ]?message)\s*[:=]/iu.test(
          text
        ) || /(?:^|[^0-9])[1-9][0-9]{8}(?:[^0-9]|$)/u.test(text)
    )
  ) {
    return true;
  }
  return value.citations.some(({ url }) => {
    const parsed = new URL(url);
    return Array.from(parsed.searchParams.keys()).some((key) =>
      /^(?:authorization|cookie|api[-_]?key|token|uid|user[-_]?id)$/iu.test(key)
    );
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code?: unknown }).code) === code
  );
}
