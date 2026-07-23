import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ScenarioEnvelope, SpiralAbyssScenario } from '../../../src/shared/domain.js';
import { runScenarioDataFilesExclusive } from '../../../src/main/scenario-publication/file-coordinator.js';

async function makeTempDirs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-scenario-'));
  const bundled = path.join(root, 'bundled');
  const cache = path.join(root, 'cache');
  await fs.mkdir(bundled, { recursive: true });
  await fs.mkdir(cache, { recursive: true });
  return { root, bundled, cache };
}

function abyssEnvelope(version: string): ScenarioEnvelope<SpiralAbyssScenario> {
  return {
    mode: 'spiral-abyss',
    meta: {
      fetchedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      sourceVersion: version,
      expiresAt: new Date('2026-12-31T00:00:00Z').toISOString(),
      source: 'bundled'
    },
    scenario: {
      cycleId: 'test-cycle',
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-01-14T00:00:00Z',
      blessingOfAbyssalMoon: { name: 'Test', description: 'Test buff' },
      floors: []
    }
  };
}

async function writeBundled(dir: string) {
  for (const mode of ['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater']) {
    await fs.writeFile(
      path.join(dir, `${mode}.json`),
      JSON.stringify(abyssEnvelope(`bundled-${mode}`))
    );
  }
}

let tempRoot: string | undefined;

beforeEach(async () => {
  tempRoot = undefined;
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('ScenarioStore', () => {
  it('summarizes and clears downloaded caches while restoring bundled scenarios', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    const publicationCache = path.join(root, 'scenario-publications-v2');
    tempRoot = root;
    await writeBundled(bundled);
    await fs.writeFile(
      path.join(cache, 'spiral-abyss.json'),
      JSON.stringify(abyssEnvelope('cached-newer'))
    );
    await fs.mkdir(path.join(publicationCache, 'production'), { recursive: true });
    await fs.writeFile(
      path.join(publicationCache, 'production', 'spiral-abyss.json'),
      JSON.stringify({ signed: 'production-snapshot' })
    );
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({
      bundledDir: bundled,
      cacheDir: cache,
      productionCacheDir: publicationCache
    });
    await store.init();

    const confirmation = await store.getDataManagementSnapshot();
    expect(confirmation).toMatchObject({
      count: 3,
      clearableCount: 2,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    await expect(
      store.clearDownloadedCache({
        count: confirmation.clearableCount,
        fingerprint: confirmation.fingerprint
      })
    ).resolves.toBe(2);
    expect(store.getScenario('spiral-abyss').meta.sourceVersion).toBe('bundled-spiral-abyss');
    await expect(store.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 3,
      clearableCount: 0
    });
    await expect(
      fs.stat(path.join(publicationCache, 'production', 'spiral-abyss.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports unknown size on read errors and uses the newest managed file mtime', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    const publicationCache = path.join(root, 'scenario-publications-v2');
    tempRoot = root;
    await writeBundled(bundled);
    const older = path.join(cache, 'spiral-abyss.json');
    await fs.writeFile(older, JSON.stringify(abyssEnvelope('older')));
    await fs.mkdir(path.join(publicationCache, 'production'), { recursive: true });
    const newer = path.join(publicationCache, 'production', 'stygian-onslaught.json');
    await fs.writeFile(newer, JSON.stringify({ signed: 'newer' }));
    const unknown = path.join(cache, 'imaginarium-theater.json');
    await fs.mkdir(unknown);
    await fs.utimes(older, new Date('2026-07-20T00:00:00Z'), new Date('2026-07-20T00:00:00Z'));
    await fs.utimes(newer, new Date('2026-07-22T00:00:00Z'), new Date('2026-07-22T00:00:00Z'));

    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({
      bundledDir: bundled,
      cacheDir: cache,
      productionCacheDir: publicationCache
    });
    await store.init();
    const summary = await store.getDataManagementSnapshot();

    expect(summary.sizeBytes).toBeUndefined();
    expect(summary.updatedAt).toBe('2026-07-22T00:00:00.000Z');
    expect(summary.clearableCount).toBe(2);
  });

  it('serializes confirmed clear with production writers and rejects a queued replacement', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    const publicationCache = path.join(root, 'scenario-publications-v2');
    const productionDir = path.join(publicationCache, 'production');
    tempRoot = root;
    await writeBundled(bundled);
    await fs.mkdir(productionDir, { recursive: true });
    const target = path.join(productionDir, 'spiral-abyss.json');
    await fs.writeFile(target, JSON.stringify({ signed: 'first' }));
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({
      bundledDir: bundled,
      cacheDir: cache,
      productionCacheDir: publicationCache
    });
    await store.init();
    const confirmation = await store.getDataManagementSnapshot();
    let releaseWriter!: () => void;
    const holdWriter = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writerStarted = resolve;
    });
    const writer = runScenarioDataFilesExclusive(publicationCache, 'production', async () => {
      writerStarted();
      await holdWriter;
      await fs.writeFile(target, JSON.stringify({ signed: 'replacement' }));
    });
    await started;
    const clear = store.clearDownloadedCache({
      count: confirmation.clearableCount,
      fingerprint: confirmation.fingerprint
    });
    releaseWriter();
    await writer;

    await expect(clear).rejects.toThrow(/changed/i);
    await expect(fs.readFile(target, 'utf8')).resolves.toContain('replacement');
  });

  it('loads bundled JSON on first init and exposes meta via list()', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');

    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache });
    await store.init();

    const list = store.list();
    expect(list).toHaveLength(3);
    const abyss = list.find((s) => s.mode === 'spiral-abyss');
    expect(abyss?.meta.sourceVersion).toBe('bundled-spiral-abyss');
    const env = store.getScenario('spiral-abyss');
    expect(env.mode).toBe('spiral-abyss');
  });

  it('prefers cached JSON over bundled when present', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    await fs.writeFile(
      path.join(cache, 'spiral-abyss.json'),
      JSON.stringify(abyssEnvelope('cached-newer'))
    );
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');

    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache });
    await store.init();
    expect(store.getScenario('spiral-abyss').meta.sourceVersion).toBe('cached-newer');
  });

  it('rejects scenario downloads whose sha256 does not match the manifest', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);

    const envelope = abyssEnvelope('remote-v2');
    const remoteText = JSON.stringify(envelope);
    const actualSha = createHash('sha256').update(remoteText).digest('hex');

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) {
        return {
          statusCode: 200,
          body: {
            text: async () =>
              JSON.stringify({
                updatedAt: 'manifest-v2',
                scenarios: {
                  'spiral-abyss': {
                    url: 'https://example.com/abyss.json',
                    sha256: 'definitely-wrong-' + actualSha
                  }
                }
              })
          }
        };
      }
      return {
        statusCode: 200,
        body: {
          text: async () => remoteText,
          arrayBuffer: async () => new TextEncoder().encode(remoteText).buffer
        }
      };
    }) as unknown as typeof import('undici').request;

    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache, fetchImpl });
    await store.init();

    const refreshed = await store.refresh();
    expect(refreshed).toEqual([]);
    // Bundled value still wins.
    expect(store.getScenario('spiral-abyss').meta.sourceVersion).toBe('bundled-spiral-abyss');
  });

  it('writes remote refreshes through to cache and bumps source to remote', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);

    const envelope = abyssEnvelope('remote-v3');
    const remoteText = JSON.stringify(envelope);
    const sha = createHash('sha256').update(remoteText).digest('hex');

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) {
        return {
          statusCode: 200,
          body: {
            text: async () =>
              JSON.stringify({
                updatedAt: 'manifest-v3',
                scenarios: {
                  'spiral-abyss': { url: 'https://example.com/abyss.json', sha256: sha }
                }
              })
          }
        };
      }
      return {
        statusCode: 200,
        body: {
          text: async () => remoteText,
          arrayBuffer: async () => new TextEncoder().encode(remoteText).buffer
        }
      };
    }) as unknown as typeof import('undici').request;

    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache, fetchImpl });
    await store.init();
    const refreshed = await store.refresh();
    expect(refreshed).toContain('spiral-abyss');
    expect(store.getScenario('spiral-abyss').meta.source).toBe('remote');
    const cached = JSON.parse(await fs.readFile(path.join(cache, 'spiral-abyss.json'), 'utf8'));
    expect(cached.meta.source).toBe('remote');
  });
});
