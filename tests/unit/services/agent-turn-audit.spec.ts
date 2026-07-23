import { describe, expect, it } from 'vitest';

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
});
