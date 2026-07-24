import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_TURN_FINAL_TEXT_MAX_CHARS,
  AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES,
  AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS,
  AGENT_TURN_WEB_SEARCH_EVIDENCE_MAX_ATTEMPTS,
  AgentTurnError,
  runAuditedAgentTurn,
  type AuditedAgentRunner
} from '../../../src/main/services/agent-turn-audit.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';

describe('runAuditedAgentTurn', () => {
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
          tool_use_result: { raw: 'provider-secret-result-must-not-be-retained' },
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
      systemPrompt: 'test'
    });

    expect(result.webSearchEvidence).toEqual({
      attempts: [
        {
          toolUseId: 'search-1',
          query: '原神 雷电将军 配队 攻略',
          status: 'resolved'
        }
      ],
      truncated: false
    });
    expect(JSON.stringify(result.webSearchEvidence)).not.toContain('provider-secret');
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
        correlationId: 'stygian-correlation',
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
