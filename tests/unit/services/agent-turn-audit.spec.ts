import { describe, expect, it, vi } from 'vitest';

import {
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
        yield { type: 'result', result: '{}', usage: {} };
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

    await expect(
      runAuditedAgentTurn({
        runner,
        prompt: '{}',
        sdkOptions,
        systemPrompt: 'test',
        onUsageDelta
      })
    ).rejects.toThrow('later-stage-stream-failed');
    expect(onUsageDelta).toHaveBeenCalledOnce();
    expect(onUsageDelta).toHaveBeenCalledWith({
      inputTokens: 17,
      outputTokens: 9,
      estimatedCostUsd: 0.03
    });
  });
});
