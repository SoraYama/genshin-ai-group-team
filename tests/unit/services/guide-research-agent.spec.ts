import { describe, expect, it, vi } from 'vitest';

import {
  GuideResearchAgent,
  GuideResearchAgentError,
  buildGuideResearchQueries
} from '../../../src/main/services/guide-research-agent.js';
import type {
  EphemeralGuideCacheValue,
  GuideResearchCache
} from '../../../src/main/services/guide-research-cache.js';
import type { GuideResearchTask } from '../../../src/main/services/knowledge-coverage-gate.js';
import type { AuditedAgentRunner } from '../../../src/main/services/agent-turn-audit.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import { GUIDE_RESEARCH_PROMPT_V1 } from '../../../src/main/agents/research/prompt.js';

const NOW = Date.parse('2026-07-25T02:00:00.000Z');
const CANONICAL_CHARACTER_NAMES = new Set(['雷电将军', '纳西妲']);

function task(key: string, overrides: Partial<GuideResearchTask> = {}): GuideResearchTask {
  return {
    key,
    reason: 'missing',
    character: {
      name: '雷电将军',
      element: 'electro',
      weaponType: 'polearm',
      buildSignals: ['build-match-present']
    },
    scenarioTags: ['single-target'],
    ...overrides
  };
}

function cachedValue(seed = 'cached'): EphemeralGuideCacheValue {
  return {
    trust: 'ephemeral-web',
    matches: [
      {
        id: `match-${seed}`,
        subjectId: `subject-${seed}`,
        summary: '缓存中的已校验攻略摘要',
        citationIds: [`citation-${seed}`]
      }
    ],
    citations: [
      {
        id: `citation-${seed}`,
        sourceId: 'kqm-guides',
        url: 'https://keqingmains.com/q/raiden-quickguide/',
        title: 'Raiden Shogun Quick Guide',
        reviewedAt: '2026-07-25T01:00:00.000Z',
        trust: 'ephemeral-web'
      }
    ],
    applicability: {
      characterNames: ['雷电将军'],
      scenarioTags: ['single-target'],
      buildSignals: ['build-match-present']
    },
    conflicts: [],
    researchedAt: '2026-07-25T01:00:00.000Z'
  };
}

function modelOutput(taskRef: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    results: [
      {
        taskRef,
        summary: '该配置在单体环境中可围绕爆发窗口安排队友。',
        applicability: {
          characterNames: ['雷电将军'],
          scenarioTags: ['single-target'],
          buildSignals: ['build-match-present']
        },
        source: {
          url: 'https://keqingmains.com/q/raiden-quickguide/',
          title: 'Raiden Shogun Quick Guide',
          timelineClue: '页面标注为当前快速指南，检索于 2026-07-25'
        },
        conflicts: [],
        ...overrides
      }
    ]
  });
}

function successRunner(
  output: string,
  onRun?: (prompt: string, options: AgentSdkRunOptions) => void
): AuditedAgentRunner {
  return {
    async *run(prompt, options) {
      onRun?.(prompt, options);
      yield { type: 'result', subtype: 'success', result: output, usage: {} };
    }
  };
}

function sdkOptions(): AgentSdkRunOptions {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://provider.example.test',
    model: 'test-model',
    systemPrompt: 'replaced-by-research-agent',
    cwd: '/tmp/genshin-guide-research',
    abortController: new AbortController()
  };
}

function sourceRegistry() {
  return {
    getSourceRegistry: () => ({
      sources: [
        { id: 'kqm-guides', host: 'keqingmains.com' },
        { id: 'kqm-library', host: 'library.keqingmains.com' }
      ]
    })
  };
}

function cache(
  overrides: {
    get?: (
      input: Parameters<GuideResearchCache['get']>[0]
    ) => Promise<EphemeralGuideCacheValue | undefined>;
    put?: (input: Parameters<GuideResearchCache['put']>[0]) => Promise<EphemeralGuideCacheValue>;
  } = {}
) {
  return {
    get: vi.fn(overrides.get ?? (async () => undefined)),
    put: vi.fn(overrides.put ?? (async ({ value }) => value))
  };
}

describe('GuideResearchAgent', () => {
  it('pins a versioned strict-JSON research-only system prompt', () => {
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('只使用 WebSearch');
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('不得请求玩家数据');
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('适用范围');
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('时间线索');
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('冲突');
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('严格 JSON');
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('"taskRef"');
    expect(GUIDE_RESEARCH_PROMPT_V1).not.toContain('"taskKey"');
    expect(GUIDE_RESEARCH_PROMPT_V1).not.toContain('WebFetch');
  });

  it('uses cache hits and researches only misses under the isolated WebSearch policy', async () => {
    const hitTask = task('guide-hit');
    const missTask = task('guide-miss', {
      character: {
        name: '纳西妲',
        element: 'dendro',
        weaponType: 'catalyst',
        buildSignals: ['build-conflict-present']
      }
    });
    const hit = cachedValue();
    const researchCache = cache({
      get: async ({ task: candidate }) => (candidate.key === hitTask.key ? hit : undefined)
    });
    let observedPrompt = '';
    let observedOptions: AgentSdkRunOptions | undefined;
    const runner = successRunner(
      modelOutput('ref-1', {
        summary: '纳西妲在该队伍中负责持续草元素附着。',
        applicability: {
          characterNames: ['纳西妲'],
          scenarioTags: ['single-target'],
          buildSignals: ['build-conflict-present']
        },
        source: {
          url: 'https://keqingmains.com/q/nahida-quickguide/',
          title: 'Nahida Quick Guide',
          timelineClue: '页面为当前快速指南，检索于 2026-07-25'
        }
      }),
      (prompt, options) => {
        observedPrompt = prompt;
        observedOptions = options;
      }
    );
    const agent = new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [hitTask, missTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ taskKey: hitTask.key, origin: 'cache', value: hit }),
      expect.objectContaining({
        taskKey: missTask.key,
        origin: 'research',
        value: expect.objectContaining({ trust: 'ephemeral-web' })
      })
    ]);
    expect(result.gaps).toEqual([]);
    expect(observedPrompt).not.toContain(hitTask.key);
    expect(observedPrompt).not.toContain(missTask.key);
    expect(observedPrompt).toContain('"taskRef":"ref-1"');
    expect(observedOptions?.nativeToolPolicy).toEqual({
      purpose: 'research',
      allowed: ['WebSearch'],
      maxSearches: 3
    });
    expect(observedOptions?.allowedBusinessTools).toEqual([]);
    expect(observedOptions?.mcpServers).toBeUndefined();
    expect(observedOptions?.maxTurns).toBe(4);
    expect(researchCache.put).toHaveBeenCalledOnce();
    expect(researchCache.put).toHaveBeenCalledWith(
      expect.objectContaining({
        task: missTask,
        knowledgeVersion: 'knowledge-v2',
        value: expect.objectContaining({
          trust: 'ephemeral-web',
          citations: [
            expect.objectContaining({
              url: 'https://keqingmains.com/q/nahida-quickguide/',
              trust: 'ephemeral-web'
            })
          ]
        })
      })
    );
    expect(JSON.stringify(researchCache.put.mock.calls)).not.toContain('rawMessagesSummary');
  });

  it('does not invoke the model when every task has a valid cache hit', async () => {
    const runner: AuditedAgentRunner = { run: vi.fn() as never };
    const researchCache = cache({ get: async () => cachedValue() });
    const agent = new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [task('guide-hit-only')],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.origin).toBe('cache');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each(['123456789', 'U\u200bID%253A123456789'])(
    'replaces caller task key %s with an internal taskRef before building the prompt',
    async (callerKey) => {
      const privateKeyTask = task(callerKey);
      let observedPrompt = '';
      const runner: AuditedAgentRunner = {
        async *run(prompt) {
          observedPrompt = prompt;
          const payload = JSON.parse(prompt) as {
            tasks: Array<{ taskRef: string; key?: string }>;
          };
          const projected = payload.tasks[0]!;
          expect(projected.key).toBeUndefined();
          yield {
            type: 'result',
            subtype: 'success',
            result: modelOutput(projected.taskRef),
            usage: {}
          };
        }
      };
      const agent = new GuideResearchAgent({
        runner,
        cache: cache(),
        sourceRegistry: sourceRegistry(),
        sdkOptions: sdkOptions(),
        canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
        now: () => NOW
      });

      const result = await agent.research({
        tasks: [privateKeyTask],
        knowledgeVersion: 'knowledge-v2'
      });

      expect(observedPrompt).not.toContain(callerKey);
      expect(observedPrompt).not.toContain('123456789');
      expect(result.entries).toEqual([
        expect.objectContaining({ taskKey: callerKey, origin: 'research' })
      ]);
    }
  );

  it.each([
    [
      'encoded UID',
      task('guide-encoded-value', {
        character: {
          name: '雷电将军',
          element: 'U%49D:123456789',
          weaponType: 'polearm',
          buildSignals: ['build-match-present']
        }
      })
    ],
    [
      'UID digits adjacent to letters',
      task('guide-adjacent-uid', {
        character: {
          name: '雷电将军',
          element: 'x123456789x',
          weaponType: 'polearm',
          buildSignals: ['build-match-present']
        }
      })
    ],
    [
      'caller nickname sentinel',
      task('guide-nickname', {
        character: {
          name: '玩家自定义称呼',
          element: 'electro',
          weaponType: 'polearm',
          buildSignals: ['build-match-present']
        }
      })
    ]
  ])('rejects %s before the research runner sees it', async (_label, unsafeTask) => {
    const run = vi.fn();
    const agent = new GuideResearchAgent({
      runner: { run: run as never },
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    await expect(
      agent.research({
        tasks: [unsafeTask],
        knowledgeVersion: 'knowledge-v2'
      })
    ).rejects.toMatchObject({ code: 'RESEARCH_TASK_INVALID' });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['https://KEQINGMAINS.COM/q/raiden', true, 'https://keqingmains.com/q/raiden'],
    ['https://keqingmains.com:443/q/raiden', false, undefined],
    ['https://keqingmains.com./q/raiden', false, undefined],
    ['https://keqingmains.com.attacker.test/q/raiden', false, undefined],
    ['http://keqingmains.com/q/raiden', false, undefined],
    ['https://user@keqingmains.com/q/raiden', false, undefined],
    ['https://keqingmains.com:444/q/raiden', false, undefined],
    ['https://kеqingmains.com/q/raiden', false, undefined],
    ['https://ｋｅｑｉｎｇｍａｉｎｓ.com/q/raiden', false, undefined],
    ['https://𝐤𝐞𝐪𝐢𝐧𝐠𝐦𝐚𝐢𝐧𝐬.com/q/raiden', false, undefined],
    ['https://[::1]@keqingmains.com/q/raiden', false, undefined]
  ])('validates and canonicalizes source URL %s', async (url, accepted, canonicalUrl) => {
    const researchTask = task('guide-url-check');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(
        modelOutput('ref-1', {
          source: {
            url,
            title: 'Boundary Guide',
            timelineClue: '页面时间线索存在'
          }
        })
      ),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted) {
      expect(result.gaps).toEqual([]);
      expect(result.entries[0]?.value.citations[0]?.url).toBe(canonicalUrl);
    } else {
      expect(result.entries).toEqual([]);
      expect(result.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_NO_VALID_RESULTS' }]);
    }
  });

  it.each(['applicability', 'source.timelineClue', 'conflicts'])(
    'rejects research output missing %s',
    async (missingField) => {
      const researchTask = task('guide-missing-field');
      const candidate = JSON.parse(modelOutput('ref-1')) as {
        results: Array<Record<string, unknown>>;
      };
      const result = candidate.results[0]!;
      if (missingField === 'source.timelineClue') {
        delete (result['source'] as Record<string, unknown>)['timelineClue'];
      } else {
        delete result[missingField];
      }
      const researchCache = cache();
      const agent = new GuideResearchAgent({
        runner: successRunner(JSON.stringify(candidate)),
        cache: researchCache,
        sourceRegistry: sourceRegistry(),
        sdkOptions: sdkOptions(),
        canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
        now: () => NOW
      });

      const response = await agent.research({
        tasks: [researchTask],
        knowledgeVersion: 'knowledge-v2'
      });

      expect(researchCache.put).not.toHaveBeenCalled();
      expect(response.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]);
    }
  );

  it.each([
    [
      'extra character identity',
      {
        characterNames: ['雷电将军', '纳西妲'],
        scenarioTags: ['single-target'],
        buildSignals: ['build-match-present']
      }
    ],
    [
      'extra scenario tag',
      {
        characterNames: ['雷电将军'],
        scenarioTags: ['single-target', 'boss'],
        buildSignals: ['build-match-present']
      }
    ],
    [
      'missing build signal',
      {
        characterNames: ['雷电将军'],
        scenarioTags: ['single-target'],
        buildSignals: []
      }
    ]
  ])('rejects applicability with %s', async (_label, applicability) => {
    const researchTask = task('guide-applicability-mismatch');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1', { applicability })),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_NO_VALID_RESULTS' }]);
  });

  it('does not cache results whose taskRefs swap otherwise identical build applicability', async () => {
    const matchTask = task('guide-build-match');
    const conflictTask = task('guide-build-conflict', {
      character: {
        name: '雷电将军',
        element: 'electro',
        weaponType: 'polearm',
        buildSignals: ['build-conflict-present']
      }
    });
    const swappedOutput = JSON.stringify({
      schemaVersion: 1,
      results: [
        JSON.parse(
          modelOutput('ref-1', {
            applicability: {
              characterNames: ['雷电将军'],
              scenarioTags: ['single-target'],
              buildSignals: ['build-conflict-present']
            }
          })
        ).results[0],
        JSON.parse(
          modelOutput('ref-2', {
            applicability: {
              characterNames: ['雷电将军'],
              scenarioTags: ['single-target'],
              buildSignals: ['build-match-present']
            }
          })
        ).results[0]
      ]
    });
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(swappedOutput),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [matchTask, conflictTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.gaps).toEqual([
      { taskKey: matchTask.key, code: 'SEARCH_NO_VALID_RESULTS' },
      { taskKey: conflictTask.key, code: 'SEARCH_NO_VALID_RESULTS' }
    ]);
  });

  it.each([
    [
      'duplicate ref',
      JSON.stringify({
        schemaVersion: 1,
        results: [
          JSON.parse(modelOutput('ref-1')).results[0],
          JSON.parse(modelOutput('ref-1')).results[0]
        ]
      })
    ],
    ['unknown ref', modelOutput('ref-999')]
  ])('rejects a structurally valid output with %s', async (_label, output) => {
    const researchTask = task('guide-invalid-ref');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(output),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]);
  });

  it('drops a result that tries to place account material into the ephemeral cache', async () => {
    const researchTask = task('guide-sensitive-result');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(
        modelOutput('ref-1', {
          summary: '适用 UID 123456789 的私人面板结论'
        })
      ),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_NO_VALID_RESULTS' }]);
  });

  it.each([
    ['uid', '123456789'],
    ['nickname', '私人昵称'],
    ['cookie', 'ltoken_v2=secret'],
    ['authorization', 'Bearer secret'],
    ['apiKey', 'sk-secret'],
    ['panelStats', { critRate: 88.8 }]
  ])('rejects an input that attempts to bypass anonymity through %s', async (field, value) => {
    const runner = successRunner(modelOutput('never-used'));
    const agent = new GuideResearchAgent({
      runner,
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });
    const privateTask = { ...task('guide-private'), [field]: value };

    const promise = agent.research({
      tasks: [privateTask as GuideResearchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    await expect(promise).rejects.toBeInstanceOf(GuideResearchAgentError);
    await expect(promise).rejects.toMatchObject({ code: 'RESEARCH_TASK_INVALID' });
  });

  it('builds no more than three bounded anonymous search queries', () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      task(`guide-${index}`, {
        character: {
          name: index % 2 === 0 ? '雷电将军' : '纳西妲',
          element: index % 2 === 0 ? 'electro' : 'dendro',
          buildSignals: ['build-match-present']
        },
        scenarioTags: ['single-target', 'elemental-shield']
      })
    );

    const queries = buildGuideResearchQueries(tasks);

    expect(queries).toHaveLength(3);
    expect(queries.every((query) => query.length <= 300)).toBe(true);
    expect(queries.join(' ')).not.toMatch(
      /123456789|昵称|cookie|authorization|api[-_ ]?key|crit(?:ical)?[-_ ]?(?:rate|dmg)/iu
    );
  });

  it.each([
    ['WebSearch is not supported by this provider; token=secret', 'SEARCH_UNAVAILABLE'],
    ['SEARCH_BUDGET_EXCEEDED provider detail secret', 'SEARCH_BUDGET_EXCEEDED']
  ] as const)('maps %s to stable gap code %s without leaking details', async (error, code) => {
    const researchTask = task('guide-provider-error');
    const runner: AuditedAgentRunner = {
      async *run() {
        yield await Promise.reject(new Error(error));
      }
    };
    const agent = new GuideResearchAgent({
      runner,
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code }]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('uses only the registry read method and never reaches a trusted-knowledge writer', async () => {
    const researchTask = task('guide-read-only');
    const trustedWrite = vi.fn();
    const registry = {
      ...sourceRegistry(),
      writeTrustedBundle: trustedWrite
    };
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1')),
      cache: cache(),
      sourceRegistry: registry,
      sdkOptions: sdkOptions(),
      canonicalCharacterNames: CANONICAL_CHARACTER_NAMES,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toHaveLength(1);
    expect(trustedWrite).not.toHaveBeenCalled();
  });
});
