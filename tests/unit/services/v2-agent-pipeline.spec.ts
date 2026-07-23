import { describe, expect, it } from 'vitest';

import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import {
  runV2AgentPipeline,
  type V2PipelineContext
} from '../../../src/main/services/v2-agent-pipeline.js';
import type { ToolAudit } from '../../../src/main/services/agent-turn-audit.js';
import type { RecommendationPlan } from '../../../src/shared/scenario-v2.js';
import { validAbyssPlan } from './abyss-test-fixtures.js';
import { validStygianPlan } from './stygian-test-fixtures.js';
import { validTheaterPlan } from './theater-test-fixtures.js';

class StageRunner {
  readonly calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];

  constructor(private readonly outputs: unknown[]) {}

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    yield {
      type: 'result',
      result: JSON.stringify(this.outputs.shift()),
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01
    };
  }
}

function sdkOptions(): AgentSdkRunOptions {
  return {
    apiKey: 'secret',
    baseUrl: 'https://example.test',
    model: 'test-model',
    systemPrompt: '',
    cwd: '/tmp',
    abortController: new AbortController(),
    maxTurns: 4,
    mcpServers: { genshin: { type: 'sdk', name: 'genshin', instance: {} as never } },
    allowedBusinessTools: ['mcp__genshin__read_profile_cache']
  };
}

function planIds(plan: RecommendationPlan): string[] {
  switch (plan.mode) {
    case 'spiral-abyss':
      return [...plan.firstHalfTeam.characterIds, ...plan.secondHalfTeam.characterIds];
    case 'stygian-onslaught':
      return plan.phases.flatMap(({ team }) => team.characterIds);
    case 'imaginarium-theater':
      return [
        ...plan.cast.selectedCharacterIds,
        ...plan.cast.openingCharacterIds,
        ...plan.cast.trialCharacterIds,
        ...plan.cast.specialGuestCharacterIds,
        ...plan.cast.supportCharacterIds
      ];
  }
}

function context(plan: RecommendationPlan): V2PipelineContext {
  const eligibleCharacterIds = [...new Set(planIds(plan))];
  const compactBaseline =
    plan.mode === 'spiral-abyss'
      ? {
          mode: plan.mode,
          scenarioId: plan.scenarioId,
          dataVersion: plan.dataVersion,
          firstHalfTeam: {
            id: plan.firstHalfTeam.id,
            characterIds: plan.firstHalfTeam.characterIds
          },
          secondHalfTeam: {
            id: plan.secondHalfTeam.id,
            characterIds: plan.secondHalfTeam.characterIds
          },
          chambers: plan.chambers.map(({ floor, chamber }) => ({ floor, chamber }))
        }
      : plan.mode === 'stygian-onslaught'
        ? {
            mode: plan.mode,
            scenarioId: plan.scenarioId,
            dataVersion: plan.dataVersion,
            reusePolicyAcknowledgement: plan.reusePolicyAcknowledgement,
            phases: plan.phases.map(({ phase, team }) => ({
              phase,
              team: { id: team.id, characterIds: team.characterIds }
            }))
          }
        : {
            mode: plan.mode,
            scenarioId: plan.scenarioId,
            dataVersion: plan.dataVersion,
            cast: plan.cast,
            acts: plan.acts.map(
              ({ act, candidateCharacterIds, plannedVigorSpend, pathChoice }) => ({
                act,
                candidateCharacterIds,
                plannedVigorSpend,
                pathKind: pathChoice.kind
              })
            )
          };
  return {
    mode: plan.mode,
    correlationId: 'pipeline-correlation',
    scenarioId: plan.scenarioId,
    dataVersion: plan.dataVersion,
    locale: 'zh-CN',
    profileRef: { uid: '123456789' },
    profile: {
      coverage: {
        ownedCount: 100,
        detailedCount: 8,
        buildCount: 20,
        statsCount: 20,
        enkaShowcaseCount: 8,
        missingDetailCount: 92,
        partial: true
      },
      provenanceSummaries: [{ ownership: 'miyoushe-list', characterIndexes: [0] }],
      minimalIndex: [
        {
          id: Number(eligibleCharacterIds[0] ?? '1001'),
          name: '测试角色',
          element: 'Pyro',
          rarity: 5,
          level: 90,
          completeness: 'detailed',
          missingFields: ['talents']
        }
      ],
      detailedProfiles: [
        {
          id: Number(eligibleCharacterIds[0] ?? '1001'),
          name: '测试角色',
          element: 'Pyro',
          rarity: 5,
          level: 90,
          weapon: { name: '测试武器', level: 90 },
          artifactSummary: {
            sets: [{ name: '测试套装', count: 4 }],
            mainStats: { sands: 'atkPct', goblet: 'pyroDmg', circlet: 'critRate' }
          },
          stats: { hp: 20_000, atk: 2_000, def: 800, energyRecharge: 140 },
          completeness: 'detailed',
          missingFields: ['talents']
        }
      ]
    },
    candidate: {
      kind: 'feasibleBaseline',
      feasibleBaseline: compactBaseline,
      eligibleCharacterIds
    },
    mechanics: [{ target: 'selected-scenario', facts: ['已确认机制'], unknowns: ['未知数值'] }],
    interventions: {
      locale: 'zh-CN',
      preferences: {
        comfort: 'off',
        survival: 'off',
        lowInvestment: 'off',
        noBuildChange: true
      }
    },
    knowledge: {
      version: 'test-knowledge',
      unknownCharacterIds: ['9999']
    }
  };
}

function targets(plan: RecommendationPlan) {
  switch (plan.mode) {
    case 'spiral-abyss':
      return {
        critique: { kind: 'abyss-chamber' as const, floor: 12, chamber: 1, half: 'first' as const },
        rotations: [
          { kind: 'abyss-team' as const, half: 'first' as const },
          { kind: 'abyss-team' as const, half: 'second' as const }
        ],
        explanations: plan.chambers.flatMap(({ floor, chamber }) =>
          (['first', 'second'] as const).map((half) => ({
            kind: 'abyss-chamber' as const,
            floor,
            chamber,
            half
          }))
        )
      };
    case 'stygian-onslaught':
      return {
        critique: { kind: 'stygian-phase' as const, phase: 1 },
        rotations: plan.phases.map(({ phase }) => ({
          kind: 'stygian-phase' as const,
          phase
        })),
        explanations: plan.phases.map(({ phase }) => ({
          kind: 'stygian-phase' as const,
          phase
        }))
      };
    case 'imaginarium-theater':
      return {
        critique: { kind: 'theater-act' as const, act: 1 },
        rotations: plan.acts.map(({ act }) => ({ kind: 'theater-act' as const, act })),
        explanations: [
          { kind: 'theater-cast' as const },
          ...plan.acts.map(({ act }) => ({ kind: 'theater-act' as const, act }))
        ]
      };
  }
}

function rotationOutput(plan: RecommendationPlan) {
  return {
    rotations: targets(plan).rotations.map((target) => directive(target))
  };
}

function explainOutput(plan: RecommendationPlan) {
  return {
    explanations: targets(plan).explanations.map((target) => directive(target))
  };
}

function directive<T>(target: T) {
  return {
    target,
    tone: 'steady',
    reasonCodes: ['setup-order'],
    factRefs: [{ kind: 'plan', field: 'validated-target' }]
  };
}

function run(
  runner: StageRunner,
  baseline: RecommendationPlan,
  validate: (
    text: string,
    tools: ToolAudit[]
  ) =>
    | { ok: true; plan: RecommendationPlan }
    | { ok: false; issues: Array<{ code: string; path: Array<string | number>; message: string }> }
) {
  return runV2AgentPipeline({
    runner,
    context: context(baseline),
    sdkOptionsForStage: () => sdkOptions(),
    composer: {
      initialPrompt: JSON.stringify({ request: 'compose' }),
      systemPrompt: `composer:${baseline.mode}`,
      repairPrompt: 'repair',
      validate
    },
    invalidIssue: (stage, message) => ({
      code: 'AGENT_OUTPUT_INVALID',
      path: [stage],
      message
    })
  });
}

describe.each([
  ['spiral-abyss', validAbyssPlan()],
  ['stygian-onslaught', validStygianPlan()],
  ['imaginarium-theater', validTheaterPlan()]
] as const)('V2 agent pipeline: %s', (_mode, baseline) => {
  it('runs Composer → Critique → Rotation → Explain with a grounded feasible baseline', async () => {
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);
    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(result).toMatchObject({
      ok: true,
      repairs: 0,
      usage: { inputTokens: 40, outputTokens: 20, estimatedCostUsd: 0.04 }
    });
    expect(runner.calls.map(({ options }) => options.systemPrompt)).toEqual([
      `composer:${baseline.mode}`,
      expect.stringContaining('CritiqueAgent v2'),
      expect.stringContaining('RotationCoachAgent v2'),
      expect.stringContaining('ExplainAgent v2')
    ]);
    const composePayload = JSON.parse(runner.calls[0]!.prompt) as Record<string, unknown>;
    expect(JSON.stringify(composePayload)).toContain('"kind":"feasibleBaseline"');
    expect(JSON.stringify(composePayload)).toContain('"missingFields":["talents"]');
    expect(JSON.stringify(composePayload)).toContain('"profileRef":{"uid":"123456789"}');
    expect(JSON.stringify(composePayload)).toContain('"unknownCharacterIds":["9999"]');
    expect(runner.calls[0]!.options.allowedBusinessTools).toEqual([
      'mcp__genshin__read_profile_cache'
    ]);
    for (const call of runner.calls.slice(1)) {
      expect(call.options.allowedBusinessTools).toEqual([]);
      expect(call.options.mcpServers).toBeUndefined();
      expect(call.options.maxTurns).toBe(1);
    }
  });
});

describe.each([
  ['spiral-abyss', validAbyssPlan()],
  ['stygian-onslaught', validStygianPlan()],
  ['imaginarium-theater', validTheaterPlan()]
] as const)('V2 exact stage target coverage: %s', (_mode, baseline) => {
  it('rejects a missing Rotation target', async () => {
    const rotation = rotationOutput(baseline);
    const currentExplain = {
      explanations: explainOutput(baseline).explanations.filter(
        ({ target }) => target.kind !== 'theater-cast'
      )
    };
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      { rotations: rotation.rotations.slice(0, -1) },
      currentExplain
    ]);

    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: ['rotation'] })]
    });
  });

  it('rejects a duplicate Explain target', async () => {
    const explanations = explainOutput(baseline).explanations.filter(
      ({ target }) => target.kind !== 'theater-cast'
    );
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      { explanations: [...explanations, explanations[0]] }
    ]);

    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: ['explain'] })]
    });
  });
});

describe('V2 agent pipeline repair and grounding', () => {
  it('uses at most two concrete repair rounds and critiques each valid attempt exactly once', async () => {
    const baseline = validAbyssPlan();
    const target = targets(baseline);
    const invalid = { invalid: true };
    const runner = new StageRunner([
      invalid,
      baseline,
      {
        decision: 'repair',
        issues: [
          {
            code: 'rotation-fragile',
            severity: 'soft',
            target: target.critique,
            message: '循环容错不足'
          }
        ]
      },
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);
    const result = await run(runner, baseline, (text) => {
      const parsed = JSON.parse(text) as unknown;
      return (parsed as { invalid?: boolean }).invalid
        ? {
            ok: false,
            issues: [{ code: 'PLAN_SCHEMA_INVALID', path: [], message: '结构无效' }]
          }
        : { ok: true, plan: parsed as RecommendationPlan };
    });

    expect(result).toMatchObject({ ok: true, repairs: 2 });
    expect(runner.calls.map(({ options }) => options.systemPrompt)).toEqual([
      'composer:spiral-abyss',
      expect.stringContaining('repair'),
      expect.stringContaining('CritiqueAgent v2'),
      expect.stringContaining('repair'),
      expect.stringContaining('CritiqueAgent v2'),
      expect.stringContaining('RotationCoachAgent v2'),
      expect.stringContaining('ExplainAgent v2')
    ]);
    expect(runner.calls[1]!.prompt).toContain('PLAN_SCHEMA_INVALID');
    expect(runner.calls[3]!.prompt).toContain('rotation-fragile');
  });

  it('stops before Rotation/Explain when a third repair would be required', async () => {
    const baseline = validStygianPlan();
    const target = targets(baseline);
    const runner = new StageRunner([
      baseline,
      {
        decision: 'repair',
        issues: [
          {
            code: 'risk-one',
            severity: 'soft',
            target: target.critique,
            message: '风险一'
          }
        ]
      },
      baseline,
      {
        decision: 'repair',
        issues: [
          {
            code: 'risk-two',
            severity: 'soft',
            target: target.critique,
            message: '风险二'
          }
        ]
      },
      baseline,
      {
        decision: 'repair',
        issues: [
          {
            code: 'risk-three',
            severity: 'soft',
            target: target.critique,
            message: '风险三'
          }
        ]
      }
    ]);
    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(result).toMatchObject({ ok: false, repairs: 2 });
    expect(runner.calls).toHaveLength(6);
    expect(
      runner.calls.some(({ options }) => options.systemPrompt.includes('RotationCoachAgent'))
    ).toBe(false);
  });

  it('rejects an Explain target that was not present in the validated plan', async () => {
    const baseline = validTheaterPlan();
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      {
        explanations: [directive({ kind: 'theater-act', act: 10 })]
      }
    ]);
    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: ['explain'] })]
    });
  });

  it('rejects a structured fact reference outside the bounded context', async () => {
    const baseline = validAbyssPlan();
    const explanation = explainOutput(baseline) as ReturnType<typeof explainOutput> & {
      explanations: Array<{
        factRefs: Array<
          { kind: 'plan'; field: string } | { kind: 'profile'; characterId: string; field: string }
        >;
      }>;
    };
    explanation.explanations[0]!.factRefs = [
      { kind: 'profile', characterId: '999999', field: 'stats' }
    ];
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explanation
    ]);
    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['explain'],
          message: expect.stringContaining('outside the bounded roster')
        })
      ]
    });
  });
});
