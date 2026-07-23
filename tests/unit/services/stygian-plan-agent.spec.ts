import { describe, expect, it, vi } from 'vitest';

import { StygianPlanAgent } from '../../../src/main/services/stygian-plan-agent.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import { buildV2PipelineContext } from '../../../src/main/services/v2-agent-context.js';
import type { V2AgentStage } from '../../../src/main/services/v2-agent-pipeline.js';
import {
  STYGIAN_CHARACTERS,
  stygianInput,
  stygianScenario,
  validStygianPlan
} from './stygian-test-fixtures.js';

function directive<T>(target: T) {
  return {
    target,
    tone: 'steady',
    reasonCodes: ['setup-order'],
    factRefs: [{ kind: 'plan', field: 'validated-target' }]
  };
}

class FixtureRunner {
  readonly calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];
  readonly profileInputs: Array<{ uid: string; characterIds: string[] }> = [];

  constructor(
    private readonly outputs: unknown[],
    private readonly toolRounds: readonly number[] = [0, 1]
  ) {}

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    if (options.systemPrompt.includes('CritiqueAgent v2')) {
      yield { type: 'result', result: JSON.stringify({ decision: 'accept', issues: [] }) };
      return;
    }
    if (options.systemPrompt.includes('RotationCoachAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          rotations: [1, 2, 3].map((phase) => directive({ kind: 'stygian-phase', phase }))
        })
      };
      return;
    }
    if (options.systemPrompt.includes('ExplainAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          explanations: [...[1, 2, 3].map((phase) => directive({ kind: 'stygian-phase', phase }))]
        })
      };
      return;
    }
    const round = this.calls.length - 1;
    const payload = JSON.parse(prompt) as {
      context: { profileRef: { uid: string } };
    };
    const nextPlan = this.outputs[0] as {
      phases?: Array<{ team?: { characterIds?: unknown } }>;
    };
    const selectedIds = Array.isArray(nextPlan?.phases)
      ? nextPlan.phases.flatMap(({ team }) =>
          Array.isArray(team?.characterIds)
            ? team.characterIds.filter((id): id is string => typeof id === 'string')
            : []
        )
      : [];
    const profileInput = {
      uid: payload.context.profileRef.uid,
      characterIds: [...new Set(selectedIds)]
    };
    this.profileInputs.push(profileInput);
    const toolUses = [
      {
        id: 'profile',
        name: 'mcp__genshin__read_profile_cache',
        input: profileInput
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
        input: { characterIds: [...new Set(selectedIds)] }
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

function pipelineContext(feasibleBaseline = validStygianPlan()) {
  return buildV2PipelineContext({
    correlationId: 'stygian-test-request',
    profile: {
      schemaVersion: 2,
      uid: '123456789',
      source: 'merged',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      characters: STYGIAN_CHARACTERS,
      coverage: {
        ownedCount: STYGIAN_CHARACTERS.length,
        detailedCount: 8,
        buildCount: STYGIAN_CHARACTERS.length,
        statsCount: STYGIAN_CHARACTERS.length,
        enkaShowcaseCount: 8,
        missingDetailCount: 6,
        partial: true
      }
    },
    feasibleBaseline,
    eligibleCharacterIds: STYGIAN_CHARACTERS.map(({ id }) => String(id)),
    mechanics: [{ target: '三阶段', facts: ['跨队角色不可复用'], unknowns: ['精确伤害未知'] }],
    interventions: { target: 'dire-challenge' },
    knowledge: {
      version: 'unavailable',
      unknownCharacterIds: STYGIAN_CHARACTERS.map(({ id }) => String(id))
    }
  });
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
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: true,
      repaired: true,
      plan: { mode: repaired.mode, phases: expect.any(Array) }
    });
    expect(result.usage).toEqual({ inputTokens: 24, outputTokens: 16, estimatedCostUsd: 0.04 });
    expect(runner.calls).toHaveLength(5);
    expect(runner.calls[0]?.options.systemPrompt).toContain('StygianTeamComposer');
    expect(runner.calls[0]?.prompt).toContain('"locale":"zh-CN"');
    expect(runner.calls[0]?.prompt).toContain('"phase":2');
    expect(runner.calls[1]?.prompt).toContain('REUSE_POLICY_VIOLATION');
    expect(runner.calls[1]?.prompt).toContain('只修复');
    expect(runner.profileInputs).toEqual([
      { uid: '123456789', characterIds: ['1001', '1002', '1003', '1004'] },
      {
        uid: '123456789',
        characterIds: repaired.phases.flatMap(({ team }) => team.characterIds)
      }
    ]);
  });

  it('rejects a plan unless profile, every phase, and all selected character knowledge were read', async () => {
    const runner = new NoToolRunner();
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'AGENT_OUTPUT_INVALID', path: ['tools'] }]
    });
    expect(runner.calls).toBe(3);
  });

  it('rejects a valid repair that borrows required tool evidence from the compose turn', async () => {
    const invalid = {
      ...validStygianPlan(),
      phases: validStygianPlan().phases.map((phase) => ({
        ...phase,
        team: { ...phase.team, characterIds: ['1001', '1002', '1003', '1004'] }
      }))
    };
    const runner = new FixtureRunner([invalid, validStygianPlan(), validStygianPlan()], [0]);
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'AGENT_OUTPUT_INVALID', path: ['tools'] }]
    });
    expect(runner.calls).toHaveLength(3);
  });

  it('returns deterministic issues after one failed repair rather than scraping narrative', async () => {
    const runner = new FixtureRunner(['not-json', '```json\n{}\n```', 'still-not-json']);
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'AGENT_OUTPUT_INVALID' }] });
    expect(runner.calls).toHaveLength(3);
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
    const sdkOptionsForStage = vi.fn((round: V2AgentStage) => ({
      ...sdkOptions(),
      mcpServers: {
        genshin: { type: 'sdk' as const, name: `genshin-${round}`, instance: {} as never }
      }
    }));
    const result = await new StygianPlanAgent(runner).compose({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions(),
      sdkOptionsForStage
    });

    expect(result.ok).toBe(true);
    expect(sdkOptionsForStage.mock.calls.map(([round]) => round)).toEqual([
      'compose',
      'repair-1',
      'critique',
      'rotation',
      'explain'
    ]);
    expect(runner.calls[0]?.options.mcpServers).not.toBe(runner.calls[1]?.options.mcpServers);
    expect(runner.calls.slice(2).every(({ options }) => options.mcpServers === undefined)).toBe(
      true
    );
  });
});
