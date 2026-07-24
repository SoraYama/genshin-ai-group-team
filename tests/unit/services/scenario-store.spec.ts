import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ScenarioEnvelope, SpiralAbyssScenario } from '../../../src/shared/domain.js';
import { runScenarioDataFilesExclusive } from '../../../src/main/scenario-publication/file-coordinator.js';
import {
  GuideResearchCache,
  type GuideResearchCacheFileSystem
} from '../../../src/main/services/guide-research-cache.js';
import type { ScenarioStore } from '../../../src/main/services/scenario-store.js';

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

async function putGuide(cache: GuideResearchCache, key = 'guide-task') {
  return cache.put({
    task: {
      key,
      reason: 'missing',
      scenarioTags: ['single-target']
    },
    knowledgeVersion: 'knowledge-v4',
    value: {
      trust: 'ephemeral-web',
      matches: [
        {
          id: `match-${key}`,
          subjectId: `subject-${key}`,
          summary: `匿名攻略摘要 ${key}`,
          citationIds: [`citation-${key}`]
        }
      ],
      citations: [
        {
          id: `citation-${key}`,
          sourceId: 'web-guide',
          url: `https://example.test/guides/${key}`,
          title: `Guide ${key}`,
          reviewedAt: '2026-07-25T00:00:00.000Z',
          trust: 'ephemeral-web'
        }
      ],
      applicability: {
        characterNames: [],
        scenarioTags: ['single-target'],
        buildSignals: []
      },
      conflicts: [],
      researchedAt: '2026-07-25T00:00:00.000Z'
    }
  });
}

async function clearWithRelated(
  store: ScenarioStore,
  expected: { count: number; fingerprint: string },
  relatedClear: () => Promise<RelatedClearTransaction>
): Promise<{ scenarioRemoved: number; relatedRemoved: number }> {
  return (
    store as ScenarioStore & {
      clearDownloadedCacheWithRelated(
        expected: { count: number; fingerprint: string },
        relatedClear: () => Promise<RelatedClearTransaction>
      ): Promise<{ scenarioRemoved: number; relatedRemoved: number }>;
    }
  ).clearDownloadedCacheWithRelated(expected, relatedClear);
}

interface RelatedClearTransaction {
  removed: number;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

function beginGuideClear(
  cache: GuideResearchCache,
  expected: { clearableCount: number; fingerprint: string }
): Promise<RelatedClearTransaction> {
  return (
    cache as GuideResearchCache & {
      beginClear(expected: {
        clearableCount: number;
        fingerprint: string;
      }): Promise<RelatedClearTransaction>;
    }
  ).beginClear(expected);
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

  it('includes exact managed tombstones in snapshots and clears them on retry', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const managedTombstone = path.join(
      cache,
      '.spiral-abyss.json.123e4567-e89b-42d3-a456-426614174000.clear-tombstone'
    );
    const unrelatedHiddenFile = path.join(cache, '.spiral-abyss.json.not-a-uuid.clear-tombstone');
    await fs.writeFile(managedTombstone, 'managed pending clear', 'utf8');
    await fs.writeFile(unrelatedHiddenFile, 'unrelated hidden data', 'utf8');
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache });
    await store.init();

    const snapshot = await store.getDataManagementSnapshot();
    expect(snapshot).toMatchObject({
      clearableCount: 1,
      sizeBytes: Buffer.byteLength('managed pending clear'),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    await expect(
      store.clearDownloadedCache({
        count: snapshot.clearableCount,
        fingerprint: snapshot.fingerprint
      })
    ).resolves.toBe(1);
    await expect(fs.stat(managedTombstone)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(unrelatedHiddenFile, 'utf8')).resolves.toBe('unrelated hidden data');
    await expect(store.getDataManagementSnapshot()).resolves.toMatchObject({
      clearableCount: 0,
      sizeBytes: 0
    });
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
    await expect(
      store.clearDownloadedCache({
        count: summary.clearableCount,
        fingerprint: summary.fingerprint
      })
    ).rejects.toThrow(/fully inspected/i);
    await expect(fs.readFile(older, 'utf8')).resolves.toContain('older');
    await expect(fs.readFile(newer, 'utf8')).resolves.toContain('newer');
    expect((await fs.stat(unknown)).isDirectory()).toBe(true);
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

  it('rolls staged scenario files back when the related guide fingerprint changed', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const scenarioFile = path.join(cache, 'spiral-abyss.json');
    await fs.writeFile(scenarioFile, JSON.stringify(abyssEnvelope('cached-newer')));
    const userDataDirectory = path.join(root, 'user-data');
    await fs.mkdir(userDataDirectory, { recursive: true });
    let now = Date.parse('2026-07-25T00:00:00.000Z');
    const guides = new GuideResearchCache({ userDataDirectory, now: () => now++ });
    await putGuide(guides, 'first');
    const guideSnapshot = await guides.getDataManagementSnapshot();
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache });
    await store.init();
    const scenarioSnapshot = await store.getDataManagementSnapshot();
    await putGuide(guides, 'replacement');

    await expect(
      clearWithRelated(
        store,
        {
          count: scenarioSnapshot.clearableCount,
          fingerprint: scenarioSnapshot.fingerprint
        },
        () =>
          beginGuideClear(guides, {
            clearableCount: guideSnapshot.clearableCount,
            fingerprint: guideSnapshot.fingerprint
          })
      )
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_SELECTION_CHANGED' });
    await expect(fs.readFile(scenarioFile, 'utf8')).resolves.toContain('cached-newer');
    expect(store.getScenario('spiral-abyss').meta.sourceVersion).toBe('cached-newer');
    await expect(guides.getSummary()).resolves.toMatchObject({ count: 2 });
    expect((await fs.readdir(cache)).some((name) => name.includes('clear-tombstone'))).toBe(false);
  });

  it('reports an incomplete commit and manages the guide tombstone when guide unlink fails', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const scenarioFile = path.join(cache, 'spiral-abyss.json');
    await fs.writeFile(scenarioFile, JSON.stringify(abyssEnvelope('cached-newer')));
    const userDataDirectory = path.join(root, 'user-data');
    await fs.mkdir(userDataDirectory, { recursive: true });
    const writer = new GuideResearchCache({
      userDataDirectory,
      now: () => Date.parse('2026-07-25T00:00:00.000Z')
    });
    await putGuide(writer);
    const guideSnapshot = await writer.getDataManagementSnapshot();
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: fs.readFile,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: async (target) => {
        if (target.endsWith('.clear-tombstone'))
          throw Object.assign(new Error('unlink failed'), { code: 'EACCES' });
        await fs.unlink(target);
      },
      lstat: fs.lstat,
      realpath: fs.realpath,
      readdir: fs.readdir
    };
    const failingGuides = new GuideResearchCache({
      userDataDirectory,
      fileSystem,
      now: () => Date.parse('2026-07-25T00:00:00.000Z')
    });
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache });
    await store.init();
    const scenarioSnapshot = await store.getDataManagementSnapshot();

    await expect(
      clearWithRelated(
        store,
        {
          count: scenarioSnapshot.clearableCount,
          fingerprint: scenarioSnapshot.fingerprint
        },
        () =>
          beginGuideClear(failingGuides, {
            clearableCount: guideSnapshot.clearableCount,
            fingerprint: guideSnapshot.fingerprint
          })
      )
    ).rejects.toMatchObject({ code: 'SCENARIO_CLEAR_INCOMPLETE' });
    await expect(fs.stat(scenarioFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.getScenario('spiral-abyss').meta.sourceVersion).toBe('bundled-spiral-abyss');
    await expect(fs.stat(writer.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(failingGuides.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 0,
      clearableCount: 1,
      sizeBytes: expect.any(Number)
    });
  });

  it('reports scenario tombstone cleanup failure, restores both live sides, and retries', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const scenarioFile = path.join(cache, 'spiral-abyss.json');
    await fs.writeFile(scenarioFile, JSON.stringify(abyssEnvelope('cached-newer')));
    const userDataDirectory = path.join(root, 'user-data');
    await fs.mkdir(userDataDirectory, { recursive: true });
    const guides = new GuideResearchCache({
      userDataDirectory,
      now: () => Date.parse('2026-07-25T00:00:00.000Z')
    });
    await putGuide(guides);
    let failScenarioTombstoneUnlink = true;
    const dataManagementFileSystem = {
      rename: fs.rename,
      unlink: async (target: string) => {
        if (failScenarioTombstoneUnlink && target.endsWith('.clear-tombstone')) {
          throw Object.assign(new Error('injected scenario tombstone EACCES'), { code: 'EACCES' });
        }
        await fs.unlink(target);
      },
      writeFile: fs.writeFile,
      readdir: fs.readdir
    };
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({
      bundledDir: bundled,
      cacheDir: cache,
      dataManagementFileSystem
    } as never);
    await store.init();
    const scenarioSnapshot = await store.getDataManagementSnapshot();
    const guideSnapshot = await guides.getDataManagementSnapshot();

    await expect(
      clearWithRelated(
        store,
        {
          count: scenarioSnapshot.clearableCount,
          fingerprint: scenarioSnapshot.fingerprint
        },
        () =>
          beginGuideClear(guides, {
            clearableCount: guideSnapshot.clearableCount,
            fingerprint: guideSnapshot.fingerprint
          })
      )
    ).rejects.toMatchObject({ code: 'SCENARIO_CLEAR_INCOMPLETE' });
    await expect(fs.readFile(scenarioFile, 'utf8')).resolves.toContain('cached-newer');
    await expect(fs.stat(guides.filePath)).resolves.toBeDefined();
    expect((await fs.readdir(cache)).filter((name) => name.includes('clear-tombstone'))).toEqual(
      []
    );
    await expect(store.getDataManagementSnapshot()).resolves.toMatchObject({
      clearableCount: 1
    });
    await expect(guides.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 1,
      clearableCount: 1
    });

    failScenarioTombstoneUnlink = false;
    const retryScenario = await store.getDataManagementSnapshot();
    const retryGuide = await guides.getDataManagementSnapshot();
    await expect(
      clearWithRelated(
        store,
        {
          count: retryScenario.clearableCount,
          fingerprint: retryScenario.fingerprint
        },
        () =>
          beginGuideClear(guides, {
            clearableCount: retryGuide.clearableCount,
            fingerprint: retryGuide.fingerprint
          })
      )
    ).resolves.toEqual({ scenarioRemoved: 1, relatedRemoved: 1 });
    await expect(fs.stat(scenarioFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(guides.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a failed directory preflight sentinel managed and retryable', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const scenarioFile = path.join(cache, 'spiral-abyss.json');
    await fs.writeFile(scenarioFile, JSON.stringify(abyssEnvelope('cached-newer')));
    const userDataDirectory = path.join(root, 'user-data');
    await fs.mkdir(userDataDirectory, { recursive: true });
    const guides = new GuideResearchCache({
      userDataDirectory,
      now: () => Date.parse('2026-07-25T00:00:00.000Z')
    });
    await putGuide(guides);
    let failPreflightUnlink = true;
    const dataManagementFileSystem = {
      rename: fs.rename,
      unlink: async (target: string) => {
        if (failPreflightUnlink && target.includes('clear-probe')) {
          throw Object.assign(new Error('injected directory EACCES'), { code: 'EACCES' });
        }
        await fs.unlink(target);
      },
      writeFile: fs.writeFile,
      readdir: fs.readdir
    };
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({
      bundledDir: bundled,
      cacheDir: cache,
      dataManagementFileSystem
    } as never);
    await store.init();
    const scenarioSnapshot = await store.getDataManagementSnapshot();
    const guideSnapshot = await guides.getDataManagementSnapshot();

    await expect(
      clearWithRelated(
        store,
        {
          count: scenarioSnapshot.clearableCount,
          fingerprint: scenarioSnapshot.fingerprint
        },
        () =>
          beginGuideClear(guides, {
            clearableCount: guideSnapshot.clearableCount,
            fingerprint: guideSnapshot.fingerprint
          })
      )
    ).rejects.toMatchObject({ code: 'SCENARIO_CLEAR_INCOMPLETE' });
    await expect(fs.stat(scenarioFile)).resolves.toBeDefined();
    await expect(fs.stat(guides.filePath)).resolves.toBeDefined();
    await expect(store.getDataManagementSnapshot()).resolves.toMatchObject({
      clearableCount: 2
    });
    expect((await fs.readdir(cache)).filter((name) => name.startsWith('.'))).toEqual([
      expect.stringMatching(/^\.spiral-abyss\.json\.[a-f0-9-]+\.clear-probe$/)
    ]);

    failPreflightUnlink = false;
    const retryScenario = await store.getDataManagementSnapshot();
    const retryGuide = await guides.getDataManagementSnapshot();
    await expect(
      clearWithRelated(
        store,
        {
          count: retryScenario.clearableCount,
          fingerprint: retryScenario.fingerprint
        },
        () =>
          beginGuideClear(guides, {
            clearableCount: retryGuide.clearableCount,
            fingerprint: retryGuide.fingerprint
          })
      )
    ).resolves.toEqual({ scenarioRemoved: 2, relatedRemoved: 1 });
    await expect(fs.readdir(cache)).resolves.toEqual([]);
  });

  it('keeps the guide cache when scenario staging fails and removes neither live scenario', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const firstScenario = path.join(cache, 'spiral-abyss.json');
    const secondScenario = path.join(cache, 'stygian-onslaught.json');
    await fs.writeFile(firstScenario, JSON.stringify(abyssEnvelope('cached-first')));
    await fs.writeFile(secondScenario, JSON.stringify(abyssEnvelope('cached-second')));
    const userDataDirectory = path.join(root, 'user-data');
    await fs.mkdir(userDataDirectory, { recursive: true });
    const guides = new GuideResearchCache({
      userDataDirectory,
      now: () => Date.parse('2026-07-25T00:00:00.000Z')
    });
    await putGuide(guides);
    const guideSnapshot = await guides.getDataManagementSnapshot();
    let stageRenameCount = 0;
    const dataManagementFileSystem = {
      rename: vi.fn(async (from: string, to: string) => {
        if (!from.includes('clear-tombstone')) {
          stageRenameCount += 1;
          if (stageRenameCount === 2) throw new Error('injected stage failure');
        }
        await fs.rename(from, to);
      }),
      unlink: fs.unlink,
      writeFile: fs.writeFile,
      readdir: fs.readdir
    };
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({
      bundledDir: bundled,
      cacheDir: cache,
      dataManagementFileSystem
    } as never);
    await store.init();
    const scenarioSnapshot = await store.getDataManagementSnapshot();
    const relatedClear = vi.fn(() =>
      beginGuideClear(guides, {
        clearableCount: guideSnapshot.clearableCount,
        fingerprint: guideSnapshot.fingerprint
      })
    );

    await expect(
      clearWithRelated(
        store,
        {
          count: scenarioSnapshot.clearableCount,
          fingerprint: scenarioSnapshot.fingerprint
        },
        relatedClear
      )
    ).rejects.toThrow('injected stage failure');
    expect(relatedClear).not.toHaveBeenCalled();
    await expect(fs.readFile(firstScenario, 'utf8')).resolves.toContain('cached-first');
    await expect(fs.readFile(secondScenario, 'utf8')).resolves.toContain('cached-second');
    await expect(fs.stat(guides.filePath)).resolves.toBeDefined();
  });

  it('commits a coordinated clear only after both scenario staging and guide clear succeed', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const scenarioFile = path.join(cache, 'spiral-abyss.json');
    await fs.writeFile(scenarioFile, JSON.stringify(abyssEnvelope('cached-newer')));
    const userDataDirectory = path.join(root, 'user-data');
    await fs.mkdir(userDataDirectory, { recursive: true });
    const guides = new GuideResearchCache({
      userDataDirectory,
      now: () => Date.parse('2026-07-25T00:00:00.000Z')
    });
    await putGuide(guides);
    const guideSnapshot = await guides.getDataManagementSnapshot();
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache });
    await store.init();
    const scenarioSnapshot = await store.getDataManagementSnapshot();

    await expect(
      clearWithRelated(
        store,
        {
          count: scenarioSnapshot.clearableCount,
          fingerprint: scenarioSnapshot.fingerprint
        },
        () =>
          beginGuideClear(guides, {
            clearableCount: guideSnapshot.clearableCount,
            fingerprint: guideSnapshot.fingerprint
          })
      )
    ).resolves.toEqual({ scenarioRemoved: 1, relatedRemoved: 1 });
    await expect(fs.stat(scenarioFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(guides.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.getScenario('spiral-abyss').meta.sourceVersion).toBe('bundled-spiral-abyss');
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
