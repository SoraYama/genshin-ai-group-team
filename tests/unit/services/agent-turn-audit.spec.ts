import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_TURN_FINAL_TEXT_MAX_CHARS,
  AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES,
  AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS,
  AgentTurnError,
  runAuditedAgentTurn,
  type AuditedAgentRunner
} from '../../../src/main/services/agent-turn-audit.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';

describe('runAuditedAgentTurn', () => {
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
