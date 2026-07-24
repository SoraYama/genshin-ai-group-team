import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuideResearchTask } from '../../../src/main/services/knowledge-coverage-gate.js';
import {
  GUIDE_RESEARCH_CACHE_FILENAME,
  GUIDE_RESEARCH_CACHE_MAX_BYTES,
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

function createCacheAt(
  filePath: string,
  options: {
    fileSystem?: GuideResearchCacheFileSystem;
    now?: () => number;
    onDiagnostic?: (diagnostic: unknown) => void;
  } = {}
): GuideResearchCache {
  return new GuideResearchCache({
    userDataDirectory: path.dirname(path.dirname(filePath)),
    ...options
  } as never);
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

function withFreeTextAt(
  candidate: EphemeralGuideCacheValue,
  field:
    | 'match.summary'
    | 'citation.title'
    | 'applicability.characterNames'
    | 'applicability.scenarioTags'
    | 'applicability.buildSignals'
    | 'conflicts',
  text: string
): EphemeralGuideCacheValue {
  switch (field) {
    case 'match.summary':
      return {
        ...candidate,
        matches: [{ ...candidate.matches[0]!, summary: text }]
      };
    case 'citation.title':
      return {
        ...candidate,
        citations: [{ ...candidate.citations[0]!, title: text }]
      };
    case 'applicability.characterNames':
      return {
        ...candidate,
        applicability: { ...candidate.applicability, characterNames: [text] }
      };
    case 'applicability.scenarioTags':
      return {
        ...candidate,
        applicability: { ...candidate.applicability, scenarioTags: [text] }
      };
    case 'applicability.buildSignals':
      return {
        ...candidate,
        applicability: { ...candidate.applicability, buildSignals: [text] }
      };
    case 'conflicts':
      return { ...candidate, conflicts: [text] };
  }
}

function encodeLayers(text: string, layers: number): string {
  let encoded = Array.from(Buffer.from(text, 'utf8'), (byte) => {
    return `%${byte.toString(16).padStart(2, '0')}`;
  }).join('');
  for (let index = 1; index < layers; index += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
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
    const cache = createCacheAt(filePath, { now: () => now });
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
    const writer = createCacheAt(filePath, { now: () => now });
    await writer.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });

    now = START;
    const reader = createCacheAt(filePath, { now: () => now });
    await expect(
      reader.get({ task: task(), knowledgeVersion: 'knowledge-v4' })
    ).resolves.toBeUndefined();

    const invalid = createCacheAt(filePath, { now: () => Number.NaN });
    await expect(
      invalid.get({ task: task(), knowledgeVersion: 'knowledge-v4' })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_CLOCK_INVALID' });
    const overflowing = createCacheAt(filePath, {
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
    const cache = createCacheAt(filePath, { now: () => START });

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
    await expect(
      cache.put({
        task: task({ key: 'public-article-number-in-summary' }),
        knowledgeVersion: 'knowledge-v4',
        value: {
          ...value('7'),
          matches: [{ ...value('7').matches[0]!, summary: '公开攻略文章 123456789' }]
        }
      })
    ).resolves.toBeDefined();
  });

  it('rejects explicit private labels across every free-text field', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
    const sensitivePhrases = [
      'UID: 123456789',
      '玩家 UID=123456789',
      '玩家UID：123456789',
      'nickname: PRIVATE',
      '昵称：PRIVATE',
      '玩家名: PRIVATE',
      'PRIVATE-NICKNAME',
      'Cookie=ltoken_v2=secret',
      'ltoken_v2=secret',
      'ltuid_v2=123',
      'Authorization: Bearer secret',
      'Bearer secret',
      'API key: secret',
      'token=secret',
      'prompt: private request',
      'system prompt',
      'raw SDK message',
      'tool payload',
      'full stats',
      '完整面板'
    ];
    for (const [index, phrase] of sensitivePhrases.entries()) {
      await expect(
        cache.put({
          task: task({ key: `private-summary-${index}` }),
          knowledgeVersion: 'knowledge-v4',
          value: {
            ...value(`private-${index}`),
            matches: [{ ...value(`private-${index}`).matches[0]!, summary: phrase }]
          }
        })
      ).rejects.toThrow();
    }

    const fieldCases: Array<[string, EphemeralGuideCacheValue]> = [
      [
        'characterNames',
        {
          ...value('field-character'),
          applicability: {
            ...value('field-character').applicability,
            characterNames: ['PRIVATE-NICKNAME']
          }
        }
      ],
      [
        'scenarioTags',
        {
          ...value('field-scenario'),
          applicability: {
            ...value('field-scenario').applicability,
            scenarioTags: ['Authorization:Bearer-secret']
          }
        }
      ],
      [
        'buildSignals',
        {
          ...value('field-build'),
          applicability: {
            ...value('field-build').applicability,
            buildSignals: ['完整面板']
          }
        }
      ],
      ['conflicts', { ...value('field-conflict'), conflicts: ['Cookie=secret'] }],
      [
        'citation title',
        {
          ...value('field-title'),
          citations: [{ ...value('field-title').citations[0]!, title: 'raw SDK message: private' }]
        }
      ],
      [
        'match subject',
        {
          ...value('field-subject'),
          matches: [{ ...value('field-subject').matches[0]!, subjectId: 'PRIVATE-NICKNAME' }]
        }
      ]
    ];
    for (const [field, candidate] of fieldCases) {
      await expect(
        cache.put({
          task: task({ key: `private-field-${field}` }),
          knowledgeVersion: 'knowledge-v4',
          value: candidate
        })
      ).rejects.toThrow();
    }
  });

  it('rejects real SDK payload and full-panel shapes across every free-text field', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
    const sensitivePayloads = [
      'fullstats: HP 25000 ATK 2000',
      'HP:25000 ATK:2000 DEF:1000 CRIT RATE:70% CRIT DMG:140%',
      'SDK raw message: hidden',
      'raw message: hidden',
      'tool call payload: hidden',
      '{tool_use: search, arguments: {uid: 123}}',
      '{function_call: lookup, input: private, tool_result: hidden}',
      'credentials: secret',
      '原始消息：hidden',
      '工具载荷：hidden',
      '完整属性：生命:25000 攻击:2000 防御:1000'
    ];
    const freeTextFields = [
      'match.summary',
      'citation.title',
      'applicability.characterNames',
      'applicability.scenarioTags',
      'applicability.buildSignals',
      'conflicts'
    ] as const;

    for (const [payloadIndex, payload] of sensitivePayloads.entries()) {
      for (const [fieldIndex, field] of freeTextFields.entries()) {
        const seed = `sensitive-shape-${payloadIndex}-${fieldIndex}`;
        await expect(
          cache.put({
            task: task({ key: seed }),
            knowledgeVersion: 'knowledge-v4',
            value: withFreeTextAt(value(seed), field, payload)
          }),
          `${field} accepted ${payload}`
        ).rejects.toThrow();
      }
    }
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('canonicalizes Unicode and recursively decoded free text before privacy checks', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
    const sensitivePayloads = [
      'U\u200bID: 123456789',
      'U\ufeffID: 123456789',
      'ＵＩＤ：１２３４５６７８９',
      'Ｃｒｅｄｅｎｔｉａｌｓ：secret',
      encodeLayers('UID: 123456789', 4),
      encodeLayers('credentials: secret', 8),
      encodeLayers('ordinary public guide:', 9)
    ];

    for (const [index, payload] of sensitivePayloads.entries()) {
      await expect(
        cache.put({
          task: task({ key: `canonical-private-${index}` }),
          knowledgeVersion: 'knowledge-v4',
          value: withFreeTextAt(value(`canonical-private-${index}`), 'match.summary', payload)
        }),
        `accepted canonicalized private payload ${payload}`
      ).rejects.toThrow();
    }
  });

  it('keeps public article numbers and individual build thresholds persistable', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
    const publicSummary = value('public-shapes');
    publicSummary.matches[0]!.summary =
      '公开攻略文章 123456789：HP:25000 与生命值:25000 是同一阈值；CRIT RATE:70% 与 CRITICAL RATE:70% 也是同一阈值。';
    publicSummary.citations[0]!.url = 'https://example.test/articles/123456789';

    await expect(
      cache.put({
        task: task({ key: 'public-shapes' }),
        knowledgeVersion: 'knowledge-v4',
        value: publicSummary
      })
    ).resolves.toBeDefined();
  });

  it('rejects credential-bearing and user-identity URL components without blocking article IDs', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
    const unsafeUrls = [
      'https://user:password@example.test/guide',
      'https://example.test/uid/123456789',
      'https://example.test/%2575id/123456789',
      `https://example.test/${encodeLayers('UiD', 4)}/123456789`,
      'https://example.test/user/PRIVATE-NICKNAME',
      'https://example.test/guide?uid=123456789',
      'https://example.test/guide?%2575id=123456789',
      `https://example.test/guide?${encodeLayers('UID', 4)}=123456789`,
      'https://example.test/guide?next=Authorization%3A%20Bearer%20secret',
      `https://example.test/guide?next=${encodeLayers('credentials: secret', 4)}`,
      `https://example.test/guide?next=${encodeLayers('ordinary public guide', 10)}`,
      'https://example.test/guide#token=secret',
      'https://example.test/guide#user/PRIVATE-NICKNAME',
      `https://example.test/articles/${encodeLayers('ordinary-public-guide:', 9)}`
    ];
    for (const [index, url] of unsafeUrls.entries()) {
      await expect(
        cache.put({
          task: task({ key: `unsafe-url-${index}` }),
          knowledgeVersion: 'knowledge-v4',
          value: {
            ...value(`url-${index}`),
            citations: [{ ...value(`url-${index}`).citations[0]!, url }]
          }
        })
      ).rejects.toThrow();
    }
    await expect(
      cache.put({
        task: task({ key: 'safe-article-url' }),
        knowledgeVersion: 'knowledge-v4',
        value: {
          ...value('safe-article-url'),
          citations: [
            {
              ...value('safe-article-url').citations[0]!,
              url: 'https://example.test/articles/123456789'
            }
          ]
        }
      })
    ).resolves.toBeDefined();
  });

  it('parses and clones on put/get so callers cannot mutate cached values', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
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
    const cache = createCacheAt(filePath, { now: () => START });
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
    const corrupt = createCacheAt(filePath, {
      now: () => START,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(corrupt.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 0,
      clearableCount: 1
    });
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
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'physical cache whose read fails', 'utf8');
    const diagnostics: unknown[] = [];
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: vi.fn(async () => {
        throw new Error('Authorization: Bearer filesystem-secret');
      }),
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
      lstat: fs.lstat,
      realpath: fs.realpath,
      readdir: fs.readdir
    };
    const cache = createCacheAt(filePath, {
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
      lstat: fs.lstat,
      realpath: fs.realpath,
      readdir: fs.readdir
    };
    const cache = createCacheAt(filePath, { fileSystem, now: () => START });
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
    const initial = createCacheAt(filePath, { now: () => START });
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
      lstat: fs.lstat,
      realpath: fs.realpath,
      readdir: fs.readdir
    };
    const failing = createCacheAt(filePath, { fileSystem, now: () => START + 1 });

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

  it('keeps failed atomic-write temporary files visible and retryable when cleanup also fails', async () => {
    const filePath = await makeCachePath();
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: fs.readFile,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: vi.fn(async () => {
        throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' });
      }),
      unlink: vi.fn(async (target) => {
        if (target.endsWith('.tmp')) {
          throw Object.assign(new Error('injected temporary cleanup failure'), {
            code: 'EACCES'
          });
        }
        await fs.unlink(target);
      }),
      lstat: fs.lstat,
      realpath: fs.realpath,
      readdir: fs.readdir
    };
    const failing = createCacheAt(filePath, { fileSystem, now: () => START });

    await expect(
      failing.put({
        task: task({ key: 'orphaned-temporary' }),
        knowledgeVersion: 'knowledge-v4',
        value: value('orphaned-temporary')
      })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_WRITE_FAILED' });
    const names = await fs.readdir(path.dirname(filePath));
    expect(names).toEqual([expect.stringMatching(/^\.guide-research\.json\.[a-f0-9-]+\.tmp$/)]);

    const recovered = createCacheAt(filePath, { now: () => START + 1 });
    const snapshot = await recovered.getDataManagementSnapshot();
    expect(snapshot).toMatchObject({
      count: 0,
      clearableCount: 1,
      physicalFilePresent: true,
      sizeBytes: expect.any(Number)
    });
    await expect(
      recovered.clearAll({
        clearableCount: snapshot.clearableCount,
        fingerprint: snapshot.fingerprint
      })
    ).resolves.toBe(1);
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual([]);
  });

  it('clears only exact managed temporary artifacts and leaves unknown hidden files untouched', async () => {
    const filePath = await makeCachePath();
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const managedTemporary = path.join(
      directory,
      `.${GUIDE_RESEARCH_CACHE_FILENAME}.${randomUUID()}.tmp`
    );
    const similarUnknown = path.join(directory, `.${GUIDE_RESEARCH_CACHE_FILENAME}.not-a-uuid.tmp`);
    const unrelatedHidden = path.join(directory, '.user-owned');
    await fs.writeFile(managedTemporary, 'managed', 'utf8');
    await fs.writeFile(similarUnknown, 'unknown', 'utf8');
    await fs.writeFile(unrelatedHidden, 'user-owned', 'utf8');
    const cache = createCacheAt(filePath, { now: () => START });

    const snapshot = await cache.getDataManagementSnapshot();
    expect(snapshot).toMatchObject({
      count: 0,
      clearableCount: 1,
      physicalFilePresent: true,
      sizeBytes: Buffer.byteLength('managed')
    });
    await expect(
      cache.clearAll({
        clearableCount: snapshot.clearableCount,
        fingerprint: snapshot.fingerprint
      })
    ).resolves.toBe(1);
    expect(new Set(await fs.readdir(directory))).toEqual(
      new Set([path.basename(similarUnknown), '.user-owned'])
    );
  });

  it('stats oversized single and cumulative managed sets before reading any content', async () => {
    const filePath = await makeCachePath();
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const readFile = vi.fn(async () => {
      throw new Error('readFile must not run for an oversized managed set');
    });
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
      lstat: fs.lstat,
      realpath: fs.realpath,
      readdir: fs.readdir
    };
    const cache = createCacheAt(filePath, { fileSystem, now: () => START });

    await fs.writeFile(filePath, Buffer.alloc(GUIDE_RESEARCH_CACHE_MAX_BYTES + 1));
    await expect(cache.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 0,
      clearableCount: 1,
      sizeBytes: GUIDE_RESEARCH_CACHE_MAX_BYTES + 1
    });
    expect(readFile).not.toHaveBeenCalled();

    await fs.unlink(filePath);
    const tombstonePath = path.join(
      directory,
      `.${GUIDE_RESEARCH_CACHE_FILENAME}.${randomUUID()}.clear-tombstone`
    );
    await fs.writeFile(tombstonePath, Buffer.alloc(GUIDE_RESEARCH_CACHE_MAX_BYTES + 1));
    await expect(cache.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 0,
      clearableCount: 1,
      sizeBytes: GUIDE_RESEARCH_CACHE_MAX_BYTES + 1
    });
    expect(readFile).not.toHaveBeenCalled();

    await fs.unlink(tombstonePath);
    const cumulativePartSize = GUIDE_RESEARCH_CACHE_MAX_BYTES / 2 + 1;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        const temporaryPath = path.join(
          directory,
          `.${GUIDE_RESEARCH_CACHE_FILENAME}.${randomUUID()}.tmp`
        );
        await fs.writeFile(temporaryPath, Buffer.alloc(cumulativePartSize));
      })
    );
    await expect(cache.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 0,
      clearableCount: 2,
      sizeBytes: GUIDE_RESEARCH_CACHE_MAX_BYTES + 2
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('caps managed-file stat concurrency and performs no reads after the count limit is exceeded', async () => {
    const filePath = await makeCachePath();
    const directory = path.dirname(filePath);
    const names = Array.from(
      { length: 513 },
      (_, index) =>
        `.${GUIDE_RESEARCH_CACHE_FILENAME}.00000000-0000-4000-8000-${String(index).padStart(12, '0')}.clear-tombstone`
    );
    const managedNames = new Set(names);
    let activeStats = 0;
    let maxActiveStats = 0;
    const readFile = vi.fn(async () => {
      throw new Error('readFile must not run after the managed-file count limit');
    });
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
      lstat: async (target) => {
        if (target === directory) {
          return {
            size: 0,
            isSymbolicLink: () => false,
            isDirectory: () => true,
            isFile: () => false
          };
        }
        if (target === filePath) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        if (!managedNames.has(path.basename(target))) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        activeStats += 1;
        maxActiveStats = Math.max(maxActiveStats, activeStats);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeStats -= 1;
        return {
          size: 1,
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => true
        };
      },
      realpath: async (target) => target,
      readdir: async () => names
    };
    const cache = createCacheAt(filePath, { fileSystem, now: () => START });

    await expect(cache.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 0,
      clearableCount: 513,
      physicalFilePresent: true,
      sizeBytes: 513
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(maxActiveStats).toBeLessThanOrEqual(8);
  });

  it('bounds content-read concurrency for managed files within the limits', async () => {
    const filePath = await makeCachePath();
    const directory = path.dirname(filePath);
    const names = Array.from(
      { length: 32 },
      (_, index) =>
        `.${GUIDE_RESEARCH_CACHE_FILENAME}.10000000-0000-4000-8000-${String(index).padStart(12, '0')}.tmp`
    );
    const managedNames = new Set(names);
    let activeReads = 0;
    let maxActiveReads = 0;
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: async () => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeReads -= 1;
        return 'x';
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
      lstat: async (target) => {
        if (target === directory) {
          return {
            size: 0,
            isSymbolicLink: () => false,
            isDirectory: () => true,
            isFile: () => false
          };
        }
        if (target === filePath) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        if (!managedNames.has(path.basename(target))) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return {
          size: 1,
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => true
        };
      },
      realpath: async (target) => target,
      readdir: async () => names
    };
    const cache = createCacheAt(filePath, { fileSystem, now: () => START });

    await expect(cache.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 0,
      clearableCount: 32,
      sizeBytes: 32
    });
    expect(maxActiveReads).toBeLessThanOrEqual(8);
    expect(maxActiveReads).toBeGreaterThan(1);
  });

  it('serializes concurrent puts without losing updates', async () => {
    const filePath = await makeCachePath();
    let now = START;
    const cache = createCacheAt(filePath, { now: () => now++ });
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

  it('serializes concurrent puts across cache instances for the same canonical path', async () => {
    const filePath = await makeCachePath();
    const initial = createCacheAt(filePath, { now: () => START });
    await initial.put({
      task: task({ key: 'cross-instance-initial' }),
      knowledgeVersion: 'knowledge-v4',
      value: value('cross-instance-initial')
    });

    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: async (target, encoding) => {
        const contents = await fs.readFile(target, encoding);
        if (target === filePath) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return contents;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
      lstat: fs.lstat,
      realpath: fs.realpath,
      readdir: fs.readdir
    };
    let now = START + 1;
    const first = createCacheAt(filePath, { fileSystem, now: () => now++ });
    const second = createCacheAt(filePath, { fileSystem, now: () => now++ });

    await Promise.all([
      first.put({
        task: task({ key: 'cross-instance-first' }),
        knowledgeVersion: 'knowledge-v4',
        value: value('cross-instance-first')
      }),
      second.put({
        task: task({ key: 'cross-instance-second' }),
        knowledgeVersion: 'knowledge-v4',
        value: value('cross-instance-second')
      })
    ]);

    await expect(first.getSummary()).resolves.toMatchObject({ count: 3 });
  });

  it('blocks writes from another cache instance while a clear transaction is active', async () => {
    const filePath = await makeCachePath();
    const first = createCacheAt(filePath, { now: () => START });
    const second = createCacheAt(filePath, { now: () => START + 1 });
    await first.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    const snapshot = await first.getDataManagementSnapshot();
    const transaction = await first.beginClear({
      clearableCount: snapshot.clearableCount,
      fingerprint: snapshot.fingerprint
    });

    await expect(
      second.put({
        task: task({ key: 'blocked-during-clear' }),
        knowledgeVersion: 'knowledge-v4',
        value: value('blocked-during-clear')
      })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_WRITE_FAILED' });
    await transaction.commit();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites a new live file when a clear rollback observes an external race', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
    await cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    const snapshot = await cache.getDataManagementSnapshot();
    const transaction = await cache.beginClear({
      clearableCount: snapshot.clearableCount,
      fingerprint: snapshot.fingerprint
    });
    const externalLive = '{"external":"new-live"}';
    await fs.writeFile(filePath, externalLive, 'utf8');

    await expect(transaction.rollback()).rejects.toMatchObject({
      code: 'GUIDE_RESEARCH_CLEAR_INCOMPLETE'
    });
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(externalLive);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(
      expect.arrayContaining([
        GUIDE_RESEARCH_CACHE_FILENAME,
        expect.stringMatching(/^\.guide-research\.json\.[a-f0-9-]+\.clear-tombstone$/)
      ])
    );
  });

  it('evicts oldest entries deterministically at 100 items and removes expired entries on write', async () => {
    const filePath = await makeCachePath();
    let now = START;
    const cache = createCacheAt(filePath, { now: () => now });
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
    const cache = createCacheAt(filePath, { now: () => now });
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

  it('derives its only target from an absolute user-data authority and never accepts raw paths', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-guide-isolation-'));
    const root = tempRoot;
    const filePath = resolveGuideResearchCachePath(root);
    expect(filePath).toBe(path.join(tempRoot, 'cache', GUIDE_RESEARCH_CACHE_FILENAME));
    expect(() => resolveGuideResearchCachePath('relative-user-data')).toThrow();
    expect(
      () =>
        new GuideResearchCache({
          userDataDirectory: 'relative-user-data'
        } as never)
    ).toThrow();
    expect(
      () =>
        new GuideResearchCache({
          userDataDirectory: path.join(root, 'Resources', 'Knowledge')
        } as never)
    ).toThrow();

    const trustedResource = path.join(root, 'resources', 'knowledge', 'sentinel.json');
    await fs.mkdir(path.dirname(trustedResource), { recursive: true });
    await fs.writeFile(trustedResource, 'trusted-sentinel', 'utf8');
    expect(
      () =>
        new GuideResearchCache({
          userDataDirectory: path.dirname(trustedResource)
        } as never)
    ).toThrow();
    expect(
      () =>
        new GuideResearchCache({
          userDataDirectory: path.join(
            path.dirname(trustedResource),
            'nested',
            'resources',
            'other'
          )
        } as never)
    ).toThrow();
    expect(
      () =>
        new GuideResearchCache({
          userDataDirectory: root,
          filePath: path.join(path.dirname(trustedResource), GUIDE_RESEARCH_CACHE_FILENAME)
        } as never)
    ).toThrow();

    const cache = createCacheAt(filePath, { now: () => START });
    expect(cache.filePath).toBe(filePath);
    await cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    await expect(fs.readFile(trustedResource, 'utf8')).resolves.toBe('trusted-sentinel');
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual([
      GUIDE_RESEARCH_CACHE_FILENAME
    ]);
  });

  it('rejects a cache-directory symlink before reading, writing, or clearing its target', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-guide-symlink-'));
    const userDataDirectory = path.join(tempRoot, 'user-data');
    const trustedKnowledge = path.join(tempRoot, 'resources', 'knowledge');
    const redirectedFile = path.join(trustedKnowledge, GUIDE_RESEARCH_CACHE_FILENAME);
    await fs.mkdir(userDataDirectory, { recursive: true });
    await fs.mkdir(trustedKnowledge, { recursive: true });
    await fs.writeFile(redirectedFile, 'trusted-sentinel', 'utf8');
    await fs.symlink(trustedKnowledge, path.join(userDataDirectory, 'cache'), 'dir');
    const cache = new GuideResearchCache({ userDataDirectory, now: () => START } as never);

    await expect(cache.getSummary()).rejects.toMatchObject({
      code: 'GUIDE_RESEARCH_PATH_UNSAFE'
    });
    await expect(
      cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_PATH_UNSAFE' });
    await expect(
      cache.clearAll({ clearableCount: 0, fingerprint: 'does-not-matter' })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_PATH_UNSAFE' });
    await expect(fs.readFile(redirectedFile, 'utf8')).resolves.toBe('trusted-sentinel');
  });

  it('rejects a target-file symlink and a user-data realpath under trusted resources', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-guide-file-symlink-'));
    const userDataDirectory = path.join(tempRoot, 'user-data');
    const trustedKnowledge = path.join(tempRoot, 'resources', 'knowledge');
    const trustedFile = path.join(trustedKnowledge, 'sentinel.json');
    await fs.mkdir(path.join(userDataDirectory, 'cache'), { recursive: true });
    await fs.mkdir(trustedKnowledge, { recursive: true });
    await fs.writeFile(trustedFile, 'trusted-sentinel', 'utf8');
    await fs.symlink(trustedFile, resolveGuideResearchCachePath(userDataDirectory), 'file');
    const fileLinkCache = new GuideResearchCache({
      userDataDirectory,
      now: () => START
    } as never);
    await expect(fileLinkCache.getSummary()).rejects.toMatchObject({
      code: 'GUIDE_RESEARCH_PATH_UNSAFE'
    });

    const linkedUserData = path.join(tempRoot, 'linked-user-data');
    await fs.symlink(trustedKnowledge, linkedUserData, 'dir');
    const rootLinkCache = new GuideResearchCache({
      userDataDirectory: linkedUserData,
      now: () => START
    } as never);
    await expect(rootLinkCache.getSummary()).rejects.toMatchObject({
      code: 'GUIDE_RESEARCH_PATH_UNSAFE'
    });
    await expect(fs.readFile(trustedFile, 'utf8')).resolves.toBe('trusted-sentinel');
  });

  it('summarizes only count/bytes/timestamp and clears the isolated file with selection safety', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
    const missing = await cache.getDataManagementSnapshot();
    expect(missing).toMatchObject({
      count: 0,
      clearableCount: 0,
      sizeBytes: 0,
      physicalFilePresent: false
    });
    await expect(cache.getSummary()).resolves.toEqual({ count: 0 });
    await expect(
      cache.clearAll({
        clearableCount: missing.clearableCount,
        fingerprint: missing.fingerprint
      })
    ).resolves.toBe(0);

    await cache.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    const snapshot = await cache.getDataManagementSnapshot();

    expect(snapshot).toMatchObject({
      count: 1,
      clearableCount: 1,
      sizeBytes: expect.any(Number),
      updatedAt: '2026-07-25T00:00:00.000Z',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(JSON.stringify(snapshot)).not.toContain('https://');
    expect(JSON.stringify(snapshot)).not.toContain('攻略摘要');
    await expect(
      cache.clearAll({
        clearableCount: snapshot.clearableCount,
        fingerprint: snapshot.fingerprint
      })
    ).resolves.toBe(1);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const empty = await cache.getDataManagementSnapshot();
    expect(empty).toMatchObject({
      count: 0,
      clearableCount: 0,
      sizeBytes: 0,
      physicalFilePresent: false
    });
    await expect(
      cache.clearAll({
        clearableCount: empty.clearableCount,
        fingerprint: empty.fingerprint
      })
    ).resolves.toBe(0);
  });

  it('invalidates an old clear confirmation after a same-size normal put changes content', async () => {
    const filePath = await makeCachePath();
    let now = START;
    const cache = createCacheAt(filePath, { now: () => now });
    const original = value('same-a');
    const replacement = value('same-b');
    expect(Buffer.byteLength(JSON.stringify(replacement), 'utf8')).toBe(
      Buffer.byteLength(JSON.stringify(original), 'utf8')
    );
    await cache.put({
      task: task(),
      knowledgeVersion: 'knowledge-v4',
      value: original
    });
    const initialSize = (await fs.stat(filePath)).size;
    const oldConfirmation = await cache.getDataManagementSnapshot();

    now += 1;
    await cache.put({
      task: task(),
      knowledgeVersion: 'knowledge-v4',
      value: replacement
    });
    expect((await fs.stat(filePath)).size).toBe(initialSize);

    await expect(
      cache.clearAll({
        clearableCount: oldConfirmation.clearableCount,
        fingerprint: oldConfirmation.fingerprint
      })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_SELECTION_CHANGED' });
    await expect(cache.get({ task: task(), knowledgeVersion: 'knowledge-v4' })).resolves.toEqual(
      replacement
    );
  });

  it('distinguishes a present zero-byte file from a missing cache without public internals', async () => {
    const filePath = await makeCachePath();
    const cache = createCacheAt(filePath, { now: () => START });
    const missingSummary = await cache.getSummary();
    expect(missingSummary).toEqual({ count: 0 });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '', 'utf8');
    const physical = await cache.getDataManagementSnapshot();
    expect(physical).toMatchObject({
      count: 0,
      clearableCount: 1,
      sizeBytes: 0,
      physicalFilePresent: true,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(await cache.getSummary()).toEqual({ count: 0, sizeBytes: 0 });

    await expect(
      cache.clearAll({
        clearableCount: physical.clearableCount,
        fingerprint: physical.fingerprint
      })
    ).resolves.toBe(1);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a failed staged-clear tombstone managed and retries it', async () => {
    const filePath = await makeCachePath();
    const writer = createCacheAt(filePath, { now: () => START });
    await writer.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    let failTombstoneUnlink = true;
    const fileSystem = {
      readFile: fs.readFile,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: async (target: string) => {
        if (failTombstoneUnlink && target.endsWith('.clear-tombstone')) {
          throw Object.assign(new Error('injected tombstone EACCES'), { code: 'EACCES' });
        }
        await fs.unlink(target);
      },
      lstat: fs.lstat,
      realpath: fs.realpath,
      readdir: fs.readdir
    };
    const cache = createCacheAt(filePath, { fileSystem: fileSystem as never, now: () => START });
    const initial = await cache.getDataManagementSnapshot();
    const beginClear = (
      cache as GuideResearchCache & {
        beginClear(expected: { clearableCount: number; fingerprint: string }): Promise<{
          removed: number;
          commit(): Promise<void>;
          rollback(): Promise<void>;
        }>;
      }
    ).beginClear.bind(cache);

    const failedTransaction = await beginClear({
      clearableCount: initial.clearableCount,
      fingerprint: initial.fingerprint
    });
    await expect(failedTransaction.commit()).rejects.toMatchObject({
      code: 'GUIDE_RESEARCH_CLEAR_INCOMPLETE'
    });
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const pending = await cache.getDataManagementSnapshot();
    expect(pending).toMatchObject({
      count: 0,
      clearableCount: 1,
      sizeBytes: expect.any(Number),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(
      (await fs.readdir(path.dirname(filePath))).filter((name) => name.startsWith('.'))
    ).toEqual([expect.stringMatching(/^\.guide-research\.json\.[a-f0-9-]+\.clear-tombstone$/)]);

    failTombstoneUnlink = false;
    const retry = await beginClear({
      clearableCount: pending.clearableCount,
      fingerprint: pending.fingerprint
    });
    await expect(retry.commit()).resolves.toBeUndefined();
    await expect(cache.getDataManagementSnapshot()).resolves.toMatchObject({
      count: 0,
      clearableCount: 0
    });
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual([]);
  });

  it('restores the live guide file when staging validation fails after rename', async () => {
    const filePath = await makeCachePath();
    const writer = createCacheAt(filePath, { now: () => START });
    await writer.put({ task: task(), knowledgeVersion: 'knowledge-v4', value: value() });
    const previous = await fs.readFile(filePath, 'utf8');
    const fileSystem: GuideResearchCacheFileSystem = {
      readFile: fs.readFile,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
      lstat: fs.lstat,
      realpath: async (target) => {
        if (target.endsWith('.clear-tombstone')) {
          throw Object.assign(new Error('injected tombstone realpath failure'), { code: 'EACCES' });
        }
        return fs.realpath(target);
      },
      readdir: fs.readdir
    };
    const cache = createCacheAt(filePath, { fileSystem, now: () => START });
    const snapshot = await cache.getDataManagementSnapshot();

    await expect(
      cache.beginClear({
        clearableCount: snapshot.clearableCount,
        fingerprint: snapshot.fingerprint
      })
    ).rejects.toMatchObject({ code: 'GUIDE_RESEARCH_PATH_UNSAFE' });
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(previous);
    expect(
      (await fs.readdir(path.dirname(filePath))).filter((name) => name.startsWith('.'))
    ).toEqual([]);
  });
});
