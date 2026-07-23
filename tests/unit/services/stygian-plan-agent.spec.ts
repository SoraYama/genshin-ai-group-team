import { describe, expect, it, vi } from 'vitest';

import { StygianPlanAgent } from '../../../src/main/services/stygian-plan-agent.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import {
  STYGIAN_CHARACTERS,
  stygianInput,
  stygianScenario,
  validStygianPlan
} from './stygian-test-fixtures.js';

class FixtureRunner {
  readonly calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];

  constructor(
    private readonly outputs: unknown[],
    private readonly toolRounds: readonly number[] = [0, 1]
  ) {}

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    const round = this.calls.length - 1;
    const toolUses = [
      {
        id: 'profile',
        name: 'mcp__genshin__read_profile_cache',
        input: { uid: '123456789' }
      },
      ...[1, 2, 3].map((phase) => ({
        id: `phase-${phase}`,
        name: 'mcp__genshin__query_stygian_phase',
        input: {
          scenarioId: 'stygian.2026-07',
          dataVersion: '2026.07.1',
          difficultyId: 'difficulty-6',
          phase
        }
      })),
      {
        id: 'characters',
        name: 'mcp__genshin__query_genshin_db',
        input: { characterIds: STYGIAN_CHARACTERS.slice(0, 12).map(({ id }) => String(id)) }
      }
    ];
    if (this.toolRounds.includes(round)) {
      yield {
        type: 'assistant',
        message: { content: toolUses.map((use) => ({ type: 'tool_use', ...use })) }
      };
      yield {
        type: 'user',
        message: {
          content: toolUses.map(({ id }) => ({
            type: 'tool_result',
            tool_use_id: id,
            is_error: false,
            content: 'ok'
          }))
        }
      };
    }
    yield {
      type: 'result',
      result: JSON.stringify(this.outputs.shift()),
      usage: { input_tokens: 12, output_tokens: 8 },
      total_cost_usd: 0.02
    };
  }
}

class NoToolRunner {
  calls = 0;
  async *run(): AsyncIterable<unknown> {
    this.calls += 1;
    yield { type: 'result', result: JSON.stringify(validStygianPlan()) };
  }
}

function sdkOptions(): AgentSdkRunOptions {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    model: 'test-model',
    systemPrompt: '',
    cwd: '/tmp',
    abortController: new AbortController(),
    maxTurns: 4,
    mcpServers: { genshin: { type: 'sdk', name: 'genshin', instance: {} as never } },
    allowedBusinessTools: [
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_stygian_phase',
      'mcp__genshin__query_genshin_db'
    ]
  };
}

describe('StygianPlanAgent', () => {
  it('validates compose output, performs exactly one repair, and aggregates usage', async () => {
    const invalid = {
      ...validStygianPlan(),
      phases: validStygianPlan().phases.map((phase) => ({
        ...phase,
        team: { ...phase.team, characterIds: ['1001', '1002', '1003', '1004'] }
      }))
    };
    const repaired = validStygianPlan();
    const runner = new FixtureRunner([invalid, repaired]);
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput({ phase: 2 }),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({ ok: true, repaired: true, plan: repaired });
    expect(result.usage).toEqual({ inputTokens: 24, outputTokens: 16, estimatedCostUsd: 0.04 });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.options.systemPrompt).toContain('StygianTeamComposer');
    expect(runner.calls[0]?.prompt).toContain('"phase":2');
    expect(runner.calls[1]?.prompt).toContain('REUSE_POLICY_VIOLATION');
    expect(runner.calls[1]?.prompt).toContain('只修复');
  });

  it('rejects a plan unless profile, every phase, and all selected character knowledge were read', async () => {
    const runner = new NoToolRunner();
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'AGENT_OUTPUT_INVALID', path: ['tools'] }]
    });
    expect(runner.calls).toBe(2);
  });

  it('rejects a valid repair that borrows required tool evidence from the compose turn', async () => {
    const invalid = {
      ...validStygianPlan(),
      phases: validStygianPlan().phases.map((phase) => ({
        ...phase,
        team: { ...phase.team, characterIds: ['1001', '1002', '1003', '1004'] }
      }))
    };
    const runner = new FixtureRunner([invalid, validStygianPlan()], [0]);
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'AGENT_OUTPUT_INVALID', path: ['tools'] }]
    });
    expect(runner.calls).toHaveLength(2);
  });

  it('returns deterministic issues after one failed repair rather than scraping narrative', async () => {
    const runner = new FixtureRunner(['not-json', '```json\n{}\n```']);
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'AGENT_OUTPUT_INVALID' }] });
    expect(runner.calls).toHaveLength(2);
  });

  it('creates independently scoped SDK options for compose and repair rounds', async () => {
    const invalid = {
      ...validStygianPlan(),
      phases: validStygianPlan().phases.map((phase) => ({
        ...phase,
        team: { ...phase.team, characterIds: ['1001', '1002', '1003', '1004'] }
      }))
    };
    const runner = new FixtureRunner([invalid, validStygianPlan()]);
    const sdkOptionsForRound = vi.fn((round: 'compose' | 'repair') => ({
      ...sdkOptions(),
      mcpServers: {
        genshin: { type: 'sdk' as const, name: `genshin-${round}`, instance: {} as never }
      }
    }));
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      sdkOptions: sdkOptions(),
      sdkOptionsForRound
    });

    expect(result.ok).toBe(true);
    expect(sdkOptionsForRound.mock.calls.map(([round]) => round)).toEqual(['compose', 'repair']);
    expect(runner.calls[0]?.options.mcpServers).not.toBe(runner.calls[1]?.options.mcpServers);
  });
});
