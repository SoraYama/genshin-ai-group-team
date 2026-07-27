import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  GuideResearchAgent,
  GuideResearchAgentError,
  buildGuideResearchQueries
} from '../../../src/main/services/guide-research-agent.js';
import type {
  EphemeralGuideCacheValue,
  GuideResearchCache as GuideResearchCacheType
} from '../../../src/main/services/guide-research-cache.js';
import { GuideResearchCache } from '../../../src/main/services/guide-research-cache.js';
import type { GuideResearchTask } from '../../../src/main/services/knowledge-coverage-gate.js';
import type { AuditedAgentRunner } from '../../../src/main/services/agent-turn-audit.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import { GUIDE_RESEARCH_PROMPT_V1 } from '../../../src/main/agents/research/prompt.js';

const NOW = Date.parse('2026-07-25T02:00:00.000Z');
const CANONICAL_CHARACTER_CATALOG = [
  { name: '雷电将军', element: 'electro' },
  { name: '纳西妲', element: 'dendro' }
] as const;

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

interface SdkWebSearchTurnOptions {
  status?: 'resolved' | 'error' | 'unresolved';
  toolName?: string;
  searchCount?: number;
  query?: string;
  resultUrlsBySearch?: ReadonlyArray<readonly string[]>;
  toolUseResultBySearch?: readonly unknown[];
  additionalToolNames?: readonly string[];
  prependedCollidingToolName?: string;
  toolResultBeforeSearch?: boolean;
  extraToolResultStatuses?: ReadonlyArray<'success' | 'error'>;
  invalidFirstResult?: boolean;
}

function successRunner(
  output: string,
  onRun?: (prompt: string, options: AgentSdkRunOptions) => void,
  turnOptions: SdkWebSearchTurnOptions = {}
): AuditedAgentRunner {
  return {
    async *run(prompt, options) {
      onRun?.(prompt, options);
      for (const message of sdkWebSearchTurn(prompt, output, turnOptions)) yield message;
    }
  };
}

function sdkWebSearchTurn(
  prompt: string,
  output: string,
  options: SdkWebSearchTurnOptions = {}
): unknown[] {
  const payload = JSON.parse(prompt) as { searchQueries?: string[] };
  const queries = payload.searchQueries ?? [];
  const toolName = options.toolName ?? 'WebSearch';
  const searchCount = options.searchCount ?? 1;
  const messages: unknown[] = [];
  const firstQuery = options.query ?? queries[0] ?? '原神 配队 攻略';
  if (options.toolResultBeforeSearch === true) {
    messages.push(sdkSearchToolResultMessage('search-1', firstQuery, 'success'));
  }
  if (options.prependedCollidingToolName !== undefined) {
    messages.push({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'search-1',
            name: options.prependedCollidingToolName,
            input: { path: '/not-allowed' }
          }
        ]
      }
    });
    messages.push({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'search-1',
            is_error: true,
            content: 'denied by research policy'
          }
        ]
      }
    });
  }
  for (let index = 0; index < searchCount; index += 1) {
    const id = `search-${index + 1}`;
    messages.push({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id,
            name: toolName,
            input: {
              query:
                options.query ?? queries[index % Math.max(queries.length, 1)] ?? '原神 配队 攻略'
            }
          }
        ]
      }
    });
    if (options.status !== 'unresolved') {
      const executedQuery =
        options.query ?? queries[index % Math.max(queries.length, 1)] ?? '原神 配队 攻略';
      const resultUrls = options.resultUrlsBySearch?.[index] ?? [
        'https://keqingmains.com/q/raiden-quickguide/'
      ];
      messages.push({
        type: 'user',
        tool_use_result:
          options.toolUseResultBySearch?.[index] ??
          (options.status === 'error'
            ? undefined
            : options.invalidFirstResult === true
              ? {
                  query: executedQuery,
                  results: ['commentary without URL'],
                  durationSeconds: 0.2,
                  searchCount: 1
                }
              : {
                  query: executedQuery,
                  results: [
                    {
                      tool_use_id: id,
                      content: resultUrls.map((url, urlIndex) => ({
                        title: `Search result ${urlIndex + 1}`,
                        url
                      }))
                    }
                  ],
                  durationSeconds: 0.2,
                  searchCount: 1
                }),
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              is_error: options.status === 'error',
              content: options.status === 'error' ? 'search failed' : 'search resolved'
            }
          ]
        }
      });
    }
  }
  options.extraToolResultStatuses?.forEach((status) => {
    messages.push(sdkSearchToolResultMessage('search-1', firstQuery, status));
  });
  options.additionalToolNames?.forEach((name, index) => {
    const id = `mixed-tool-${index + 1}`;
    messages.push({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id, name, input: { path: '/not-allowed' } }]
      }
    });
    messages.push({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            is_error: true,
            content: 'denied by research policy'
          }
        ]
      }
    });
  });
  messages.push({ type: 'result', subtype: 'success', result: output, usage: {} });
  return messages;
}

function sdkSearchToolResultMessage(
  id: string,
  query: string,
  status: 'success' | 'error'
): unknown {
  return {
    type: 'user',
    ...(status === 'success'
      ? {
          tool_use_result: {
            query,
            results: [
              {
                tool_use_id: id,
                content: [
                  {
                    title: 'Duplicate search result',
                    url: 'https://keqingmains.com/q/raiden-quickguide/'
                  }
                ]
              }
            ],
            durationSeconds: 0.2,
            searchCount: 1
          }
        }
      : {}),
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: status === 'error',
          content: status === 'error' ? 'search failed' : 'search resolved'
        }
      ]
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
        { id: 'kqm-guides', host: 'keqingmains.com', trust: 'trusted-local' as const },
        { id: 'kqm-library', host: 'library.keqingmains.com', trust: 'trusted-local' as const }
      ]
    })
  };
}

function encodeLayers(value: string, count: number): string {
  let encoded = value;
  for (let index = 0; index < count; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}

function cache(
  overrides: {
    get?: (
      input: Parameters<GuideResearchCacheType['get']>[0]
    ) => Promise<EphemeralGuideCacheValue | undefined>;
    put?: (
      input: Parameters<GuideResearchCacheType['put']>[0]
    ) => Promise<EphemeralGuideCacheValue>;
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
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('逐字复制');
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('不得改写');
    expect(GUIDE_RESEARCH_PROMPT_V1).toContain('每条最多调用一次');
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
      },
      {
        resultUrlsBySearch: [['https://keqingmains.com/q/nahida-quickguide/']]
      }
    );
    const agent = new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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
    expect(result).toMatchObject({
      searchExecuted: true,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      audit: {
        finalRawText: expect.stringContaining('"schemaVersion":1'),
        rawMessagesSummary: { totalMessages: 3 },
        tools: [{ name: 'WebSearch', succeeded: true }],
        webSearchEvidence: {
          attempts: [
            expect.objectContaining({
              toolUseId: 'search-1',
              status: 'resolved'
            })
          ]
        }
      }
    });
  });

  it('uses a direct audited Zhipu search fallback without invoking native WebSearch', async () => {
    const runner: AuditedAgentRunner = { run: vi.fn() as never };
    const researchCache = cache();
    const directSearch = {
      search: vi.fn(async () => [
        {
          title: '雷电将军配队攻略',
          snippet: '雷电将军可围绕爆发窗口与队友形成稳定循环。',
          url: 'https://www.hoyolab.com/article/12345678',
          publishedAt: '2026-07-20'
        }
      ])
    };
    const agent = new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: {
        getSourceRegistry: () => ({
          sources: [
            { id: 'hoyolab-www', host: 'www.hoyolab.com', trust: 'trusted-local' as const }
          ]
        })
      },
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      directSearch,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [task('guide-direct-search')],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(runner.run).not.toHaveBeenCalled();
    expect(directSearch.search).toHaveBeenCalledOnce();
    expect(directSearch.search).toHaveBeenCalledWith(
      '原神 雷电将军 配队 攻略',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result).toMatchObject({
      entries: [
        {
          taskKey: 'guide-direct-search',
          origin: 'research',
          value: {
            trust: 'ephemeral-web',
            applicability: {
              characterNames: ['雷电将军'],
              scenarioTags: ['single-target'],
              buildSignals: ['build-match-present']
            },
            citations: [
              {
                sourceId: 'hoyolab-www',
                url: 'https://www.hoyolab.com/article/12345678',
                trust: 'ephemeral-web'
              }
            ]
          }
        }
      ],
      gaps: [],
      searchExecuted: true,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      directSearchAudit: {
        provider: 'zhipu-web-search',
        attempts: [
          {
            status: 'resolved',
            urls: ['https://www.hoyolab.com/article/12345678']
          }
        ]
      }
    });
    expect(researchCache.put).toHaveBeenCalledOnce();
  });

  it('accepts only the explicit search-only source allowlist for direct Zhipu results', async () => {
    const runner: AuditedAgentRunner = { run: vi.fn() as never };
    const researchCache = cache();
    const directSearch = {
      search: vi.fn(async () => [
        {
          title: '原神雷电将军配队攻略',
          snippet: '雷电将军的队友、武器与圣遗物选择需要按循环需求调整。',
          url: 'https://ol.3dmgame.com/gl/262965.html',
          publishedAt: '2025-09-08'
        },
        {
          title: '原神雷电将军阵容推荐',
          snippet: '雷电将军热门阵容。',
          url: 'https://www.9game.cn/yuanshen/9869348.html',
          publishedAt: '2024-03-02'
        }
      ])
    };
    const agent = new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      directSearch,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [task('guide-direct-search-only-source')],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries[0]).toMatchObject({
      origin: 'research',
      value: {
        trust: 'ephemeral-web',
        citations: [
          {
            sourceId: 'search-only-3dm-genshin',
            url: 'https://ol.3dmgame.com/gl/262965.html',
            trust: 'ephemeral-web'
          }
        ]
      }
    });
    expect(result.directSearchAudit?.attempts[0]?.urls).toEqual([
      'https://ol.3dmgame.com/gl/262965.html'
    ]);
  });

  it('does not invoke the model when every task has a valid cache hit', async () => {
    const runner: AuditedAgentRunner = { run: vi.fn() as never };
    const researchCache = cache({ get: async () => cachedValue() });
    const agent = new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [task('guide-hit-only')],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.origin).toBe('cache');
    expect(result).toMatchObject({
      searchExecuted: false,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    });
    expect(result.audit).toBeUndefined();
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
          for (const message of sdkWebSearchTurn(prompt, modelOutput(projected.taskRef))) {
            yield message;
          }
        }
      };
      const agent = new GuideResearchAgent({
        runner,
        cache: cache(),
        sourceRegistry: sourceRegistry(),
        sdkOptions: sdkOptions(),
        canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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
    ['zero WebSearch calls', { searchCount: 0 }],
    ['only another tool', { toolName: 'Read' }],
    ['an errored WebSearch', { status: 'error' as const }],
    ['an unresolved WebSearch', { status: 'unresolved' as const }]
  ])('does not cache provider JSON backed by %s', async (_label, turnOptions) => {
    const researchTask = task('guide-search-evidence-missing');
    const researchCache = cache();
    const runner: AuditedAgentRunner = {
      async *run(prompt) {
        for (const message of sdkWebSearchTurn(prompt, modelOutput('ref-1'), turnOptions)) {
          yield message;
        }
      }
    };
    const agent = new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]);
    expect(result).toMatchObject({
      searchExecuted: true,
      audit: {
        finalRawText: expect.stringContaining('"schemaVersion":1'),
        rawMessagesSummary: expect.any(Object),
        webSearchEvidence: expect.any(Object)
      }
    });
  });

  it('keeps an empty trusted search result as a normal unresolved knowledge gap', async () => {
    const researchTask = task('guide-search-no-trusted-result');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner('{"schemaVersion":1,"results":[]}', undefined, {
        resultUrlsBySearch: [[]]
      }),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.gaps).toEqual([
      { taskKey: researchTask.key, code: 'SEARCH_NO_VALID_RESULTS' }
    ]);
    expect(result.audit?.webSearchEvidence.attempts[0]).toMatchObject({
      status: 'resolved',
      urls: []
    });
  });

  it('keeps an empty model result non-fatal when successful allowlisted searches use an unknown provider result shape', async () => {
    const researchTask = task('guide-search-provider-shape-empty');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner('{"schemaVersion":1,"results":[]}', undefined, {
        toolUseResultBySearch: [{ providerSpecificEmptyResult: true }]
      }),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.gaps).toEqual([
      { taskKey: researchTask.key, code: 'SEARCH_NO_VALID_RESULTS' }
    ]);
    expect(result.audit?.tools).toEqual([
      expect.objectContaining({ name: 'WebSearch', succeeded: true })
    ]);
    expect(result.audit?.webSearchEvidence.attempts[0]).toMatchObject({
      status: 'invalid',
      urls: []
    });
  });

  it('fails closed when the collected tool audit is truncated', async () => {
    const researchTask = task('guide-truncated-tool-audit');
    const researchCache = cache();
    const runner: AuditedAgentRunner = {
      async *run(prompt) {
        const messages = sdkWebSearchTurn(prompt, modelOutput('ref-1'));
        yield messages[0];
        yield messages[1];
        yield {
          type: 'assistant',
          message: {
            content: Array.from({ length: 64 }, (_, index) => ({
              type: 'tool_use',
              id: `overflow-${index}`,
              name: 'WebSearch',
              input: { query: '原神 配队 攻略' }
            }))
          }
        };
        yield messages[2];
      }
    };
    const agent = new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.gaps).toEqual([
      { taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }
    ]);
    expect(result.audit).toMatchObject({
      toolsTruncated: true,
      tools: { length: 64 }
    });
  });

  it.each([1, 2, 3])(
    'accepts provider JSON backed by %i resolved WebSearch calls',
    async (count) => {
      const researchTask = task(`guide-search-evidence-${count}`);
      const agent = new GuideResearchAgent({
        runner: {
          async *run(prompt) {
            for (const message of sdkWebSearchTurn(prompt, modelOutput('ref-1'), {
              searchCount: count
            })) {
              yield message;
            }
          }
        },
        cache: cache(),
        sourceRegistry: sourceRegistry(),
        sdkOptions: sdkOptions(),
        canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
        now: () => NOW
      });

      const result = await agent.research({
        tasks: [researchTask],
        knowledgeVersion: 'knowledge-v2'
      });

      expect(result.entries).toHaveLength(1);
    }
  );

  it.each([
    ['tool result before tool use', { toolResultBeforeSearch: true }],
    ['duplicate success', { extraToolResultStatuses: ['success'] as const }],
    [
      'error then success',
      { status: 'error' as const, extraToolResultStatuses: ['success'] as const }
    ],
    ['success then error', { extraToolResultStatuses: ['error'] as const }],
    [
      'invalid then success',
      { invalidFirstResult: true, extraToolResultStatuses: ['success'] as const }
    ]
  ])('does not cache provider JSON after %s', async (_label, turnOptions) => {
    const researchTask = task(`guide-duplicate-result-${_label.replaceAll(' ', '-')}`);
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1'), undefined, turnOptions),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      entries: [],
      gaps: [{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]
    });
  });

  it.each(['Read', 'Bash', 'mcp__other__lookup'])(
    'rejects resolved WebSearch evidence mixed with denied %s tool use',
    async (additionalToolName) => {
      const researchTask = task(`guide-mixed-tool-${additionalToolName}`);
      const researchCache = cache();
      const agent = new GuideResearchAgent({
        runner: successRunner(modelOutput('ref-1'), undefined, {
          additionalToolNames: [additionalToolName]
        }),
        cache: researchCache,
        sourceRegistry: sourceRegistry(),
        sdkOptions: sdkOptions(),
        canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
        now: () => NOW
      });

      const result = await agent.research({
        tasks: [researchTask],
        knowledgeVersion: 'knowledge-v2'
      });

      expect(researchCache.put).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        entries: [],
        gaps: [{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]
      });
    }
  );

  it('rejects a denied mixed tool even when a later WebSearch reuses its tool-use ID', async () => {
    const researchTask = task('guide-mixed-colliding-id');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1'), undefined, {
        prependedCollidingToolName: 'Read'
      }),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]);
  });

  it.each([
    ['more than three resolved searches', { searchCount: 4 }],
    ['a query outside the generated allowlist', { query: '原神 私自替换的查询' }]
  ])('rejects provider JSON backed by %s', async (_label, turnOptions) => {
    const researchTask = task('guide-search-evidence-invalid');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: {
        async *run(prompt) {
          for (const message of sdkWebSearchTurn(prompt, modelOutput('ref-1'), turnOptions)) {
            yield message;
          }
        }
      },
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      entries: [],
      gaps: [{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]
    });
  });

  it.each([
    [
      'non-enum research reason',
      task('guide-invalid-reason', {
        reason: 'private-context' as never
      })
    ],
    [
      'non-enum weapon type',
      task('guide-invalid-weapon', {
        character: {
          name: '雷电将军',
          element: 'electro',
          weaponType: 'custom-weapon' as never,
          buildSignals: ['build-match-present']
        }
      })
    ],
    [
      'non-taxonomy scenario tag',
      task('guide-invalid-scenario', {
        scenarioTags: ['player-private-scenario']
      })
    ],
    [
      'non-allowlist build signal',
      task('guide-invalid-build-signal', {
        character: {
          name: '雷电将军',
          element: 'electro',
          weaponType: 'polearm',
          buildSignals: ['custom-build-signal']
        }
      })
    ],
    [
      'canonical name paired with the wrong element',
      task('guide-wrong-element', {
        character: {
          name: '雷电将军',
          element: 'pyro',
          weaponType: 'polearm',
          buildSignals: ['build-match-present']
        }
      })
    ],
    [
      'nickname in element',
      task('guide-element-nickname', {
        character: {
          name: '雷电将军',
          element: '私人昵称',
          weaponType: 'polearm',
          buildSignals: ['build-match-present']
        }
      })
    ],
    [
      'zero-width nickname in element',
      task('guide-element-zero-width-nickname', {
        character: {
          name: '雷电将军',
          element: '私人昵\u200b称',
          weaponType: 'polearm',
          buildSignals: ['build-match-present']
        }
      })
    ],
    [
      'Unicode decimal-number sentinel in element',
      task('guide-element-unicode-digits', {
        character: {
          name: '雷电将军',
          element: '١٢٣٤٥٦٧٨٩',
          weaponType: 'polearm',
          buildSignals: ['build-match-present']
        }
      })
    ],
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
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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

  it('accepts a canonical name and exact catalog element pairing', async () => {
    let observedPrompt = '';
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1'), (prompt) => {
        observedPrompt = prompt;
      }),
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [task('guide-canonical-pair')],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toHaveLength(1);
    expect(observedPrompt).toContain('"name":"雷电将军","element":"electro"');
  });

  it('allows unknown element only when the trusted catalog has the exact unknown pairing', async () => {
    const unknownTask = task('guide-canonical-unknown', {
      character: {
        name: '元素待确认角色',
        element: 'unknown',
        buildSignals: ['build-match-present']
      }
    });
    const agent = new GuideResearchAgent({
      runner: successRunner(
        modelOutput('ref-1', {
          applicability: {
            characterNames: ['元素待确认角色'],
            scenarioTags: ['single-target'],
            buildSignals: ['build-match-present']
          }
        })
      ),
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: [{ name: '元素待确认角色', element: 'unknown' }],
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [unknownTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toHaveLength(1);
  });

  it('takes an immutable identity snapshot at construction', async () => {
    const mutableCatalog: Array<{
      name: string;
      element: 'electro' | 'pyro';
    }> = [{ name: '雷电将军', element: 'electro' }];
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1')),
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: mutableCatalog,
      now: () => NOW
    });
    mutableCatalog[0]!.element = 'pyro';

    const result = await agent.research({
      tasks: [task('guide-catalog-snapshot')],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toHaveLength(1);
  });

  it('deduplicates identical name-element pairs from the committed catalog', async () => {
    const travelerTask = task('guide-duplicate-traveler', {
      character: {
        name: '旅行者',
        element: 'anemo',
        weaponType: 'sword',
        buildSignals: ['build-match-present']
      }
    });
    const agent = new GuideResearchAgent({
      runner: successRunner(
        modelOutput('ref-1', {
          applicability: {
            characterNames: ['旅行者'],
            scenarioTags: ['single-target'],
            buildSignals: ['build-match-present']
          }
        })
      ),
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: [
        { name: '旅行者', element: 'anemo' },
        { name: '旅行者', element: 'anemo' }
      ],
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [travelerTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toHaveLength(1);
  });

  it('fails closed when one canonical name maps to conflicting elements', () => {
    expect(
      () =>
        new GuideResearchAgent({
          runner: successRunner(modelOutput('never-used')),
          cache: cache(),
          sourceRegistry: sourceRegistry(),
          sdkOptions: sdkOptions(),
          canonicalCharacterCatalog: [
            { name: '旅行者', element: 'anemo' },
            { name: '旅行者', element: 'geo' }
          ],
          now: () => NOW
        })
    ).toThrowError(
      expect.objectContaining({
        code: 'RESEARCH_TASK_INVALID'
      })
    );
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
        }),
        undefined,
        accepted ? { resultUrlsBySearch: [[url]] } : undefined
      ),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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

  it('rejects a fabricated citation on the same trusted host when it was not in search results', async () => {
    const researchTask = task('guide-fabricated-same-host');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(
        modelOutput('ref-1', {
          source: {
            url: 'https://keqingmains.com/q/fabricated-guide/',
            title: 'Fabricated Guide',
            timelineClue: '模型声称存在'
          }
        })
      ),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_NO_VALID_RESULTS' }]);
  });

  it('accepts a citation returned by the second of multiple resolved searches', async () => {
    const firstTask = task('guide-multi-search-first');
    const secondTask = task('guide-multi-search-second');
    const secondUrl = 'https://keqingmains.com/q/raiden-second-result/';
    const agent = new GuideResearchAgent({
      runner: {
        async *run(prompt) {
          for (const message of sdkWebSearchTurn(
            prompt,
            modelOutput('ref-1', {
              source: {
                url: secondUrl,
                title: 'Second Search Guide',
                timelineClue: '第二条查询返回'
              }
            }),
            {
              searchCount: 2,
              resultUrlsBySearch: [
                ['https://keqingmains.com/q/unrelated-first-result/'],
                [secondUrl, secondUrl]
              ]
            }
          )) {
            yield message;
          }
        }
      },
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [firstTask, secondTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ taskKey: firstTask.key, origin: 'research' })
    ]);
    expect(result.entries[0]?.value.citations[0]?.url).toBe(secondUrl);
  });

  it('allows trusted sources to share a host and selects a deterministic source ID', async () => {
    const researchTask = task('guide-shared-source-host');
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1')),
      cache: cache(),
      sourceRegistry: {
        getSourceRegistry: () => ({
          sources: [
            { id: 'z-source', host: 'keqingmains.com', trust: 'trusted-local' as const },
            { id: 'a-source', host: 'keqingmains.com', trust: 'trusted-local' as const }
          ]
        })
      },
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries[0]?.value.citations[0]?.sourceId).toBe('a-source');
  });

  it.each([
    ['missing trusted-local marker', [{ id: 'kqm-guides', host: 'keqingmains.com' }]],
    ['non-local trust', [{ id: 'kqm-guides', host: 'keqingmains.com', trust: 'ephemeral-web' }]],
    [
      'duplicate source ID',
      [
        { id: 'duplicate', host: 'keqingmains.com', trust: 'trusted-local' },
        { id: 'duplicate', host: 'library.keqingmains.com', trust: 'trusted-local' }
      ]
    ]
  ])('rejects a source projection with %s', async (_label, sources) => {
    const run = vi.fn(() => {
      throw new Error('runner must not be reached');
    });
    const agent = new GuideResearchAgent({
      runner: { run },
      cache: cache(),
      sourceRegistry: {
        getSourceRegistry: () => ({ sources })
      } as never,
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    await expect(
      agent.research({
        tasks: [task('guide-invalid-source-projection')],
        knowledgeVersion: 'knowledge-v2'
      })
    ).rejects.toMatchObject({
      code: 'RESEARCH_TASK_INVALID'
    });
    expect(run).not.toHaveBeenCalled();
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
        canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]);
  });

  it.each([
    ['ordinary build prose', '班尼特提供攻击力加成，生命值提升取决于治疗角色。'],
    ['ordinary eight-digit number', '公开攻略编号 12345678'],
    ['one numeric stat', '攻击力: 2000'],
    ['two distinct numeric stats', '攻击力: 2000，暴击率: 70%']
  ])('accepts privacy-safe provider %s', async (_label, summary) => {
    const researchTask = task(`guide-public-provider-${_label.replaceAll(' ', '-')}`);
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1', { summary })),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.gaps).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(researchCache.put).toHaveBeenCalledOnce();
  });

  it.each([
    ['summary', { summary: '这份攻略适用于 123456789' }],
    ['encoded summary', { summary: encodeLayers('这份攻略适用于 123456789', 4) }],
    [
      'source title',
      {
        source: {
          url: 'https://keqingmains.com/q/raiden-quickguide/',
          title: 'Guide post for ١٢٣٤\u200b٥٦٧٨٩',
          timelineClue: '页面时间线索存在'
        }
      }
    ],
    [
      'source timeline',
      {
        source: {
          url: 'https://keqingmains.com/q/raiden-quickguide/',
          title: 'Boundary Guide',
          timelineClue: '攻略更新于编号 １２３４５６７８９'
        }
      }
    ],
    ['long number in conflicts', { conflicts: ['post build 123456789'] }],
    [
      'full panel in conflicts',
      { conflicts: ['攻击力: 2000，生命值: 25000，暴击率: 70% 时有冲突'] }
    ],
    [
      'source URL path',
      {
        source: {
          url: 'https://keqingmains.com/q/123456789/',
          title: 'Boundary Guide',
          timelineClue: '页面时间线索存在'
        }
      }
    ],
    [
      'source URL query',
      {
        source: {
          url: 'https://keqingmains.com/q/raiden/?ref=%31%32%33%34%35%36%37%38%39',
          title: 'Boundary Guide',
          timelineClue: '页面时间线索存在'
        }
      }
    ],
    [
      'source URL fragment',
      {
        source: {
          url: 'https://keqingmains.com/q/raiden/#١٢٣٤\u200b٥٦٧٨٩',
          title: 'Boundary Guide',
          timelineClue: '页面时间线索存在'
        }
      }
    ]
  ])('rejects privacy-sensitive provider-controlled %s', async (_label, overrides) => {
    const researchTask = task('guide-sensitive-provider-output');
    const researchCache = cache();
    const agent = new GuideResearchAgent({
      runner: successRunner(modelOutput('ref-1', overrides)),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/123456789|١٢٣٤|private-token|critRate|%31%32%33/iu);
  });

  it('validates but retains the semantics of a privacy-safe encoded guide URL', async () => {
    const researchTask = task('guide-safe-encoded-url');
    const encodedUrl = 'https://keqingmains.com/q/raiden/?topic=%E9%9B%B7%E7%A5%9E#guide';
    const agent = new GuideResearchAgent({
      runner: successRunner(
        modelOutput('ref-1', {
          source: {
            url: encodedUrl,
            title: 'Raiden Guide',
            timelineClue: '页面时间线索存在'
          }
        }),
        undefined,
        { resultUrlsBySearch: [[encodedUrl]] }
      ),
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries[0]?.value.citations[0]?.url).toBe(encodedUrl);
  });

  it('allows a long article ID only as an exact article URL path segment', async () => {
    const researchTask = task('guide-safe-article-id-url');
    const articleUrl = 'https://keqingmains.com/articles/123456789';
    const agent = new GuideResearchAgent({
      runner: successRunner(
        modelOutput('ref-1', {
          source: {
            url: articleUrl,
            title: 'Raiden Guide',
            timelineClue: '页面时间线索存在'
          }
        }),
        undefined,
        { resultUrlsBySearch: [[articleUrl]] }
      ),
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.entries[0]?.value.citations[0]?.url).toBe(articleUrl);
  });

  it.each([
    ['guide prose', '这份攻略适用于 123456789'],
    ['Unicode decimal digits', '这份攻略适用于 １２３４５６７８９'],
    ['encoded guide prose', encodeLayers('这份攻略适用于 123456789', 4)]
  ])('does not write rejected provider %s through the real guide cache', async (label, summary) => {
    const userDataDirectory = await fs.mkdtemp(path.join(tmpdir(), 'guide-research-agent-'));
    try {
      const researchTask = task(`guide-real-cache-${label.replaceAll(' ', '-')}`);
      const researchCache = new GuideResearchCache({
        userDataDirectory,
        now: () => NOW
      });
      const agent = new GuideResearchAgent({
        runner: successRunner(modelOutput('ref-1', { summary })),
        cache: researchCache,
        sourceRegistry: sourceRegistry(),
        sdkOptions: sdkOptions(),
        canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
        now: () => NOW
      });

      const result = await agent.research({
        tasks: [researchTask],
        knowledgeVersion: 'knowledge-v2'
      });

      expect(result.entries).toEqual([]);
      await expect(
        researchCache.get({ task: researchTask, knowledgeVersion: 'knowledge-v2' })
      ).resolves.toBeUndefined();
      await expect(fs.readFile(researchCache.filePath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      await fs.rm(userDataDirectory, { recursive: true, force: true });
    }
  });

  it('does not write duplicate WebSearch results through the real guide cache', async () => {
    const userDataDirectory = await fs.mkdtemp(path.join(tmpdir(), 'guide-research-duplicate-'));
    try {
      const researchTask = task('guide-real-cache-duplicate-result');
      const researchCache = new GuideResearchCache({
        userDataDirectory,
        now: () => NOW
      });
      const agent = new GuideResearchAgent({
        runner: successRunner(modelOutput('ref-1'), undefined, {
          extraToolResultStatuses: ['success']
        }),
        cache: researchCache,
        sourceRegistry: sourceRegistry(),
        sdkOptions: sdkOptions(),
        canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
        now: () => NOW
      });

      const result = await agent.research({
        tasks: [researchTask],
        knowledgeVersion: 'knowledge-v2'
      });

      expect(result).toMatchObject({
        entries: [],
        gaps: [{ taskKey: researchTask.key, code: 'SEARCH_OUTPUT_INVALID' }]
      });
      await expect(
        researchCache.get({ task: researchTask, knowledgeVersion: 'knowledge-v2' })
      ).resolves.toBeUndefined();
      await expect(fs.readFile(researchCache.filePath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      await fs.rm(userDataDirectory, { recursive: true, force: true });
    }
  });

  it('writes an SDK-shaped search result to the real cache only when citation URL is evidenced', async () => {
    const userDataDirectory = await fs.mkdtemp(path.join(tmpdir(), 'guide-research-evidence-'));
    try {
      const researchTask = task('guide-real-cache-evidenced-output');
      const researchCache = new GuideResearchCache({
        userDataDirectory,
        now: () => NOW
      });
      const agent = new GuideResearchAgent({
        runner: successRunner(modelOutput('ref-1')),
        cache: researchCache,
        sourceRegistry: sourceRegistry(),
        sdkOptions: sdkOptions(),
        canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
        now: () => NOW
      });

      const result = await agent.research({
        tasks: [researchTask],
        knowledgeVersion: 'knowledge-v2'
      });

      expect(result.entries).toHaveLength(1);
      await expect(
        researchCache.get({ task: researchTask, knowledgeVersion: 'knowledge-v2' })
      ).resolves.toMatchObject({
        citations: [
          expect.objectContaining({
            url: 'https://keqingmains.com/q/raiden-quickguide/'
          })
        ]
      });
    } finally {
      await fs.rm(userDataDirectory, { recursive: true, force: true });
    }
  });

  it('keeps successful cache writes when a later task write fails with a stable gap', async () => {
    const firstTask = task('guide-cache-write-first');
    const secondTask = task('guide-cache-write-second');
    const output = JSON.stringify({
      schemaVersion: 1,
      results: [
        JSON.parse(modelOutput('ref-1')).results[0],
        JSON.parse(modelOutput('ref-2')).results[0]
      ]
    });
    let putAttempt = 0;
    const researchCache = cache({
      put: async ({ value }) => {
        putAttempt += 1;
        if (putAttempt === 2) throw new Error('disk-provider-secret-detail');
        return value;
      }
    });
    const agent = new GuideResearchAgent({
      runner: successRunner(output),
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [firstTask, secondTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(researchCache.put).toHaveBeenCalledTimes(2);
    expect(result.entries).toEqual([
      expect.objectContaining({ taskKey: firstTask.key, origin: 'research' })
    ]);
    expect(result.gaps).toEqual([{ taskKey: secondTask.key, code: 'SEARCH_CACHE_UNAVAILABLE' }]);
    expect(JSON.stringify(result)).not.toContain('disk-provider-secret-detail');
  });

  it.each([
    ['uid', '123456789'],
    ['nickname', '私人昵称'],
    ['cookie', 'ltoken_v2=secret'],
    ['authorization', 'Bearer secret'],
    ['apiKey', 'sk-secret'],
    ['panelStats', { critRate: 88.8 }],
    ['taskRef', 'caller-controlled-ref']
  ])('rejects an input that attempts to bypass anonymity through %s', async (field, value) => {
    const runner = successRunner(modelOutput('never-used'));
    const agent = new GuideResearchAgent({
      runner,
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    });

    const result = await agent.research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result.gaps).toEqual([{ taskKey: researchTask.key, code }]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps only stable provider diagnostics and safe HTTP status', async () => {
    const researchTask = task('guide-provider-safe-diagnostic');
    const runner: AuditedAgentRunner = {
      async *run() {
        const cause = Object.assign(new Error('TOP-SECRET-PROVIDER-BODY'), {
          status: 503,
          response: { body: 'TOP-SECRET-PROVIDER-BODY', request: 'private-query' }
        });
        yield await Promise.reject(cause);
      }
    };
    const result = await new GuideResearchAgent({
      runner,
      cache: cache(),
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    }).research({
      tasks: [researchTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result).toMatchObject({
      searchExecuted: true,
      failure: {
        sdkCode: 'AGENT_TURN_STREAM_FAILED',
        httpStatus: 503
      },
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    });
    expect(JSON.stringify(result)).not.toMatch(/TOP-SECRET|private-query|provider-body/i);
  });

  it('keeps cache entries and a privacy-safe partial WebSearch audit on provider failure', async () => {
    const hitTask = task('guide-partial-hit');
    const missTask = task('guide-partial-miss', {
      character: {
        name: '纳西妲',
        element: 'dendro',
        weaponType: 'catalyst',
        buildSignals: ['build-conflict-present']
      }
    });
    const hit = cachedValue('partial-hit');
    const researchCache = cache({
      get: async ({ task: candidate }) =>
        candidate.key === hitTask.key ? hit : undefined
    });
    const runner: AuditedAgentRunner = {
      async *run(prompt) {
        const payload = JSON.parse(prompt) as { searchQueries: string[] };
        const query = payload.searchQueries[0]!;
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'search-partial',
                name: 'WebSearch',
                input: { query }
              }
            ]
          }
        };
        yield sdkSearchToolResultMessage('search-partial', query, 'success');
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '{"partial":"safe"}' }] }
        };
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          result: 'TOP-SECRET-PROVIDER-BODY',
          errors: ['TOP-SECRET-PROVIDER-BODY'],
          status: 503,
          usage: { input_tokens: 5, output_tokens: 3 },
          total_cost_usd: 0.01
        };
      }
    };
    const result = await new GuideResearchAgent({
      runner,
      cache: researchCache,
      sourceRegistry: sourceRegistry(),
      sdkOptions: sdkOptions(),
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
      now: () => NOW
    }).research({
      tasks: [hitTask, missTask],
      knowledgeVersion: 'knowledge-v2'
    });

    expect(result).toMatchObject({
      entries: [
        expect.objectContaining({ taskKey: hitTask.key, origin: 'cache', value: hit })
      ],
      gaps: [{ taskKey: missTask.key, code: 'SEARCH_UNAVAILABLE' }],
      searchExecuted: true,
      failure: {
        sdkCode: 'AGENT_TURN_RESULT_ERROR',
        httpStatus: 503
      },
      usage: { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.01 },
      audit: {
        finalRawText: '{"partial":"safe"}',
        rawMessagesSummary: { totalMessages: 4 },
        tools: [
          expect.objectContaining({
            id: 'search-partial',
            name: 'WebSearch',
            succeeded: true
          })
        ],
        webSearchEvidence: {
          attempts: [
            expect.objectContaining({
              toolUseId: 'search-partial',
              status: 'resolved'
            })
          ],
          truncated: false
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain('TOP-SECRET-PROVIDER-BODY');
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
      canonicalCharacterCatalog: CANONICAL_CHARACTER_CATALOG,
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
