import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_TURN_FINAL_TEXT_MAX_CHARS,
  AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES,
  AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS,
  AGENT_TURN_TOOL_AUDIT_MAX,
  AGENT_TURN_WEB_SEARCH_EVIDENCE_MAX_ATTEMPTS,
  AgentTurnError,
  auditCorrelationId,
  auditToolInputKey,
  runAuditedAgentTurn,
  type AuditedAgentRunner
} from '../../../src/main/services/agent-turn-audit.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';

describe('runAuditedAgentTurn', () => {
  it('derives a stable opaque audit identity for real UI correlation values', () => {
    const correlation = 'abyss-1784952000000-1';
    const identity = auditCorrelationId(correlation);

    expect(identity).toMatch(/^audit-correlation-[a-f0-9]{32}$/);
    expect(identity).toBe(auditCorrelationId(correlation));
    expect(identity).not.toContain(correlation);
    expect(identity).not.toBe(auditCorrelationId('abyss-1784952000000-2'));
  });

  it('derives distinct canonical identities for sensitive and unsafe tool-input keys', () => {
    const sensitiveKeys = ['uid', 'authorization', 'token', '123456789'];
    const identities = sensitiveKeys.map((key) => auditToolInputKey(key));

    expect(identities.every((identity) => /^audit-key-[a-f0-9]{32}$/.test(identity))).toBe(
      true
    );
    expect(new Set(identities).size).toBe(sensitiveKeys.length);
    expect(auditToolInputKey('%75id')).toBe(auditToolInputKey('uid'));
    expect(auditToolInputKey('floor')).toBe('floor');
    expect(
      auditToolInputKey('field-%733nsitivev4lue', ['s3nsitivev4lue'])
    ).toBe(auditToolInputKey('field-s3nsitivev4lue', ['s3nsitivev4lue']));
  });

  it('derives bounded privacy-safe WebSearch evidence from SDK-shaped tool messages', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'search-1',
                name: 'WebSearch',
                input: { query: '原神 雷电将军 配队 攻略' }
              }
            ]
          }
        };
        yield {
          type: 'user',
          tool_use_result: {
            query: '原神 雷电将军 配队 攻略',
            results: [
              {
                tool_use_id: 'search-1',
                content: [
                  {
                    title: 'provider-secret-title-must-not-be-retained',
                    url: 'https://keqingmains.com/q/raiden-quickguide/'
                  }
                ]
              }
            ],
            durationSeconds: 0.5,
            searchCount: 1
          },
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'search-1',
                is_error: false,
                content: 'provider-secret-result-must-not-be-retained'
              }
            ]
          }
        };
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };

    const result = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test',
      normalizeResearchUrl: trustedResearchUrl
    });

    expect(result.webSearchEvidence).toEqual({
      attempts: [
        {
          toolUseId: 'search-1',
          query: '原神 雷电将军 配队 攻略',
          status: 'resolved',
          urls: ['https://keqingmains.com/q/raiden-quickguide/']
        }
      ],
      truncated: false
    });
    expect(JSON.stringify(result.webSearchEvidence)).not.toContain('provider-secret');
  });

  it('deduplicates normalized URLs from the typed WebSearch output without retaining titles', async () => {
    const runner = sdkWebSearchRunner({
      query: '原神 雷电将军 配队 攻略',
      results: [
        {
          tool_use_id: 'search-shaped',
          content: [
            { title: 'secret-title-one', url: 'https://KEQINGMAINS.COM/q/raiden' },
            { title: 'secret-title-two', url: 'https://keqingmains.com/q/raiden' }
          ]
        }
      ],
      durationSeconds: 0.2,
      searchCount: 1
    });

    const result = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test',
      normalizeResearchUrl: trustedResearchUrl
    });

    expect(result.webSearchEvidence.attempts[0]).toEqual({
      toolUseId: 'search-shaped',
      query: '原神 雷电将军 配队 攻略',
      status: 'resolved',
      urls: ['https://keqingmains.com/q/raiden']
    });
    expect(JSON.stringify(result.webSearchEvidence)).not.toContain('secret-title');
  });

  it.each([
    [
      'no result URL',
      {
        query: '原神 雷电将军 配队 攻略',
        results: ['search commentary only'],
        durationSeconds: 0.2,
        searchCount: 1
      }
    ],
    [
      'a mismatched nested tool-use ID',
      {
        query: '原神 雷电将军 配队 攻略',
        results: [
          {
            tool_use_id: 'different-search',
            content: [{ title: 'Guide', url: 'https://keqingmains.com/q/raiden' }]
          }
        ],
        durationSeconds: 0.2,
        searchCount: 1
      }
    ],
    [
      'a mismatched query',
      {
        query: '原神 纳西妲 配队 攻略',
        results: [
          {
            tool_use_id: 'search-shaped',
            content: [{ title: 'Guide', url: 'https://keqingmains.com/q/raiden' }]
          }
        ],
        durationSeconds: 0.2,
        searchCount: 1
      }
    ],
    [
      'an untrusted result URL',
      {
        query: '原神 雷电将军 配队 攻略',
        results: [
          {
            tool_use_id: 'search-shaped',
            content: [{ title: 'Guide', url: 'https://attacker.example/q/raiden' }]
          }
        ],
        durationSeconds: 0.2,
        searchCount: 1
      }
    ],
    [
      'an oversized result list',
      {
        query: '原神 雷电将军 配队 攻略',
        results: Array.from({ length: 33 }, () => 'bounded commentary'),
        durationSeconds: 0.2,
        searchCount: 1
      }
    ],
    [
      'more than 32 result URLs across bounded result groups',
      {
        query: '原神 雷电将军 配队 攻略',
        results: [0, 1].map((group) => ({
          tool_use_id: 'search-shaped',
          content: Array.from({ length: 17 }, (_, index) => ({
            title: `Guide ${group}-${index}`,
            url: `https://keqingmains.com/q/raiden-${group}-${index}`
          }))
        })),
        durationSeconds: 0.2,
        searchCount: 1
      }
    ]
  ])('fails closed for typed WebSearch output with %s', async (_label, toolUseResult) => {
    const result = await runAuditedAgentTurn({
      runner: sdkWebSearchRunner(toolUseResult),
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test',
      normalizeResearchUrl: trustedResearchUrl
    });

    expect(result.webSearchEvidence.attempts[0]).toMatchObject({
      toolUseId: 'search-shaped',
      status: 'invalid',
      urls: []
    });
  });

  it.each([
    ['error', true, true, 'error'],
    ['unresolved', false, false, 'unresolved']
  ])(
    'records a WebSearch %s without treating it as resolved',
    async (_label, includeResult, isError, expectedStatus) => {
      const runner: AuditedAgentRunner = {
        async *run() {
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'search-state',
                  name: 'WebSearch',
                  input: { query: '原神 纳西妲 配队 攻略' }
                }
              ]
            }
          };
          if (includeResult) {
            yield {
              type: 'user',
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'search-state',
                    is_error: isError,
                    content: 'not retained'
                  }
                ]
              }
            };
          }
          yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
        }
      };

      const result = await runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: sdkOptions(),
        systemPrompt: 'test'
      });

      expect(result.webSearchEvidence.attempts).toEqual([
        expect.objectContaining({ toolUseId: 'search-state', status: expectedStatus })
      ]);
    }
  );

  it.each([
    ['tool result before tool use', ['success', 'tool'] as const],
    ['duplicate success', ['tool', 'success', 'success'] as const],
    ['error then success', ['tool', 'error', 'success'] as const],
    ['success then error', ['tool', 'success', 'error'] as const],
    ['invalid then success', ['tool', 'invalid', 'success'] as const]
  ])('permanently invalidates WebSearch evidence after %s', async (_label, sequence) => {
    const runner: AuditedAgentRunner = {
      async *run() {
        for (const item of sequence) yield webSearchSequenceMessage(item);
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };

    const result = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test',
      normalizeResearchUrl: trustedResearchUrl
    });

    expect(result.webSearchEvidence.attempts).toEqual([
      {
        toolUseId: 'search-duplicate',
        query: '原神 雷电将军 配队 攻略',
        status: 'duplicate',
        urls: []
      }
    ]);
    expect(result.tools).toEqual([
      expect.objectContaining({
        id: 'search-duplicate',
        name: 'WebSearch',
        succeeded: false
      })
    ]);
  });

  it('bounds WebSearch evidence and marks overflow instead of retaining extra attempts', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        for (let index = 0; index < AGENT_TURN_WEB_SEARCH_EVIDENCE_MAX_ATTEMPTS + 1; index += 1) {
          const id = `search-${index}`;
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id,
                  name: 'WebSearch',
                  input: { query: `原神 雷电将军 配队 攻略 ${index}` }
                }
              ]
            }
          };
          yield {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  is_error: false,
                  content: 'not retained'
                }
              ]
            }
          };
        }
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };

    const result = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test'
    });

    expect(result.webSearchEvidence.attempts).toHaveLength(
      AGENT_TURN_WEB_SEARCH_EVIDENCE_MAX_ATTEMPTS
    );
    expect(result.webSearchEvidence.truncated).toBe(true);
  });

  it('attributes every tool record to one correlation and one independent round', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'profile',
                name: 'mcp__genshin__read_profile_cache',
                input: { uid: '123456789' }
              }
            ]
          }
        };
        yield {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'profile', is_error: false, content: 'ok' }
            ]
          }
        };
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };
    const sdkOptions: AgentSdkRunOptions = {
      apiKey: 'test',
      baseUrl: 'https://example.test',
      model: 'test',
      systemPrompt: '',
      cwd: '/tmp',
      abortController: new AbortController(),
      maxTurns: 4
    };

    const result = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions,
      systemPrompt: 'test',
      auditContext: { correlationId: 'stygian-correlation', round: 'repair' }
    });

    expect(result.tools).toEqual([
      expect.objectContaining({
        id: 'profile',
        correlationId: auditCorrelationId('stygian-correlation'),
        round: 'repair',
        succeeded: true
      })
    ]);
  });

  it('reports each successful result usage delta before a later stream failure', async () => {
    const onUsageDelta = vi.fn();
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'result',
          subtype: 'success',
          result: '{}',
          usage: { input_tokens: 17, output_tokens: 9 },
          total_cost_usd: 0.03
        };
        throw new Error('later-stage-stream-failed');
      }
    };
    const sdkOptions: AgentSdkRunOptions = {
      apiKey: 'test',
      baseUrl: 'https://example.test',
      model: 'test',
      systemPrompt: '',
      cwd: '/tmp',
      abortController: new AbortController(),
      maxTurns: 1
    };

    const turn = runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions,
      systemPrompt: 'test',
      onUsageDelta
    });
    await expect(turn).rejects.toBeInstanceOf(AgentTurnError);
    await expect(turn).rejects.toMatchObject({
      name: 'AgentTurnError',
      code: 'AGENT_TURN_STREAM_FAILED',
      message: 'Agent turn stream failed'
    });
    await expect(turn).rejects.not.toThrow('later-stage-stream-failed');
    expect(onUsageDelta).toHaveBeenCalledOnce();
    expect(onUsageDelta).toHaveBeenCalledWith({
      inputTokens: 17,
      outputTokens: 9,
      estimatedCostUsd: 0.03
    });
  });

  it('returns the verbatim final result and a bounded raw-message summary', async () => {
    const longChunk = '甲'.repeat(AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS + 50);
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: longChunk }] }
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: `  {"answer":"原样保留"}\\n`,
          usage: { input_tokens: 2, output_tokens: 3 },
          total_cost_usd: 0.004
        };
      }
    };

    const result = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test'
    });

    expect(result.text).toBe(`  {"answer":"原样保留"}\\n`);
    expect(result.finalRawText).toBe(`  {"answer":"原样保留"}\\n`);
    expect(result.rawMessagesSummary).toMatchObject({
      totalMessages: 2,
      truncated: false
    });
    expect(result.rawMessagesSummary.messages).toHaveLength(2);
    expect(result.rawMessagesSummary.messages[0]).toMatchObject({
      type: 'assistant',
      textPreview: '甲'.repeat(AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS),
      textTruncated: true
    });
  });

  it('caps the number of raw-message summaries without retaining raw messages', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        for (let index = 0; index < AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES + 5; index += 1) {
          yield { type: 'status', subtype: `status-${index}`, secret: `secret-${index}` };
        }
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };

    const result = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test'
    });

    expect(result.rawMessagesSummary.totalMessages).toBe(AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES + 6);
    expect(result.rawMessagesSummary.messages).toHaveLength(AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES);
    expect(result.rawMessagesSummary.truncated).toBe(true);
    expect(JSON.stringify(result.rawMessagesSummary)).not.toContain('secret-');
  });

  it('throws a stable AgentTurnError for an SDK error result subtype', async () => {
    const sdkResultError = {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['provider-secret-error'],
      usage: {}
    };
    const runner: AuditedAgentRunner = {
      async *run() {
        yield sdkResultError;
      }
    };

    const turn = runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test'
    });
    await expect(turn).rejects.toMatchObject({
      name: 'AgentTurnError',
      code: 'AGENT_TURN_RESULT_ERROR',
      message: 'Agent turn returned an error result'
    });
    await expect(turn).rejects.not.toThrow('provider-secret-error');
    await expect(turn).rejects.toMatchObject({ cause: sdkResultError });
  });

  it('attaches a bounded accumulated partial turn without provider error text', async () => {
    const query = '原神 雷电将军 配队 攻略';
    const runner: AuditedAgentRunner = {
      async *run() {
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

    let failure: unknown;
    try {
      await runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: sdkOptions(),
        systemPrompt: 'test',
        normalizeResearchUrl: trustedResearchUrl
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentTurnError);
    expect(failure).toMatchObject({
      code: 'AGENT_TURN_RESULT_ERROR',
      usage: { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.01 },
      partialTurn: {
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
        },
        usage: { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.01 }
      }
    });
    expect(JSON.stringify((failure as AgentTurnError).partialTurn)).not.toContain(
      'TOP-SECRET-PROVIDER-BODY'
    );
  });

  it('bounds and sanitizes tool audits while collecting a successful turn', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        const tools = Array.from(
          { length: AGENT_TURN_TOOL_AUDIT_MAX + 5 },
          (_, index) => ({
            type: 'tool_use',
            id: `tool-${index}-${'i'.repeat(300)}`,
            name: 'query_team_knowledge-TOP-SECRET-AUDIT-VALUE',
            input: {
              query: `query-${index}`,
              nested: {
                values: Array.from({ length: 40 }, () => 'x'.repeat(2_000)),
                deeper: { one: { two: { three: { four: 'must-not-be-retained' } } } }
              },
              apiKey: 'TOP-SECRET-TOOL-KEY'
            }
          })
        );
        yield {
          type: 'assistant',
          message: { content: tools }
        };
        yield {
          type: 'user',
          message: {
            content: tools.map(({ id }) => ({
              type: 'tool_result',
              tool_use_id: id,
              is_error: false,
              content: 'ok'
            }))
          }
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '{}',
          usage: {}
        };
      }
    };

    const turn = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: { ...sdkOptions(), apiKey: 'TOP-SECRET-AUDIT-VALUE' },
      systemPrompt: 'test',
      auditContext: {
        correlationId: 'TOP-SECRET-AUDIT-VALUE',
        round: 'compose'
      }
    });

    expect(turn.tools).toHaveLength(AGENT_TURN_TOOL_AUDIT_MAX);
    expect(turn.toolsTruncated).toBe(true);
    expect(turn.tools.every(({ succeeded }) => succeeded)).toBe(true);
    expect(
      turn.tools.every(
        ({ id, name, correlationId }) =>
          id.length <= 128 &&
          name === '[REDACTED]' &&
          correlationId === auditCorrelationId('TOP-SECRET-AUDIT-VALUE')
      )
    ).toBe(true);
    expect(
      (
        turn.tools[0]?.input['nested'] as {
          values: string[];
        }
      ).values
    ).toHaveLength(16);
    expect(JSON.stringify(turn.tools)).not.toMatch(
      /TOP-SECRET-TOOL-KEY|must-not-be-retained/
    );
    expect(JSON.stringify(turn.tools).length).toBeLessThan(50_000);
  });

  it('redacts dynamic keys and private numeric values in a successful tool audit', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'private-input',
                name: 'query_team_knowledge',
                input: privateToolInput()
              }
            ]
          }
        };
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'private-input',
                is_error: false,
                content: 'ok'
              }
            ]
          }
        };
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };

    const turn = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: privateInputSdkOptions(),
      systemPrompt: 'test'
    });
    const input = turn.tools[0]!.input;
    const serialized = JSON.stringify(input);

    expect(Object.keys(input).filter((key) => /^audit-key-[a-f0-9]{32}$/.test(key))).toHaveLength(
      4
    );
    expect(input).toMatchObject({
      timestamp: '[REDACTED]',
      retryCode: '[REDACTED]',
      ratio: '[REDACTED]',
      floor: 12,
      enabled: true,
      empty: null
    });
    expect(serialized).not.toMatch(
      /123456789|1784952000000|apiKey|dynamic-secret|246813579/
    );
    expect(Object.keys(input)).toHaveLength(11);
    expect(serialized.length).toBeLessThan(1_000);
  });

  it('retains ordinary integers while redacting unsafe or non-integer numeric inputs', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'numeric-policy',
                name: 'query_team_knowledge',
                input: {
                  level: 90,
                  count: 4,
                  floor: 12,
                  ratio: 0.75,
                  scientific: 1e21,
                  unsafeInteger: Number.MAX_SAFE_INTEGER + 1,
                  infinite: Number.POSITIVE_INFINITY,
                  nan: Number.NaN,
                  enabled: true,
                  empty: null
                }
              }
            ]
          }
        };
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'numeric-policy',
                is_error: false,
                content: 'ok'
              }
            ]
          }
        };
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };

    const turn = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test'
    });

    expect(turn.tools[0]!.input).toEqual({
      level: 90,
      count: 4,
      floor: 12,
      ratio: '[REDACTED]',
      scientific: '[REDACTED]',
      unsafeInteger: '[REDACTED]',
      infinite: '[REDACTED]',
      nan: '[REDACTED]',
      enabled: true,
      empty: null
    });
  });

  it('compares encoded and Unicode tool inputs against canonical configured secrets', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'canonical-secrets',
                name: 'query_team_knowledge',
                input: canonicalSecretInput()
              }
            ]
          }
        };
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'canonical-secrets',
                is_error: false,
                content: 'ok'
              }
            ]
          }
        };
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };

    const turn = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: canonicalSecretSdkOptions(),
      systemPrompt: 'test'
    });
    const serialized = JSON.stringify(turn.tools[0]!.input);

    expect(Object.values(turn.tools[0]!.input).every((value) => value === '[REDACTED]')).toBe(
      true
    );
    expectCanonicalSecretAbsent(serialized);
  });

  it('keeps canonically sensitive tool IDs distinct while pairing their results', async () => {
    const toolIds = [
      'tool-s3nsitivev4lue-first',
      'tool-s3nsitivev4lue-second'
    ];
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: toolIds.map((id) => ({
              type: 'tool_use',
              id,
              name: 'query_team_knowledge',
              input: { floor: 12 }
            }))
          }
        };
        yield {
          type: 'user',
          message: {
            content: toolIds.map((toolUseId) => ({
              type: 'tool_result',
              tool_use_id: toolUseId,
              is_error: false,
              content: 'ok'
            }))
          }
        };
        yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
      }
    };

    const turn = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: canonicalSecretSdkOptions(),
      systemPrompt: 'test'
    });

    expect(turn.tools.map(({ id }) => id)).toEqual([
      expect.stringMatching(/^audit-tool-id-[a-f0-9]{32}$/),
      expect.stringMatching(/^audit-tool-id-[a-f0-9]{32}$/)
    ]);
    expect(new Set(turn.tools.map(({ id }) => id)).size).toBe(2);
    expect(turn.tools.every(({ succeeded }) => succeeded)).toBe(true);
    expectCanonicalSecretAbsent(JSON.stringify(turn.tools));
  });

  it('bounds and redacts accumulated partial tool audits', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: Array.from(
              { length: AGENT_TURN_TOOL_AUDIT_MAX + 5 },
              (_, index) => ({
                type: 'tool_use',
                id: `tool-${index}`,
                name: 'WebSearch',
                input: {
                  query: `原神 配队 攻略 ${index}`,
                  nested: {
                    values: Array.from({ length: 40 }, () => 'x'.repeat(2_000)),
                    deeper: { one: { two: { three: { four: 'must-not-be-retained' } } } }
                  },
                  apiKey: 'TOP-SECRET-TOOL-KEY'
                }
              })
            )
          }
        };
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          result: 'provider failure',
          usage: {}
        };
      }
    };

    let failure: unknown;
    try {
      await runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: sdkOptions(),
        systemPrompt: 'test',
        normalizeResearchUrl: trustedResearchUrl
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentTurnError);
    expect((failure as AgentTurnError).partialTurn?.tools).toHaveLength(
      AGENT_TURN_TOOL_AUDIT_MAX
    );
    expect((failure as AgentTurnError).partialTurn?.toolsTruncated).toBe(true);
    const partialTurnJson = JSON.stringify((failure as AgentTurnError).partialTurn);
    expect(partialTurnJson).not.toMatch(
      /TOP-SECRET-TOOL-KEY|must-not-be-retained/
    );
    expect(partialTurnJson.length).toBeLessThan(50_000);
  });

  it('redacts dynamic keys and private numeric values in an error partial turn', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'private-input',
                name: 'query_team_knowledge',
                input: privateToolInput()
              }
            ]
          }
        };
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          result: 'provider failure',
          usage: {}
        };
      }
    };

    let failure: unknown;
    try {
      await runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: privateInputSdkOptions(),
        systemPrompt: 'test'
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentTurnError);
    const input = (failure as AgentTurnError).partialTurn?.tools[0]?.input;
    const serialized = JSON.stringify(input);
    expect(
      Object.keys(input ?? {}).filter((key) => /^audit-key-[a-f0-9]{32}$/.test(key))
    ).toHaveLength(4);
    expect(input).toMatchObject({
      timestamp: '[REDACTED]',
      retryCode: '[REDACTED]',
      ratio: '[REDACTED]',
      floor: 12,
      enabled: true,
      empty: null
    });
    expect(serialized).not.toMatch(
      /123456789|1784952000000|apiKey|dynamic-secret|246813579/
    );
    expect(Object.keys(input ?? {})).toHaveLength(11);
    expect(serialized.length).toBeLessThan(1_000);
  });

  it('compares encoded and Unicode partial inputs against canonical configured secrets', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'canonical-secrets',
                name: 'query_team_knowledge',
                input: canonicalSecretInput()
              }
            ]
          }
        };
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          result: 'provider failure',
          usage: {}
        };
      }
    };

    let failure: unknown;
    try {
      await runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: canonicalSecretSdkOptions(),
        systemPrompt: 'test'
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentTurnError);
    const input = (failure as AgentTurnError).partialTurn?.tools[0]?.input ?? {};
    expect(Object.values(input).every((value) => value === '[REDACTED]')).toBe(true);
    expectCanonicalSecretAbsent(JSON.stringify(input));
  });

  it.each(['error_during_execution', 'error_max_turns'])(
    'reports sanitized usage exactly once before throwing for %s',
    async (subtype) => {
      const onUsageDelta = vi.fn();
      const runner: AuditedAgentRunner = {
        async *run() {
          yield {
            type: 'result',
            subtype,
            errors: ['provider-secret-error'],
            usage: { input_tokens: 23, output_tokens: 11 },
            total_cost_usd: 0.07
          };
        }
      };

      const turn = runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: sdkOptions(),
        systemPrompt: 'test',
        onUsageDelta
      });

      await expect(turn).rejects.toMatchObject({
        code: 'AGENT_TURN_RESULT_ERROR',
        message: 'Agent turn returned an error result',
        usage: {
          inputTokens: 23,
          outputTokens: 11,
          estimatedCostUsd: 0.07
        }
      });
      await expect(turn).rejects.not.toThrow('provider-secret-error');
      expect(onUsageDelta).toHaveBeenCalledOnce();
      expect(onUsageDelta).toHaveBeenCalledWith({
        inputTokens: 23,
        outputTokens: 11,
        estimatedCostUsd: 0.07
      });
    }
  );

  it.each([
    ['missing subtype', { type: 'result', result: '{}', usage: {} }],
    ['non-string subtype', { type: 'result', subtype: 7, result: '{}', usage: {} }],
    ['unknown subtype', { type: 'result', subtype: 'future_success', result: '{}', usage: {} }],
    ['missing success result', { type: 'result', subtype: 'success', usage: {} }],
    [
      'non-string success result',
      { type: 'result', subtype: 'success', result: { secret: 'provider-secret' }, usage: {} }
    ]
  ])('fails closed for a result message with %s', async (_label, sdkResult) => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield sdkResult;
      }
    };

    const turn = runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test'
    });

    await expect(turn).rejects.toMatchObject({
      name: 'AgentTurnError',
      code: 'AGENT_TURN_RESULT_ERROR',
      message: 'Agent turn returned an error result',
      cause: sdkResult
    });
    await expect(turn).rejects.not.toThrow('provider-secret');
  });

  it('preserves assistantText fallback when an explicit success result is empty', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'assistant fallback' }] }
        };
        yield { type: 'result', subtype: 'success', result: '', usage: {} };
      }
    };

    const turn = await runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: sdkOptions(),
      systemPrompt: 'test'
    });

    expect(turn.text).toBe('assistant fallback');
    expect(turn.finalRawText).toBe('assistant fallback');
  });

  it('returns assistant text when the stream ends cleanly without a result message', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'assistant-only fallback' }] }
        };
      }
    };

    await expect(
      runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: sdkOptions(),
        systemPrompt: 'test'
      })
    ).resolves.toMatchObject({
      text: 'assistant-only fallback',
      finalRawText: 'assistant-only fallback'
    });
  });

  it('fails with a stable incomplete code when a clean stream has no result or assistant text', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield { type: 'status', subtype: 'finished-without-output' };
      }
    };

    await expect(
      runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: sdkOptions(),
        systemPrompt: 'test'
      })
    ).rejects.toMatchObject({
      code: 'AGENT_TURN_INCOMPLETE',
      message: 'Agent turn ended without a result'
    });
  });

  it('does not invoke the runner when the turn is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    const runner: AuditedAgentRunner = {
      run
    };

    await expect(
      runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: { ...sdkOptions(), abortController: controller },
        systemPrompt: 'test'
      })
    ).rejects.toMatchObject({
      code: 'AGENT_TURN_CANCELLED',
      message: 'Agent turn was cancelled'
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('maps a runner failure after cancellation to the stable cancelled code', async () => {
    const controller = new AbortController();
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] }
        };
        controller.abort();
        throw new Error('provider-secret-abort-detail');
      }
    };

    const turn = runAuditedAgentTurn({
      runner,
      prompt: '{}',
      sdkOptions: { ...sdkOptions(), abortController: controller },
      systemPrompt: 'test'
    });

    await expect(turn).rejects.toMatchObject({
      code: 'AGENT_TURN_CANCELLED',
      message: 'Agent turn was cancelled'
    });
    await expect(turn).rejects.not.toThrow('provider-secret-abort-detail');
  });

  it('checks cancellation again after a clean EOF', async () => {
    const controller = new AbortController();
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] }
        };
        controller.abort();
      }
    };

    await expect(
      runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: { ...sdkOptions(), abortController: controller },
        systemPrompt: 'test'
      })
    ).rejects.toMatchObject({
      code: 'AGENT_TURN_CANCELLED',
      message: 'Agent turn was cancelled'
    });
  });

  it('rejects an oversized final value instead of returning a non-verbatim truncation', async () => {
    const runner: AuditedAgentRunner = {
      async *run() {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'x'.repeat(AGENT_TURN_FINAL_TEXT_MAX_CHARS + 1),
          usage: {}
        };
      }
    };

    await expect(
      runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions: sdkOptions(),
        systemPrompt: 'test'
      })
    ).rejects.toMatchObject({
      name: 'AgentTurnError',
      code: 'AGENT_TURN_OUTPUT_TOO_LARGE'
    });
  });
});

function sdkOptions(): AgentSdkRunOptions {
  return {
    apiKey: 'test',
    baseUrl: 'https://example.test',
    model: 'test',
    systemPrompt: '',
    cwd: '/tmp',
    abortController: new AbortController(),
    maxTurns: 1
  };
}

function privateInputSdkOptions(): AgentSdkRunOptions {
  return {
    ...sdkOptions(),
    apiKey: 'dynamic-secret',
    customHeaders: { 'X-Private-Pin': '42' }
  };
}

function canonicalSecretSdkOptions(): AgentSdkRunOptions {
  return {
    ...sdkOptions(),
    apiKey: 's3nsitivev4lue'
  };
}

function canonicalSecretInput(): Record<string, unknown> {
  return {
    encodedOnce: '%733nsitivev4lue',
    encodedTwice: '%25733nsitivev4lue',
    fullWidth: 'ｓ３ｎｓｉｔｉｖｅｖ４ｌｕｅ',
    ignorable: 's3n\u200bsitivev4lue',
    'field-%733nsitivev4lue': 'safe-looking-value'
  };
}

function expectCanonicalSecretAbsent(serialized: string): void {
  for (const secretVariant of [
    's3nsitivev4lue',
    '%733nsitivev4lue',
    '%25733nsitivev4lue',
    'ｓ３ｎｓｉｔｉｖｅｖ４ｌｕｅ',
    's3n\u200bsitivev4lue'
  ]) {
    expect(serialized).not.toContain(secretVariant);
  }
}

function privateToolInput(): Record<string, unknown> {
  return {
    '123456789': 'x',
    uid: 123456789,
    apiKey: 'secret',
    'field-dynamic-secret-key': 'dynamic-secret-value',
    timestamp: 1784952000000,
    retryCode: 42,
    longCode: 246813579,
    ratio: 0.75,
    floor: 12,
    enabled: true,
    empty: null
  };
}

function sdkWebSearchRunner(toolUseResult: unknown): AuditedAgentRunner {
  return {
    async *run() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'search-shaped',
              name: 'WebSearch',
              input: { query: '原神 雷电将军 配队 攻略' }
            }
          ]
        }
      };
      yield {
        type: 'user',
        tool_use_result: toolUseResult,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'search-shaped',
              is_error: false,
              content: 'raw provider output is not retained'
            }
          ]
        }
      };
      yield { type: 'result', subtype: 'success', result: '{}', usage: {} };
    }
  };
}

function webSearchSequenceMessage(
  kind: 'tool' | 'success' | 'error' | 'invalid'
): Record<string, unknown> {
  if (kind === 'tool') {
    return {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'search-duplicate',
            name: 'WebSearch',
            input: { query: '原神 雷电将军 配队 攻略' }
          }
        ]
      }
    };
  }
  return {
    type: 'user',
    ...(kind === 'error'
      ? {}
      : {
          tool_use_result:
            kind === 'invalid'
              ? {
                  query: '原神 雷电将军 配队 攻略',
                  results: ['commentary without URL'],
                  durationSeconds: 0.2,
                  searchCount: 1
                }
              : {
                  query: '原神 雷电将军 配队 攻略',
                  results: [
                    {
                      tool_use_id: 'search-duplicate',
                      content: [
                        {
                          title: 'Guide',
                          url: 'https://keqingmains.com/q/raiden-quickguide/'
                        }
                      ]
                    }
                  ],
                  durationSeconds: 0.2,
                  searchCount: 1
                }
        }),
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'search-duplicate',
          is_error: kind === 'error',
          content: 'not retained'
        }
      ]
    }
  };
}

function sdkSearchToolResultMessage(
  id: string,
  query: string,
  status: 'success' | 'error'
): Record<string, unknown> {
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
                    title: 'Guide',
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
          content:
            status === 'success'
              ? `Search completed for ${query}`
              : 'Search failed'
        }
      ]
    }
  };
}

function trustedResearchUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'keqingmains.com'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
