import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuideResearchTask } from '../../../src/main/services/knowledge-coverage-gate.js';
import {
  GUIDE_RESEARCH_CACHE_FILENAME,
  GuideResearchCache,
  GuideResearchCacheError,
  computeGuideResearchCacheKey,
  resolveGuideResearchCachePath,
  type EphemeralGuideCacheValue,
  type GuideResearchCacheFileSystem
} from '../../../src/main/services/guide-research-cache.js';

const START = Date.parse('2026-07-25T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

let tempRoot: string | undefined;

beforeEach(() => {
  tempRoot = undefined;
});

afterEach(async () => {
  if (tempRoot !== undefined) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function makeCachePath(): Promise<string> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-guide-cache-'));
  return resolveGuideResearchCachePath(tempRoot);
}

function task(overrides: Partial<GuideResearchTask> = {}): GuideResearchTask {
  return {
    key: 'guide-missing-example',
    reason: 'missing',
    character: {
      name: '雷电将军',
      element: 'Electro',
      weaponType: 'polearm',
      buildSignals: ['build-match-present']
    },
    scenarioTags: ['single-target', 'elemental-shield'],
    ...overrides
  };
}

function citation(
  id = 'ephemeral-citation-1',
  suffix = ''
): EphemeralGuideCacheValue['citations'][number] {
  return {
    id,
    sourceId: 'web-guide',
    url: `https://example.test/guide/${suffix || id}`,
    title: `Guide ${id}`,
    reviewedAt: '2026-07-25T00:00:00.000Z',
    trust: 'ephemeral-web'
  };
}

function value(seed = '1'): EphemeralGuideCacheValue {
  const citationId = `ephemeral-citation-${seed}`;
  return {
    trust: 'ephemeral-web',
    matches: [
      {
        id: `ephemeral-match-${seed}`,
        subjectId: `subject-${seed}`,
        summary: `适用于当前匿名研究任务的攻略摘要 ${seed}`,
        citationIds: [citationId]
      }
    ],
    citations: [citation(citationId)],
    applicability: {
      characterNames: ['雷电将军'],
      scenarioTags: ['single-target'],
      buildSignals: ['build-match-present']
    },
    conflicts: [],
    researchedAt: '2026-07-25T00:00:00.000Z'
  };
}

function largeValue(seed: number, size = 180): EphemeralGuideCacheValue {
  const citations = Array.from({ length: size }, (_, index) => {
    const id = `citation-${seed}-${index}-${'i'.repeat(72)}`;
    return {
      ...citation(id, `${seed}/${index}/${'x'.repeat(1_700)}`),
      title: `Guide ${seed}-${index} ${'t'.repeat(180)}`
    };
  });
  return {
    trust: 'ephemeral-web',
    matches: Array.from({ length: Math.min(size, 256) }, (_, index) => ({
      id: `match-${seed}-${index}`,
      subjectId: `subject-${seed}-${index}`,
      summary: `${seed}-${index} ${'s'.repeat(900)}`,
      citationIds: citations
        .slice(index, index + 32)
        .map(({ id }) => id)
        .slice(0, 32)
    })),
    citations,
    applicability: {
      characterNames: ['匿名角色'],
      scenarioTags: ['single-target'],
      buildSignals: ['build-unknown-present']
    },
    conflicts: Array.from({ length: 32 }, (_, index) => `${index}-${'c'.repeat(450)}`),
    researchedAt: '2026-07-25T00:00:00.000Z'
  };
}

describe('GuideResearchCache', () => {
  it('derives a canonical SHA-256 key independent of object property order', () => {
    const original = task();
    const reordered = {
      scenarioTags: original.scenarioTags,
      character: {
        buildSignals: original.character?.buildSignals,
        weaponType: original.character?.weaponType,
        element: original.character?.element,
        name: original.character?.name
      },
      reason: original.reason,
      key: original.key
    };

    const key = computeGuideResearchCacheKey(original, 'knowledge-v4');
    expect(computeGuideResearchCacheKey(reordered, 'knowledge-v4')).toBe(key);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(
      createHash('sha256')
        .update(
          '{"knowledgeVersion":"knowledge-v4","task":{"character":{"buildSignals":["build-match-present"],"element":"Electro","name":"雷电将军","weaponType":"polearm"},"key":"guide-missing-example","reason":"missing","scenarioTags":["single-target","elemental-shield"]}}'
        )
        .digest('hex')
    );
    expect(
      computeGuideResearchCacheKey(
        { key: 'no-character', reason: 'missing', character: undefined, scenarioTags: [] },
        'knowledge-v4'
      )
    ).toBe(
      computeGuideResearchCacheKey(
        { key: 'no-character', reason: 'missing', scenarioTags: [] },
        'knowledge-v4'
      )
    );
  });

  it('treats exact 24-hour expiry as readable and expires at boundary plus one millisecond', async () => {
    const filePath = await makeCachePath();
    let now = START;
    const cache = new GuideResearchCache({ filePath, now: () => now });
    await cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });

    now = START + DAY_MS;
    await expect(cache.get({ task: task(), knowledgeVersion: 'knowledge-v4' })).resolves.toEqual(
      value()
    );
    now += 1;
    await expect(
      cache.get({ task: task(), knowledgeVersion: 'knowledge-v4' })
    ).resolves.toBeUndefined();
  });

  it('rejects invalid clocks and discards entries created in the future', async () => {
    const filePath = await makeCachePath();
    let now = START + 1_000;
    const writer = new GuideResearchCache({ filePath, now: () => now });
    await writer.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });

    now = START;
    const reader = new GuideResearchCache({ filePath, now: () => now });
    await expect(
      reader.get({ task: task(), knowledgeVersion: 'knowledge-v4' })
    ).resolves.toBeUndefined();

    const invalid = new GuideResearchCache({ filePath, now: () => Number.NaN });
    await expect(
      invalid.get({ task: task(), knowledgeVersion: 'knowledge-v4' })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_CLOCK_INVALID' });
    const overflowing = new GuideResearchCache({
      filePath,
      now: () => 8_640_000_000_000_000
    });
    await expect(
      overflowing.put({
        task: task({ key: 'overflowing-clock' }),
        knowledgeVersion: 'knowledge-v4',
        value: value('overflow')
      })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_CLOCK_INVALID' });
  });

  it('accepts only isolated ephemeral citations and rejects raw SDK or secret-shaped extras', async () => {
    const filePath = await makeCachePath();
    const cache = new GuideResearchCache({ filePath, now: () => START });

    await expect(
      cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() })
    ).resolves.toEqual(value());

    await expect(
      cache.put({
        task: task({ key: 'wrong-trust' }),
        knowledgeVersion: 'knowledge-v4',
        value: { ...value('2'), trust: 'trusted-local' } as never
      })
    ).rejects.toThrow();
    await expect(
      cache.put({
        task: task({ key: 'raw-message' }),
        knowledgeVersion: 'knowledge-v4',
        value: {
          ...value('3'),
          rawMessage: { Authorization: 'Bearer should-never-be-stored' }
        } as never
      })
    ).rejects.toThrow();
    await expect(
      cache.put({
        task: task({ key: 'dangling-citation' }),
        knowledgeVersion: 'knowledge-v4',
        value: {
          ...value('4'),
          matches: [{ ...value('4').matches[0]!, citationIds: ['not-present'] }]
        }
      })
    ).rejects.toThrow();
    await expect(
      cache.put({
        task: task({ key: 'public-article-number' }),
        knowledgeVersion: 'knowledge-v4',
        value: {
          ...value('5'),
          citations: [
            {
              ...value('5').citations[0]!,
              url: 'https://example.test/articles/123456789'
            }
          ]
        }
      })
    ).resolves.toBeDefined();
    await expect(
      cache.put({
        task: task({ key: 'uid-in-summary' }),
        knowledgeVersion: 'knowledge-v4',
        value: {
          ...value('6'),
          matches: [{ ...value('6').matches[0]!, summary: '玩家 UID: 123456789' }]
        }
      })
    ).rejects.toThrow();
  });

  it('parses and clones on put/get so callers cannot mutate cached values', async () => {
    const filePath = await makeCachePath();
    const cache = new GuideResearchCache({ filePath, now: () => START });
    const input = value();
    const stored = await cache.put({
      task: task(),
      knowledgeVersion: 'knowledge-v4',
      value: input
    });
    stored.matches[0]!.summary = 'mutated return value';
    input.matches[0]!.summary = 'mutated input';

    const first = await cache.get({ task: task(), knowledgeVersion: 'knowledge-v4' });
    expect(first?.matches[0]?.summary).toContain('攻略摘要');
    first!.matches[0]!.summary = 'mutated first read';
    const second = await cache.get({ task: task(), knowledgeVersion: 'knowledge-v4' });
    expect(second?.matches[0]?.summary).toContain('攻略摘要');
  });

  it('stores only the anonymous task digest, never task labels or UID-like input', async () => {
    const filePath = await makeCachePath();
    const cache = new GuideResearchCache({ filePath, now: () => START });
    const privateTask = task({
      key: 'PRIVATE-NICKNAME-123456789',
      character: {
        name: 'PRIVATE-NICKNAME',
        element: 'Electro',
        weaponType: 'polearm',
        buildSignals: []
      }
    });
    await cache.put({
      task: privateTask,
      knowledgeVersion: 'knowledge-v4',
      value: value('anonymous')
    });

    const disk = await fs.readFile(filePath, 'utf8');
    expect(disk).not.toContain('PRIVATE-NICKNAME');
    expect(disk).not.toContain('123456789');
    expect(disk).not.toContain('"task"');
    await expect(
      cache.get({ task: privateTask, knowledgeVersion: 'knowledge-v4' })
    ).resolves.toBeDefined();
  });

  it('returns an empty cache for corrupt/invalid disk data and emits only stable diagnostics', async () => {
    const filePath = await makeCachePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const diagnostics: unknown[] = [];
    await fs.writeFile(filePath, '{"Authorization":"Bearer disk-secret",', 'utf8');
    const corrupt = new GuideResearchCache({
      filePath,
      now: () => START,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(corrupt.getSummary()).resolves.toMatchObject({ count: 0 });
    expect(JSON.stringify(diagnostics)).not.toContain('disk-secret');
    expect(diagnostics).toEqual([
      { code: 'GUIDE_RESEARCH_CACHE_INVALID', file: GUIDE_RESEARCH_CACHE_FILENAME }
    ]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('disk-secret');

    diagnostics.length = 0;
    await fs.writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, entries: [], rawMessage: 'secret-body' }),
      'utf8'
    );
    await expect(corrupt.getSummary()).resolves.toMatchObject({ count: 0 });
    expect(JSON.stringify(diagnostics)).not.toContain('secret-body');
    expect(diagnostics).toEqual([
      { code: 'GUIDE_RESEARCH_CACHE_INVALID', file: GUIDE_RESEARCH_CACHE_FILENAME }
    ]);
  });

  it('does not expose secret-bearing filesystem errors through diagnostics', async () => {
    const filePath = await makeCachePath();
    const diagnostics: unknown[] = [];
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: vi.fn(async () => {
        throw new Error('Authorization: Bearer filesystem-secret');
      }),
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
      stat: fs.stat
    };
    const cache = new GuideResearchCache({
      filePath,
      fileSystem,
      now: () => START,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    await expect(cache.getSummary()).resolves.toMatchObject({ count: 0 });
    expect(diagnostics).toEqual([
      { code: 'GUIDE_RESEARCH_CACHE_UNREADABLE', file: GUIDE_RESEARCH_CACHE_FILENAME }
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('filesystem-secret');
  });

  it('writes through a same-directory temporary file and atomically renames it', async () => {
    const filePath = await makeCachePath();
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: fs.readFile,
      mkdir: fs.mkdir,
      writeFile: async (...args) => {
        writes.push(String(args[0]));
        await fs.writeFile(...args);
      },
      rename: async (from, to) => {
        renames.push([from, to]);
        await fs.rename(from, to);
      },
      unlink: fs.unlink,
      stat: fs.stat
    };
    const cache = new GuideResearchCache({ filePath, fileSystem, now: () => START });
    await cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });

    expect(writes).toHaveLength(1);
    expect(path.dirname(writes[0]!)).toBe(path.dirname(filePath));
    expect(path.basename(writes[0]!)).toMatch(/^\.guide-research\.json\.[a-f0-9-]+\.tmp$/);
    expect(renames).toEqual([[writes[0], filePath]]);
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual([
      GUIDE_RESEARCH_CACHE_FILENAME
    ]);
  });

  it('preserves the previous cache and removes the temporary file when rename fails', async () => {
    const filePath = await makeCachePath();
    const initial = new GuideResearchCache({ filePath, now: () => START });
    await initial.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    const previous = await fs.readFile(filePath, 'utf8');
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: fs.readFile,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: vi.fn(async () => {
        throw new Error('disk failure with Authorization: Bearer secret');
      }),
      unlink: fs.unlink,
      stat: fs.stat
    };
    const failing = new GuideResearchCache({ filePath, fileSystem, now: () => START + 1 });

    await expect(
      failing.put({
        task: task({ key: 'rename-failure' }),
        knowledgeVersion: 'knowledge-v4',
        value: value('failure')
      })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_WRITE_FAILED' });
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(previous);
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual([
      GUIDE_RESEARCH_CACHE_FILENAME
    ]);
  });

  it('serializes concurrent puts without losing updates', async () => {
    const filePath = await makeCachePath();
    let now = START;
    const cache = new GuideResearchCache({ filePath, now: () => now++ });
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        cache.put({
          task: task({ key: `concurrent-${index}` }),
          knowledgeVersion: 'knowledge-v4',
          value: value(String(index))
        })
      )
    );

    await expect(cache.getSummary()).resolves.toMatchObject({ count: 24 });
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        expect(
          cache.get({
            task: task({ key: `concurrent-${index}` }),
            knowledgeVersion: 'knowledge-v4'
          })
        ).resolves.toBeDefined()
      )
    );
  });

  it('evicts oldest entries deterministically at 100 items and removes expired entries on write', async () => {
    const filePath = await makeCachePath();
    let now = START;
    const cache = new GuideResearchCache({ filePath, now: () => now });
    const boundedTasks: GuideResearchTask[] = [];
    for (let index = 0; index < 101; index += 1) {
      const boundedTask = task({ key: `bounded-${String(index).padStart(3, '0')}` });
      boundedTasks.push(boundedTask);
      await cache.put({
        task: boundedTask,
        knowledgeVersion: 'knowledge-v4',
        value: value(String(index))
      });
    }

    const evictedTask = [...boundedTasks].sort((left, right) =>
      computeGuideResearchCacheKey(left, 'knowledge-v4').localeCompare(
        computeGuideResearchCacheKey(right, 'knowledge-v4')
      )
    )[0]!;
    await expect(cache.getSummary()).resolves.toMatchObject({ count: 100 });
    await expect(
      cache.get({ task: evictedTask, knowledgeVersion: 'knowledge-v4' })
    ).resolves.toBeUndefined();

    now += DAY_MS + 2;
    await cache.put({
      task: task({ key: 'after-expiry' }),
      knowledgeVersion: 'knowledge-v4',
      value: value('fresh')
    });
    await expect(cache.getSummary()).resolves.toMatchObject({ count: 1 });
  });

  it('evicts by the 2 MiB file limit and rejects an oversized single item without damaging data', async () => {
    const filePath = await makeCachePath();
    let now = START;
    const cache = new GuideResearchCache({ filePath, now: () => now });
    await cache.put({
      task: task({ key: 'small-safe-entry' }),
      knowledgeVersion: 'knowledge-v4',
      value: value('safe')
    });
    const before = await fs.readFile(filePath, 'utf8');

    await expect(
      cache.put({
        task: task({ key: 'oversized-entry' }),
        knowledgeVersion: 'knowledge-v4',
        value: largeValue(999, 512)
      })
    ).rejects.toBeInstanceOf(GuideResearchCacheError);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(before);

    for (let index = 0; index < 9; index += 1) {
      now += 1;
      await cache.put({
        task: task({ key: `large-${index}` }),
        knowledgeVersion: 'knowledge-v4',
        value: largeValue(index, 80)
      });
    }
    const summary = await cache.getSummary();
    expect(summary.sizeBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(summary.count).toBeLessThan(10);
    expect(summary.count).toBeGreaterThan(0);
  });

  it('accepts only the absolute user-data cache path and never writes trusted resources', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-guide-isolation-'));
    const root = tempRoot;
    const filePath = resolveGuideResearchCachePath(root);
    expect(filePath).toBe(path.join(tempRoot, 'cache', GUIDE_RESEARCH_CACHE_FILENAME));
    expect(() => resolveGuideResearchCachePath('relative-user-data')).toThrow();
    expect(
      () =>
        new GuideResearchCache({
          filePath: path.join(root, 'resources', 'knowledge', GUIDE_RESEARCH_CACHE_FILENAME)
        })
    ).toThrow();

    const trustedResource = path.join(root, 'resources', 'knowledge', 'sentinel.json');
    await fs.mkdir(path.dirname(trustedResource), { recursive: true });
    await fs.writeFile(trustedResource, 'trusted-sentinel', 'utf8');
    const cache = new GuideResearchCache({ filePath, now: () => START });
    await cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    await expect(fs.readFile(trustedResource, 'utf8')).resolves.toBe('trusted-sentinel');
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual([
      GUIDE_RESEARCH_CACHE_FILENAME
    ]);
  });

  it('summarizes only count/bytes/timestamp and clears the isolated file with selection safety', async () => {
    const filePath = await makeCachePath();
    const cache = new GuideResearchCache({ filePath, now: () => START });
    const missing = await cache.getDataManagementSnapshot();
    expect(missing).toMatchObject({ count: 0, sizeBytes: 0 });
    await expect(
      cache.clearAll({ count: missing.count, fingerprint: missing.fingerprint })
    ).resolves.toBe(0);

    await cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    const snapshot = await cache.getDataManagementSnapshot();

    expect(snapshot).toMatchObject({
      count: 1,
      sizeBytes: expect.any(Number),
      updatedAt: '2026-07-25T00:00:00.000Z',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(JSON.stringify(snapshot)).not.toContain('https://');
    expect(JSON.stringify(snapshot)).not.toContain('攻略摘要');
    await expect(
      cache.clearAll({ count: snapshot.count, fingerprint: snapshot.fingerprint })
    ).resolves.toBe(1);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const empty = await cache.getDataManagementSnapshot();
    expect(empty).toMatchObject({ count: 0, sizeBytes: 0 });
    await expect(
      cache.clearAll({ count: empty.count, fingerprint: empty.fingerprint })
    ).resolves.toBe(0);
  });
});
