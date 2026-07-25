import { describe, expect, it, vi } from 'vitest';

import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import {
  runV2AgentPipeline,
  type V2AgentStage,
  type V2PipelineContext
} from '../../../src/main/services/v2-agent-pipeline.js';
import type { ToolAudit } from '../../../src/main/services/agent-turn-audit.js';
import {
  AgentRunTraceStore,
  type AgentRunTraceWriter
} from '../../../src/main/services/agent-run-trace-store.js';
import type { RecommendationPlan } from '../../../src/shared/scenario-v2.js';
import type { V2ExplainOutput, V2RotationOutput } from '../../../src/main/agents/contracts.js';
import {
  buildUnknownKnowledgeContext,
  buildV2PipelineContext
} from '../../../src/main/services/v2-agent-context.js';
import { MAX_AGENT_PAYLOAD_BYTES } from '../../../src/main/services/agent-payload-budget.js';
import { ABYSS_CHARACTERS, validAbyssPlan } from './abyss-test-fixtures.js';
import { validStygianPlan } from './stygian-test-fixtures.js';
import { validTheaterPlan } from './theater-test-fixtures.js';

class StageRunner {
  readonly calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];

  constructor(
    private readonly outputs: unknown[],
    private readonly onRunStart?: (options: AgentSdkRunOptions) => void
  ) {}

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    this.onRunStart?.(options);
    yield {
      type: 'result',
      subtype: 'success',
      result: JSON.stringify(this.outputs.shift()),
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01
    };
  }
}

class StrictStageProviderFailureRunner extends StageRunner {
  constructor(private readonly baseline: RecommendationPlan) {
    super([]);
  }

  override async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    if (this.calls.length === 1) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify(this.baseline),
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.01
      };
      return;
    }
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      status: 429,
      errors: ['TOP-SECRET-PROVIDER-BODY'],
      prompt: 'PRIVATE-PROFILE-PROMPT',
      usage: { input_tokens: 7, output_tokens: 1 },
      total_cost_usd: 0.02
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
    knowledge: buildUnknownKnowledgeContext('test-knowledge', ['9999'])
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

function rotationOutput(plan: RecommendationPlan): V2RotationOutput {
  return {
    rotations: targets(plan).rotations.map((target) => directive(target))
  };
}

function explainOutput(plan: RecommendationPlan): V2ExplainOutput {
  return {
    explanations: targets(plan).explanations.map((target) => directive(target))
  };
}

function directive<T>(target: T) {
  return {
    target,
    tone: 'steady' as const,
    reasonCodes: ['setup-order' as const],
    factRefs: [{ kind: 'plan' as const, field: 'validated-target' as const }]
  };
}

function trustedKnowledgePacket(characterId: string): V2PipelineContext['knowledge'] {
  return {
    knowledgeVersion: 'trusted-test',
    buildInterpretations: [
      {
        characterId,
        archetypeId: 'tested-role',
        confidence: 'high',
        candidateArchetypeIds: ['tested-role'],
        contextRequired: false,
        matchedSignals: ['current-build-match'],
        conflictingSignals: [],
        currentBuildUsable: true,
        adjustment: 'none',
        unknowns: []
      }
    ],
    trustedMatches: [
      {
        id: 'trusted-character',
        characterId,
        archetypeId: 'tested-role',
        summary: 'Trusted character facts are available.',
        citationIds: ['trusted-citation']
      }
    ],
    ephemeralMatches: [],
    unknowns: [],
    coverage: { requested: 1, trusted: 1, ephemeral: 0, unknown: 0 },
    citations: [
      {
        id: 'trusted-citation',
        sourceId: 'trusted-source',
        url: 'https://example.com/trusted-character',
        title: 'Trusted character review',
        reviewedAt: '2026-07-24T10:00:00+08:00',
        trust: 'trusted-local'
      }
    ]
  };
}

function envelopeBudgetContext(): V2PipelineContext {
  const baseline = validAbyssPlan();
  const selectedIds = planIds(baseline);
  const knowledge = trustedKnowledgePacket(selectedIds[0]!);
  knowledge.trustedMatches[0]!.factStatements = Array.from(
    { length: 32 },
    (_, index) => `low-priority-fact-${index}-${'f'.repeat(560)}`
  );
  const targetKnowledge: V2PipelineContext['knowledge'] = {
    knowledgeVersion: 'trusted-test',
    buildInterpretations: [],
    trustedMatches: [
      {
        id: 'target-shield-match',
        mechanicId: 'shield-breaking',
        summary: 'Reviewed target shield strategy.',
        citationIds: ['target-shield-citation']
      }
    ],
    ephemeralMatches: [],
    unknowns: [],
    coverage: { requested: 1, trusted: 1, ephemeral: 0, unknown: 0 },
    citations: [
      {
        id: 'target-shield-citation',
        sourceId: 'trusted-source',
        url: 'https://example.com/target-shield',
        title: 'Target shield review',
        reviewedAt: '2026-07-24T10:00:00+08:00',
        trust: 'trusted-local'
      }
    ]
  };
  return buildV2PipelineContext({
    correlationId: 'envelope-budget',
    profile: {
      schemaVersion: 2,
      uid: '123456789',
      source: 'merged',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      characters: ABYSS_CHARACTERS,
      coverage: {
        ownedCount: ABYSS_CHARACTERS.length,
        detailedCount: ABYSS_CHARACTERS.length,
        buildCount: ABYSS_CHARACTERS.length,
        statsCount: ABYSS_CHARACTERS.length,
        enkaShowcaseCount: 8,
        missingDetailCount: 0,
        partial: false
      }
    },
    feasibleBaseline: baseline,
    eligibleCharacterIds: selectedIds,
    mechanics: [{ target: '12-1 上半', facts: ['元素盾'], unknowns: [] }],
    interventions: { noBuildChange: true },
    knowledge,
    targetKnowledgeViews: [
      {
        targetKey: '12:1:first',
        knowledge: targetKnowledge
      }
    ]
  });
}

function withKnowledgeFact(
  output: V2ExplainOutput,
  characterId: string
): V2ExplainOutput {
  return {
    explanations: output.explanations.map((item, index) =>
      index === 0
        ? {
            ...item,
            reasonCodes: ['reaction-chain'],
            factRefs: [{ kind: 'knowledge' as const, characterId }]
          }
        : item
    )
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
    | { ok: false; issues: Array<{ code: string; path: Array<string | number>; message: string }> },
  pipelineContext: V2PipelineContext = context(baseline),
  trace?: AgentRunTraceWriter,
  supportsKnowledgeRef?: (
    characterId: string,
    citationId: string,
    archetypeId: string
  ) => boolean,
  onStageStart?: (stage: V2AgentStage) => void
) {
  return runV2AgentPipeline({
    runner,
    context: pipelineContext,
    trace,
    supportsKnowledgeRef,
    onStageStart,
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

function throwingTraceWriter(
  method: keyof AgentRunTraceWriter,
  store = new AgentRunTraceStore()
): AgentRunTraceWriter {
  return new Proxy(store, {
    get(target, property) {
      if (property === method) {
        return () => {
          throw new Error(`trace-writer-${String(method)}-failed`);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as AgentRunTraceWriter;
}

function traceStageStatuses(store: AgentRunTraceStore) {
  return store.latest()?.stages.map(({ stage, status }) => `${stage}:${status}`);
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
      expect.stringContaining(
        baseline.mode === 'spiral-abyss' ? 'CritiqueAgent v3' : 'CritiqueAgent v2'
      ),
      expect.stringContaining(
        baseline.mode === 'spiral-abyss' ? 'RotationCoachAgent v3' : 'RotationCoachAgent v2'
      ),
      expect.stringContaining(
        baseline.mode === 'spiral-abyss' ? 'ExplainAgent v3' : 'ExplainAgent v2'
      )
    ]);
    const composePayload = JSON.parse(runner.calls[0]!.prompt) as Record<string, unknown>;
    expect(JSON.stringify(composePayload)).toContain('"kind":"feasibleBaseline"');
    expect(JSON.stringify(composePayload)).toContain('"missingFields":["talents"]');
    expect(JSON.stringify(composePayload)).toContain('"profileRef":{"uid":"123456789"}');
    expect(JSON.stringify(composePayload)).toContain(
      '"unknowns":[{"id":"gap-1","subjectId":"9999"'
    );
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
  it('compacts a builder-valid context against the complete Compose envelope before sending', async () => {
    const baseline = validAbyssPlan();
    const pipelineContext = envelopeBudgetContext();
    const request = { padding: 'r'.repeat(30_000) };
    expect(Buffer.byteLength(JSON.stringify(pipelineContext), 'utf8')).toBeLessThanOrEqual(
      MAX_AGENT_PAYLOAD_BYTES
    );
    expect(pipelineContext.knowledge.trustedMatches[0]?.factStatements).toHaveLength(32);
    expect(
      Buffer.byteLength(JSON.stringify({ request, context: pipelineContext }), 'utf8')
    ).toBeGreaterThan(MAX_AGENT_PAYLOAD_BYTES);
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);

    const result = await runV2AgentPipeline({
      runner,
      context: pipelineContext,
      sdkOptionsForStage: () => sdkOptions(),
      composer: {
        initialPrompt: JSON.stringify(request),
        systemPrompt: 'composer:near-envelope',
        repairPrompt: 'repair',
        validate: (text) => ({
          ok: true,
          plan: JSON.parse(text) as RecommendationPlan
        })
      },
      invalidIssue: (stage, message) => ({
        code: 'AGENT_OUTPUT_INVALID',
        path: [stage],
        message
      })
    });

    expect(result).toMatchObject({ ok: true });
    expect(runner.calls).toHaveLength(4);
    expect(
      runner.calls.every(
        ({ prompt }) => Buffer.byteLength(prompt, 'utf8') <= MAX_AGENT_PAYLOAD_BYTES
      )
    ).toBe(true);
    const composePayload = JSON.parse(runner.calls[0]!.prompt) as {
      context: V2PipelineContext;
    };
    expect(composePayload.context.knowledge.trustedMatches[0]?.factStatements).toBeUndefined();
    expect(composePayload.context.knowledge.unknowns).toContainEqual(
      expect.objectContaining({ kind: 'payload-truncated' })
    );
    expect(composePayload.context.targetKnowledgeViews).toEqual([
      {
        targetKey: '12:1:first',
        knowledge: expect.objectContaining({
          trustedMatches: [
            expect.objectContaining({
              id: 'target-shield-match',
              citationIds: ['target-shield-citation']
            })
          ],
          citations: [
            expect.objectContaining({
              id: 'target-shield-citation',
              trust: 'trusted-local'
            })
          ]
        })
      }
    ]);
  });

  it('rebudgets the context for a near-limit Repair envelope and invokes the repair runner', async () => {
    const baseline = validAbyssPlan();
    const pipelineContext = envelopeBudgetContext();
    const invalid = { padding: 'p'.repeat(25_000) };
    const issues = [{ code: 'PLAN_SCHEMA_INVALID', path: [], message: '结构无效' }];
    expect(
      Buffer.byteLength(
        JSON.stringify({
          instruction: '只修复具体 issue，返回完整方案。',
          issues,
          previousPlan: invalid,
          context: pipelineContext
        }),
        'utf8'
      )
    ).toBeGreaterThan(MAX_AGENT_PAYLOAD_BYTES);
    const runner = new StageRunner([
      invalid,
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);

    const result = await run(
      runner,
      baseline,
      (text) =>
        (JSON.parse(text) as { padding?: string }).padding === undefined
          ? { ok: true, plan: JSON.parse(text) as RecommendationPlan }
          : { ok: false, issues },
      pipelineContext
    );

    expect(result).toMatchObject({ ok: true, repairs: 1 });
    expect(runner.calls).toHaveLength(5);
    expect(Buffer.byteLength(runner.calls[1]!.prompt, 'utf8')).toBeLessThanOrEqual(
      MAX_AGENT_PAYLOAD_BYTES
    );
    const repairPayload = JSON.parse(runner.calls[1]!.prompt) as {
      context: V2PipelineContext;
    };
    expect(repairPayload.context.knowledge.trustedMatches[0]?.factStatements).toBeUndefined();
  });

  it('repairs an oversized incomplete JSON result using only a bounded raw preview', async () => {
    const baseline = validAbyssPlan();
    const outputs: unknown[] = [
      `{"mode":"spiral-abyss","warnings":["${'w'.repeat(55_000)}`,
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ];
    const calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];
    const runner = {
      async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
        calls.push({ prompt, options });
        const output = outputs.shift();
        yield {
          type: 'result',
          subtype: 'success',
          result: typeof output === 'string' ? output : JSON.stringify(output),
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.01
        };
      }
    };

    const result = await run(
      runner as StageRunner,
      baseline,
      (text) => {
        try {
          return { ok: true, plan: JSON.parse(text) as RecommendationPlan };
        } catch {
          return {
            ok: false,
            issues: [{ code: 'PLAN_SCHEMA_INVALID', path: [], message: '结构无效' }]
          };
        }
      }
    );

    expect(result).toMatchObject({ ok: true, repairs: 1 });
    expect(Buffer.byteLength(calls[1]!.prompt, 'utf8')).toBeLessThanOrEqual(
      MAX_AGENT_PAYLOAD_BYTES
    );
    const repairPayload = JSON.parse(calls[1]!.prompt) as {
      previousPlan: {
        invalidJson: boolean;
        rawPreview: string;
        rawBytes: number;
        truncated: boolean;
      };
    };
    expect(repairPayload.previousPlan).toMatchObject({
      invalidJson: true,
      rawBytes: expect.any(Number),
      truncated: true
    });
    expect(repairPayload.previousPlan.rawPreview.length).toBeLessThanOrEqual(2_048);
  });

  it('rebudgets the context for a near-limit strict-stage envelope before Critique', async () => {
    const pipelineContext = envelopeBudgetContext();
    const baseline = validAbyssPlan({ warnings: ['w'.repeat(30_000)] });
    expect(
      Buffer.byteLength(
        JSON.stringify({ stage: 'critique', context: pipelineContext, plan: baseline }),
        'utf8'
      )
    ).toBeGreaterThan(MAX_AGENT_PAYLOAD_BYTES);
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      pipelineContext
    );

    expect(result).toMatchObject({ ok: true });
    expect(runner.calls).toHaveLength(4);
    expect(Buffer.byteLength(runner.calls[1]!.prompt, 'utf8')).toBeLessThanOrEqual(
      MAX_AGENT_PAYLOAD_BYTES
    );
    const critiquePayload = JSON.parse(runner.calls[1]!.prompt) as {
      context: V2PipelineContext;
    };
    expect(critiquePayload.context.knowledge.trustedMatches[0]?.factStatements).toBeUndefined();
  });

  it('fails Composer validation closed when its bounded tool audit was truncated', async () => {
    const baseline = validAbyssPlan();
    const calls: string[] = [];
    const runner = {
      async *run(prompt: string): AsyncIterable<unknown> {
        calls.push(prompt);
        const tools = Array.from({ length: 65 }, (_, index) => ({
          type: 'tool_use',
          id: `tool-${index}`,
          name: 'read_profile_cache',
          input: { characterIds: ['1001'] }
        }));
        yield { type: 'assistant', message: { content: tools } };
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
          result: JSON.stringify(baseline),
          usage: {}
        };
      }
    };
    const validate = vi.fn((text: string) => ({
      ok: true as const,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    const result = await runV2AgentPipeline({
      runner,
      context: context(baseline),
      sdkOptionsForStage: () => sdkOptions(),
      composer: {
        initialPrompt: '{}',
        systemPrompt: 'composer:truncated-tools',
        repairPrompt: 'repair',
        validate
      },
      invalidIssue: (stage, message) => ({
        code: 'AGENT_OUTPUT_INVALID',
        path: [stage],
        message
      })
    });

    expect(result).toMatchObject({
      ok: false,
      repairs: 2,
      issues: [
        expect.objectContaining({
          message: expect.stringContaining('tool audit was truncated')
        })
      ]
    });
    expect(calls).toHaveLength(3);
    expect(validate).not.toHaveBeenCalled();
  });

  it('fails closed before the runner when the final Compose prompt exceeds 48 KiB UTF-8', async () => {
    const baseline = validAbyssPlan();
    const runner = new StageRunner([baseline]);
    const result = await runV2AgentPipeline({
      runner,
      context: context(baseline),
      sdkOptionsForStage: () => sdkOptions(),
      composer: {
        initialPrompt: JSON.stringify({ padding: '界'.repeat(17_000) }),
        systemPrompt: 'composer:oversized',
        repairPrompt: 'repair',
        validate: (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan })
      },
      invalidIssue: (stage, message) => ({
        code: 'AGENT_OUTPUT_INVALID',
        path: [stage],
        message
      })
    });

    expect(runner.calls).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['compose'],
          message: expect.stringContaining('AGENT_PAYLOAD_TOO_LARGE')
        })
      ]
    });
  });

  it('fails closed before a Repair send when the complete repair prompt exceeds 48 KiB', async () => {
    const baseline = validAbyssPlan();
    const oversizedInvalid = { padding: '界'.repeat(17_000) };
    const runner = new StageRunner([oversizedInvalid, baseline]);
    const result = await run(runner, baseline, () => ({
      ok: false,
      issues: [{ code: 'PLAN_SCHEMA_INVALID', path: [], message: '结构无效' }]
    }));

    expect(runner.calls).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['repair-1'],
          message: expect.stringContaining('AGENT_PAYLOAD_TOO_LARGE')
        })
      ]
    });
  });

  it('fails closed before a strict-stage send when the complete plan prompt exceeds 48 KiB', async () => {
    const baseline = validAbyssPlan({ warnings: ['界'.repeat(17_000)] });
    const runner = new StageRunner([baseline]);
    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(runner.calls).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['critique'],
          message: expect.stringContaining('AGENT_PAYLOAD_TOO_LARGE')
        })
      ]
    });
  });

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
      expect.stringContaining('CritiqueAgent v3'),
      expect.stringContaining('repair'),
      expect.stringContaining('CritiqueAgent v3'),
      expect.stringContaining('RotationCoachAgent v3'),
      expect.stringContaining('ExplainAgent v3')
    ]);
    expect(runner.calls[1]!.prompt).toContain('PLAN_SCHEMA_INVALID');
    expect(runner.calls[3]!.prompt).toContain('rotation-fragile');
  });

  it('reuses audited Composer tool evidence for a text-only repair attempt', async () => {
    const baseline = validAbyssPlan();
    const outputs = [
      baseline,
      {
        decision: 'repair',
        issues: [
          {
            code: 'explicit-plan-risk',
            severity: 'soft',
            target: { kind: 'abyss-team', half: 'first' },
            message: 'Make the existing warning explicit.'
          }
        ]
      },
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ];
    const calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];
    const runner = {
      async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
        calls.push({ prompt, options });
        if (calls.length === 1) {
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'profile-evidence',
                  name: 'mcp__genshin__read_profile_cache',
                  input: { characterIds: ['1001'] }
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
                  tool_use_id: 'profile-evidence',
                  is_error: false,
                  content: 'ok'
                }
              ]
            }
          };
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: JSON.stringify(outputs.shift()),
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.01
        };
      }
    };
    const observedEvidenceCounts: number[] = [];

    const result = await runV2AgentPipeline({
      runner,
      context: context(baseline),
      sdkOptionsForStage: () => sdkOptions(),
      composer: {
        initialPrompt: '{}',
        systemPrompt: 'composer:reusable-evidence',
        repairPrompt: 'repair',
        reuseToolEvidenceOnToolFreeRepair: true,
        validate: (text, tools) => {
          observedEvidenceCounts.push(tools.length);
          return tools.some(({ name, succeeded }) =>
            name === 'mcp__genshin__read_profile_cache' && succeeded
          )
            ? { ok: true as const, plan: JSON.parse(text) as RecommendationPlan }
            : {
                ok: false as const,
                issues: [
                  {
                    code: 'TOOL_REQUIREMENT_FAILED',
                    path: ['tools'],
                    message: 'Missing prior profile evidence.'
                  }
                ]
              };
        }
      },
      invalidIssue: (stage, message) => ({
        code: 'AGENT_OUTPUT_INVALID',
        path: [stage],
        message
      })
    });

    expect(result).toMatchObject({ ok: true, repairs: 1 });
    expect(calls).toHaveLength(6);
    expect(observedEvidenceCounts).toEqual([1, 1]);
  });

  it('keeps unresolved soft critique issues after one repair and continues to Rotation/Explain', async () => {
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
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);
    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(result).toMatchObject({
      ok: true,
      repairs: 1,
      critique: {
        decision: 'accept',
        issues: [expect.objectContaining({ code: 'risk-two' })]
      }
    });
    expect(runner.calls).toHaveLength(6);
    expect(
      runner.calls.some(({ options }) => options.systemPrompt.includes('RotationCoachAgent'))
    ).toBe(true);
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
    const explanation = explainOutput(baseline);
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

  it.each(['stats', 'build'] as const)(
    'rejects a profile %s reference when that field is absent from detailedProfiles',
    async (field) => {
      const baseline = validAbyssPlan();
      const pipelineContext = structuredClone(context(baseline));
      const detailed = pipelineContext.profile.detailedProfiles[0]!;
      if (field === 'stats') delete detailed.stats;
      else {
        delete detailed.weapon;
        delete detailed.artifactSummary;
        delete detailed.talents;
        delete detailed.stats;
      }
      const characterId = String(detailed.id);
      const explanation = explainOutput(baseline);
      explanation.explanations = explanation.explanations.map((item, index) =>
        index === 0
          ? {
              ...item,
              reasonCodes: ['energy-cycle'],
              factRefs: [{ kind: 'profile', characterId, field }]
            }
          : item
      );
      const runner = new StageRunner([
        baseline,
        { decision: 'accept', issues: [] },
        rotationOutput(baseline),
        explanation
      ]);
      const result = await run(
        runner,
        baseline,
        (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
        pipelineContext
      );

      expect(result).toMatchObject({
        ok: false,
        issues: [
          expect.objectContaining({
            path: ['explain'],
            message: expect.stringContaining(
              `profile field is unavailable: ${characterId}:${field}`
            )
          })
        ]
      });
    }
  );

  it('rejects a knowledge reference explicitly marked unknown in the bounded context', async () => {
    const baseline = validAbyssPlan();
    const pipelineContext = structuredClone(context(baseline));
    const characterId = String(pipelineContext.profile.detailedProfiles[0]!.id);
    pipelineContext.knowledge = buildUnknownKnowledgeContext(
      pipelineContext.knowledge.knowledgeVersion,
      [characterId]
    );
    const explanation = explainOutput(baseline);
    explanation.explanations = explanation.explanations.map((item, index) =>
      index === 0
        ? {
            ...item,
            reasonCodes: ['reaction-chain'],
            factRefs: [{ kind: 'knowledge', characterId }]
          }
        : item
    );
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explanation
    ]);
    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      pipelineContext
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['explain'],
          message: expect.stringContaining(`knowledge is explicitly unknown: ${characterId}`)
        })
      ]
    });
  });

  it('rejects a knowledge reference omitted from the knowledge packet', async () => {
    const baseline = validAbyssPlan();
    const pipelineContext = structuredClone(context(baseline));
    const characterId = String(pipelineContext.profile.detailedProfiles[0]!.id);
    const explanation = explainOutput(baseline);
    explanation.explanations = explanation.explanations.map((item, index) =>
      index === 0
        ? {
            ...item,
            reasonCodes: ['reaction-chain'],
            factRefs: [{ kind: 'knowledge', characterId }]
          }
        : item
    );
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explanation
    ]);

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      pipelineContext
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['explain'],
          message: expect.stringContaining('positive cited match')
        })
      ]
    });
  });

  it('accepts a knowledge reference backed by a positive trusted cited match', async () => {
    const baseline = validAbyssPlan();
    const pipelineContext = structuredClone(context(baseline));
    const characterId = String(pipelineContext.profile.detailedProfiles[0]!.id);
    pipelineContext.knowledge = {
      knowledgeVersion: 'trusted-test',
      buildInterpretations: [
        {
          characterId,
          archetypeId: 'tested-role',
          confidence: 'high',
          candidateArchetypeIds: ['tested-role'],
          contextRequired: false,
          matchedSignals: ['current-build-match'],
          conflictingSignals: [],
          currentBuildUsable: true,
          adjustment: 'none',
          unknowns: []
        }
      ],
      trustedMatches: [
        {
          id: 'trusted-character',
          characterId,
          archetypeId: 'tested-role',
          summary: 'Trusted character facts are available.',
          citationIds: ['trusted-citation']
        }
      ],
      ephemeralMatches: [],
      unknowns: [],
      coverage: { requested: 1, trusted: 1, ephemeral: 0, unknown: 0 },
      citations: [
        {
          id: 'trusted-citation',
          sourceId: 'trusted-source',
          url: 'https://example.com/trusted-character',
          title: 'Trusted character review',
          reviewedAt: '2026-07-24T10:00:00+08:00',
          trust: 'trusted-local'
        }
      ]
    };
    const explanation = explainOutput(baseline);
    explanation.explanations = explanation.explanations.map((item, index) =>
      index === 0
        ? {
            ...item,
            reasonCodes: ['reaction-chain'],
            factRefs: [{ kind: 'knowledge', characterId }]
          }
        : item
    );
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explanation
    ]);

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      pipelineContext
    );

    expect(result).toMatchObject({ ok: true });
  });

  it('rejects cross-character citation substitution for an actual knowledge fact reference', async () => {
    const baseline = validAbyssPlan();
    const pipelineContext = structuredClone(context(baseline));
    const characterId = String(pipelineContext.profile.detailedProfiles[0]!.id);
    pipelineContext.knowledge = trustedKnowledgePacket(characterId);
    const explanation = withKnowledgeFact(explainOutput(baseline), characterId);
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explanation
    ]);

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      pipelineContext,
      undefined,
      (candidateId, citationId, archetypeId) =>
        candidateId === 'different-character' &&
        citationId === 'trusted-citation' &&
        archetypeId === 'tested-role'
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['explain'],
          message: expect.stringContaining('positive cited match')
        })
      ]
    });
  });

  it('rejects a cited positive match when the current build conflicts with its archetype', async () => {
    const baseline = validAbyssPlan();
    const pipelineContext = structuredClone(context(baseline));
    const characterId = String(pipelineContext.profile.detailedProfiles[0]!.id);
    pipelineContext.knowledge = trustedKnowledgePacket(characterId);
    pipelineContext.knowledge.buildInterpretations[0]!.currentBuildUsable = false;
    pipelineContext.knowledge.buildInterpretations[0]!.adjustment = 'required';
    pipelineContext.knowledge.buildInterpretations[0]!.conflictingSignals = [
      'build-role-conflict'
    ];
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      withKnowledgeFact(explainOutput(baseline), characterId)
    ]);

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      pipelineContext
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['explain'],
          message: expect.stringContaining('positive cited match')
        })
      ]
    });
  });

  it('accepts a runtime-remapped ephemeral-web match for the same character', async () => {
    const baseline = validAbyssPlan();
    const pipelineContext = structuredClone(context(baseline));
    const characterId = String(pipelineContext.profile.detailedProfiles[0]!.id);
    pipelineContext.knowledge = trustedKnowledgePacket(characterId);
    pipelineContext.knowledge.trustedMatches = [];
    pipelineContext.knowledge.ephemeralMatches = [
      {
        id: 'ephemeral-character',
        subjectId: characterId,
        summary: 'Runtime guide evidence for the same character.',
        citationIds: ['ephemeral-citation']
      }
    ];
    pipelineContext.knowledge.citations = [
      {
        id: 'ephemeral-citation',
        sourceId: 'reviewed-source',
        url: 'https://example.com/ephemeral-character',
        title: 'Runtime guide',
        reviewedAt: '2026-07-24T10:00:00+08:00',
        trust: 'ephemeral-web'
      }
    ];
    pipelineContext.knowledge.coverage = {
      requested: 1,
      trusted: 0,
      ephemeral: 1,
      unknown: 0
    };
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      withKnowledgeFact(explainOutput(baseline), characterId)
    ]);

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      pipelineContext
    );

    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    'build-role-conflict',
    'reaction-ownership-conflict',
    'field-time-conflict',
    'energy-facts-missing',
    'enemy-immunity-conflict',
    'survival-insufficient'
  ])('routes a real Critique %s issue through a bounded repair', async (code) => {
    const baseline = validAbyssPlan();
    const target = targets(baseline);
    const runner = new StageRunner([
      baseline,
      {
        decision: 'repair',
        issues: [
          {
            code,
            severity: 'soft',
            target: target.critique,
            message: `Critique detected ${code}.`
          }
        ]
      },
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);

    const result = await run(runner, baseline, (text) => ({
      ok: true,
      plan: JSON.parse(text) as RecommendationPlan
    }));

    expect(result).toMatchObject({ ok: true, repairs: 1 });
    expect(runner.calls).toHaveLength(6);
    expect(runner.calls[2]!.prompt).toContain(code);
  });

  it('rejects a reason code that has no compatible supporting fact reference', async () => {
    const baseline = validAbyssPlan();
    const explanation = explainOutput(baseline);
    explanation.explanations = explanation.explanations.map((item, index) =>
      index === 0
        ? {
            ...item,
            reasonCodes: ['mechanic-response'],
            factRefs: [{ kind: 'plan', field: 'validated-target' }]
          }
        : item
    );
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
          message: expect.stringContaining('reason lacks a compatible fact reference')
        })
      ]
    });
  });
});

describe('V2 agent pipeline trace observer', () => {
  it.each(['start', 'startStage', 'completeStage', 'skipStage', 'finish', 'latest'] as const)(
    'keeps a successful pipeline unchanged when trace writer.%s throws',
    async (method) => {
      const baseline = validAbyssPlan();
      const runner = new StageRunner([
        baseline,
        { decision: 'accept', issues: [] },
        rotationOutput(baseline),
        explainOutput(baseline)
      ]);

      const result = await run(
        runner,
        baseline,
        (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
        context(baseline),
        throwingTraceWriter(method)
      );

      expect(result).toMatchObject({ ok: true, repairs: 0 });
    }
  );

  it('keeps a validation result unchanged when trace writer.failStage throws', async () => {
    const baseline = validAbyssPlan();
    const result = await run(
      new StageRunner([baseline, 'not-json']),
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      context(baseline),
      throwingTraceWriter('failStage')
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: ['critique'] })]
    });
  });

  it('preserves the SDK option error when trace writer.start also throws', async () => {
    const baseline = validAbyssPlan();
    const sdkError = new Error('original-sdk-options-error');

    await expect(
      runV2AgentPipeline({
        runner: new StageRunner([]),
        context: context(baseline),
        trace: throwingTraceWriter('start'),
        sdkOptionsForStage: () => {
          throw sdkError;
        },
        composer: {
          initialPrompt: '{}',
          systemPrompt: 'composer',
          repairPrompt: 'repair',
          validate: () => {
            throw new Error('unreachable');
          }
        },
        invalidIssue: (stage, message) => ({
          code: 'AGENT_OUTPUT_INVALID',
          path: [stage],
          message
        })
      })
    ).rejects.toBe(sdkError);
  });

  it('records safe raw outputs, true stage usage, skipped repairs, and a completed terminal run', async () => {
    const baseline = validAbyssPlan();
    const runner = new StageRunner([
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);
    const trace = new AgentRunTraceStore();

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      context(baseline),
      trace
    );

    expect(result.ok).toBe(true);
    expect(trace.latest()).toMatchObject({
      correlationId: 'pipeline-correlation',
      model: 'test-model',
      status: 'completed',
      finalSource: 'smart-service',
      knowledge: { trusted: 0, ephemeral: 0, unknown: 1, searched: false },
      usage: { inputTokens: 40, outputTokens: 20 }
    });
    expect(traceStageStatuses(trace)).toEqual([
      'compose:completed',
      'critique:completed',
      'rotation:completed',
      'explain:completed',
      'repair-1:skipped',
      'repair-2:skipped'
    ]);
    expect(trace.latest()?.stages.find(({ stage }) => stage === 'compose')).toMatchObject({
      rawOutput: JSON.stringify(baseline),
      usage: { inputTokens: 10, outputTokens: 5 }
    });
  });

  it('distinguishes repair and repeated critique attempts in chronological order', async () => {
    const baseline = validAbyssPlan();
    const target = targets(baseline);
    const runner = new StageRunner([
      baseline,
      {
        decision: 'repair',
        issues: [
          {
            code: 'fragile',
            severity: 'soft',
            target: target.critique,
            message: '需要修复'
          }
        ]
      },
      baseline,
      { decision: 'accept', issues: [] },
      rotationOutput(baseline),
      explainOutput(baseline)
    ]);
    const trace = new AgentRunTraceStore();

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      context(baseline),
      trace
    );

    expect(result).toMatchObject({ ok: true, repairs: 1 });
    expect(traceStageStatuses(trace)).toEqual([
      'compose:completed',
      'critique:completed',
      'repair-1:completed',
      'critique:completed',
      'rotation:completed',
      'explain:completed',
      'repair-2:skipped'
    ]);
  });

  it('announces every stage before its runner starts', async () => {
    const baseline = validAbyssPlan();
    const events: string[] = [];
    const runner = new StageRunner(
      [
        baseline,
        { decision: 'accept', issues: [] },
        rotationOutput(baseline),
        explainOutput(baseline)
      ],
      (options) => {
        const stage = options.systemPrompt.includes('CritiqueAgent')
          ? 'critique'
          : options.systemPrompt.includes('RotationCoachAgent')
            ? 'rotation'
            : options.systemPrompt.includes('ExplainAgent')
              ? 'explain'
              : 'compose';
        events.push(`run:${stage}`);
      }
    );

    await run(
      runner,
      baseline,
      (text) => ({
        ok: true,
        plan: JSON.parse(text) as RecommendationPlan
      }),
      context(baseline),
      undefined,
      undefined,
      (stage) => events.push(`start:${stage}`)
    );

    expect(events).toEqual([
      'start:compose',
      'run:compose',
      'start:critique',
      'run:critique',
      'start:rotation',
      'run:rotation',
      'start:explain',
      'run:explain'
    ]);
    expect(runner.calls[0]!.options.outputFormat).toBeUndefined();
    for (const call of runner.calls.slice(1)) {
      expect(call.options).toMatchObject({
        effort: 'low'
      });
      expect(call.options.outputFormat).toBeUndefined();
    }
  });

  it('records every invalid composer raw output and closes exhausted repairs as failed', async () => {
    const baseline = validAbyssPlan();
    const runner = new StageRunner(['model raw text', 'repair raw one', 'repair raw two']);
    const trace = new AgentRunTraceStore();

    const result = await run(
      runner,
      baseline,
      () => ({
        ok: false,
        issues: [{ code: 'PLAN_SCHEMA_INVALID', path: [], message: 'invalid plan schema' }]
      }),
      context(baseline),
      trace
    );

    expect(result).toMatchObject({ ok: false, repairs: 2 });
    expect(trace.latest()).toMatchObject({
      status: 'failed',
      finalSource: 'blocked',
      failure: { code: 'AGENT_OUTPUT_INVALID' }
    });
    expect(trace.latest()?.stages.slice(0, 3)).toMatchObject([
      { stage: 'compose', status: 'failed', rawOutput: '"model raw text"' },
      { stage: 'repair-1', status: 'failed', rawOutput: '"repair raw one"' },
      { stage: 'repair-2', status: 'failed', rawOutput: '"repair raw two"' }
    ]);
    expect(traceStageStatuses(trace)?.slice(3)).toEqual([
      'critique:skipped',
      'rotation:skipped',
      'explain:skipped'
    ]);
  });

  it('uses a distinct tool-requirement failure code for composer tool validation', async () => {
    const baseline = validAbyssPlan();
    const runner = new StageRunner([baseline, baseline, baseline]);
    const trace = new AgentRunTraceStore();

    await run(
      runner,
      baseline,
      () => ({
        ok: false,
        issues: [
          {
            code: 'AGENT_OUTPUT_INVALID',
            path: ['tools'],
            message: 'required tools missing'
          }
        ]
      }),
      context(baseline),
      trace
    );

    expect(trace.latest()?.stages.slice(0, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'failed',
          failure: expect.objectContaining({ code: 'TOOL_REQUIREMENT_FAILED' })
        })
      ])
    );
    expect(trace.latest()).toMatchObject({
      status: 'failed',
      failure: { code: 'TOOL_REQUIREMENT_FAILED' }
    });
  });

  it('preserves validator exception semantics while closing a redacted failed trace', async () => {
    const baseline = validAbyssPlan();
    const runner = new StageRunner([baseline]);
    const trace = new AgentRunTraceStore();

    await expect(
      runV2AgentPipeline({
        runner,
        context: context(baseline),
        trace,
        sdkOptionsForStage: () => sdkOptions(),
        composer: {
          initialPrompt: '{}',
          systemPrompt: 'composer',
          repairPrompt: 'repair',
          validate: () => {
            throw new Error('validator cause apiKey=must-not-leak');
          }
        },
        invalidIssue: (stage, message) => ({
          code: 'AGENT_OUTPUT_INVALID',
          path: [stage],
          message
        })
      })
    ).rejects.toThrow('validator cause');
    expect(trace.latest()).toMatchObject({
      status: 'failed',
      failure: { code: 'VALIDATION_FAILED' }
    });
    expect(trace.latest()?.stages[0]).toMatchObject({
      stage: 'compose',
      status: 'failed',
      failure: { code: 'VALIDATION_FAILED' }
    });
    expect(JSON.stringify(trace.latest())).not.toContain('must-not-leak');
  });

  it('classifies strict-stage input schema errors as local validation failures', async () => {
    const baseline = validAbyssPlan();
    const invalidPlan = { ...baseline, scenarioId: '' } as RecommendationPlan;
    const trace = new AgentRunTraceStore();

    await expect(
      run(
        new StageRunner([baseline]),
        baseline,
        () => ({ ok: true, plan: invalidPlan }),
        context(baseline),
        trace
      )
    ).rejects.toMatchObject({ name: 'ZodError' });

    expect(trace.latest()).toMatchObject({
      status: 'failed',
      failure: { code: 'VALIDATION_FAILED' }
    });
    expect(trace.latest()?.stages.find(({ stage }) => stage === 'critique')).toMatchObject({
      status: 'failed',
      failure: { code: 'VALIDATION_FAILED' }
    });
  });

  it('classifies repair payload serialization errors as local validation failures', async () => {
    const baseline = validAbyssPlan();
    const trace = new AgentRunTraceStore();
    const circularIssue: Record<string, unknown> = {
      code: 'PLAN_SCHEMA_INVALID',
      path: [],
      message: 'repair required'
    };
    circularIssue['details'] = circularIssue;

    await expect(
      run(
        new StageRunner([baseline]),
        baseline,
        () => ({
          ok: false,
          issues: [circularIssue as never]
        }),
        context(baseline),
        trace
      )
    ).rejects.toThrow();

    expect(trace.latest()).toMatchObject({
      status: 'failed',
      failure: { code: 'VALIDATION_FAILED' }
    });
    expect(trace.latest()?.stages.find(({ stage }) => stage === 'repair-1')).toMatchObject({
      status: 'failed',
      failure: { code: 'VALIDATION_FAILED' }
    });
  });

  it('records strict JSON/schema failure raw text and marks later stages skipped', async () => {
    const baseline = validAbyssPlan();
    const runner = new StageRunner([baseline, 'not-json']);
    const trace = new AgentRunTraceStore();

    const result = await run(
      runner,
      baseline,
      (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
      context(baseline),
      trace
    );

    expect(result).toMatchObject({ ok: false });
    expect(trace.latest()?.stages.find(({ stage }) => stage === 'critique')).toMatchObject({
      status: 'failed',
      rawOutput: '"not-json"',
      failure: { code: 'AGENT_OUTPUT_INVALID' }
    });
    expect(traceStageStatuses(trace)?.slice(-2)).toEqual(['rotation:skipped', 'explain:skipped']);
    expect(trace.latest()).toMatchObject({
      status: 'failed',
      finalSource: 'blocked',
      failure: { code: 'AGENT_OUTPUT_INVALID' }
    });
  });

  it('redacts credentials supplied by a later stage instead of only the compose stage', async () => {
    const baseline = validAbyssPlan();
    const runner = new StageRunner([baseline, 'strict-stage-secret']);
    const trace = new AgentRunTraceStore();

    await runV2AgentPipeline({
      runner,
      context: context(baseline),
      trace,
      sdkOptionsForStage: (stage) => ({
        ...sdkOptions(),
        apiKey: stage === 'critique' ? 'strict-stage-secret' : 'compose-stage-secret'
      }),
      composer: {
        initialPrompt: '{}',
        systemPrompt: 'composer',
        repairPrompt: 'repair',
        validate: (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan })
      },
      invalidIssue: (stage, message) => ({
        code: 'AGENT_OUTPUT_INVALID',
        path: [stage],
        message
      })
    });

    const serialized = JSON.stringify(trace.latest());
    expect(serialized).not.toContain('strict-stage-secret');
    expect(serialized).not.toContain('compose-stage-secret');
    expect(serialized).toContain('[REDACTED]');
  });

  it('maps SDK stream errors and cancellation to stable terminal trace failures', async () => {
    const baseline = validAbyssPlan();
    const streamTrace = new AgentRunTraceStore();
    const streamRunner = {
      async *run(): AsyncIterable<unknown> {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '{"partial":"safe-progress"}' }]
          }
        };
        yield await Promise.reject(new Error('provider cause with apiKey=must-not-leak'));
      }
    };

    await expect(
      runV2AgentPipeline({
        runner: streamRunner,
        context: context(baseline),
        trace: streamTrace,
        sdkOptionsForStage: () => sdkOptions(),
        composer: {
          initialPrompt: '{}',
          systemPrompt: 'composer',
          repairPrompt: 'repair',
          validate: (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan })
        },
        invalidIssue: (stage, message) => ({
          code: 'AGENT_OUTPUT_INVALID',
          path: [stage],
          message
        })
      })
    ).rejects.toMatchObject({ code: 'AGENT_TURN_STREAM_FAILED' });
    expect(streamTrace.latest()).toMatchObject({
      status: 'failed',
      failure: { code: 'PROVIDER_ERROR' }
    });
    expect(streamTrace.latest()?.stages[0]).toMatchObject({
      stage: 'compose',
      status: 'failed',
      rawOutput: '{"partial":"safe-progress"}',
      failure: { code: 'PROVIDER_ERROR' }
    });
    expect(JSON.stringify(streamTrace.latest())).not.toContain('must-not-leak');

    const cancelledTrace = new AgentRunTraceStore();
    const cancelledOptions = sdkOptions();
    cancelledOptions.abortController.abort();
    await expect(
      runV2AgentPipeline({
        runner: new StageRunner([]),
        context: context(baseline),
        trace: cancelledTrace,
        sdkOptionsForStage: () => cancelledOptions,
        composer: {
          initialPrompt: '{}',
          systemPrompt: 'composer',
          repairPrompt: 'repair',
          validate: (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan })
        },
        invalidIssue: (stage, message) => ({
          code: 'AGENT_OUTPUT_INVALID',
          path: [stage],
          message
        })
      })
    ).rejects.toMatchObject({ code: 'AGENT_TURN_CANCELLED' });
    expect(cancelledTrace.latest()).toMatchObject({
      status: 'failed',
      failure: { code: 'AGENT_ABORTED' }
    });
    expect(cancelledTrace.latest()?.stages[0]).toMatchObject({
      stage: 'compose',
      status: 'failed',
      failure: { code: 'AGENT_ABORTED' }
    });
  });

  it('preserves only safe SDK and HTTP diagnostics from a natural strict-stage provider failure', async () => {
    const baseline = validAbyssPlan();
    const trace = new AgentRunTraceStore();

    await expect(
      run(
        new StrictStageProviderFailureRunner(baseline),
        baseline,
        (text) => ({ ok: true, plan: JSON.parse(text) as RecommendationPlan }),
        context(baseline),
        trace
      )
    ).rejects.toMatchObject({ code: 'AGENT_TURN_RESULT_ERROR' });

    expect(trace.latest()).toMatchObject({
      status: 'failed',
      finalSource: 'blocked',
      failure: {
        code: 'PROVIDER_ERROR',
        details: {
          sdkCode: 'AGENT_TURN_RESULT_ERROR',
          httpStatus: '429'
        }
      }
    });
    expect(trace.latest()?.stages.find(({ stage }) => stage === 'critique')).toMatchObject({
      status: 'failed',
      failure: {
        code: 'PROVIDER_ERROR',
        details: {
          sdkCode: 'AGENT_TURN_RESULT_ERROR',
          httpStatus: '429'
        }
      }
    });
    expect(JSON.stringify(trace.latest())).not.toMatch(
      /TOP-SECRET-PROVIDER-BODY|PRIVATE-PROFILE-PROMPT/u
    );
  });

  it.each([
    {
      stage: 'compose',
      outputs: [],
      validate: () => {
        throw new Error('compose validator should not run');
      }
    },
    {
      stage: 'repair-1',
      outputs: [validAbyssPlan()],
      validate: () => ({
        ok: false as const,
        issues: [{ code: 'PLAN_SCHEMA_INVALID', path: [], message: 'repair required' }]
      })
    },
    {
      stage: 'critique',
      outputs: [validAbyssPlan()],
      validate: (text: string) => ({
        ok: true as const,
        plan: JSON.parse(text) as RecommendationPlan
      })
    },
    {
      stage: 'rotation',
      outputs: [validAbyssPlan(), { decision: 'accept', issues: [] }],
      validate: (text: string) => ({
        ok: true as const,
        plan: JSON.parse(text) as RecommendationPlan
      })
    },
    {
      stage: 'explain',
      outputs: [
        validAbyssPlan(),
        { decision: 'accept', issues: [] },
        rotationOutput(validAbyssPlan())
      ],
      validate: (text: string) => ({
        ok: true as const,
        plan: JSON.parse(text) as RecommendationPlan
      })
    }
  ] satisfies Array<{
    stage: V2AgentStage;
    outputs: unknown[];
    validate: (text: string) =>
      | { ok: true; plan: RecommendationPlan }
      | {
          ok: false;
          issues: Array<{ code: string; path: Array<string | number>; message: string }>;
        };
  }>)(
    'closes the trace when $stage SDK option preparation throws',
    async ({ stage: failingStage, outputs, validate }) => {
      const baseline = validAbyssPlan();
      const trace = new AgentRunTraceStore();
      const failure = new Error(`sdk-options-${failingStage}-must-not-leak`);

      await expect(
        runV2AgentPipeline({
          runner: new StageRunner(outputs),
          context: context(baseline),
          trace,
          sdkOptionsForStage: (stage) => {
            if (stage === failingStage) throw failure;
            return sdkOptions();
          },
          composer: {
            initialPrompt: '{}',
            systemPrompt: 'composer',
            repairPrompt: 'repair',
            validate
          },
          invalidIssue: (stage, message) => ({
            code: 'AGENT_OUTPUT_INVALID',
            path: [stage],
            message
          })
        })
      ).rejects.toBe(failure);

      const latest = trace.latest();
      expect(latest).toMatchObject({
        status: 'failed',
        finalSource: 'blocked',
        failure: { code: 'SDK_START_FAILED' }
      });
      expect(latest?.stages.find(({ stage }) => stage === failingStage)).toMatchObject({
        stage: failingStage,
        status: 'failed',
        failure: { code: 'SDK_START_FAILED' }
      });
      const failedIndex = latest?.stages.findIndex(({ stage }) => stage === failingStage) ?? -1;
      expect(
        latest?.stages
          .slice(failedIndex + 1)
          .filter(({ stage: candidate }) => candidate !== failingStage)
          .every(({ status }) => status === 'skipped')
      ).toBe(true);
      expect(JSON.stringify(latest)).not.toContain('must-not-leak');
    }
  );
});
