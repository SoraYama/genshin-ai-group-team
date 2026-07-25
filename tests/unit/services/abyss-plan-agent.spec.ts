import { describe, expect, it } from 'vitest';

import { AbyssPlanAgent } from '../../../src/main/services/abyss-plan-agent.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import { buildV2PipelineContext } from '../../../src/main/services/v2-agent-context.js';
import { AgentRunTraceStore } from '../../../src/main/services/agent-run-trace-store.js';
import type { KnowledgeContextPacket } from '../../../src/shared/advisor-knowledge.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario,
  validAbyssPlan
} from './abyss-test-fixtures.js';

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
    private readonly addAssignments = true
  ) {}

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    if (options.systemPrompt.includes('CritiqueAgent v3')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({ decision: 'accept', issues: [] })
      };
      return;
    }
    if (options.systemPrompt.includes('RotationCoachAgent v3')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          rotations: [
            directive({ kind: 'abyss-team', half: 'first' }),
            directive({ kind: 'abyss-team', half: 'second' })
          ]
        })
      };
      return;
    }
    if (options.systemPrompt.includes('ExplainAgent v3')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          explanations: [
            ...[1, 2].flatMap((chamber) =>
              (['first', 'second'] as const).map((half) =>
                directive({ kind: 'abyss-chamber', floor: 12, chamber, half })
              )
            )
          ]
        })
      };
      return;
    }
    const payload = JSON.parse(prompt) as {
      context: { profileRef: { uid: string } };
    };
    const nextPlan = this.outputs[0] as {
      firstHalfTeam?: { characterIds?: unknown };
      secondHalfTeam?: { characterIds?: unknown };
    };
    const selectedIds = [nextPlan?.firstHalfTeam, nextPlan?.secondHalfTeam].flatMap((team) =>
      Array.isArray(team?.characterIds)
        ? team.characterIds.filter((id): id is string => typeof id === 'string')
        : []
    );
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
      ...[1, 2].map((chamber) => ({
        id: `enemy-${chamber}`,
        name: 'mcp__genshin__query_enemy_data',
        input: {
          scenarioId: 'abyss.2026-07',
          dataVersion: '2026.07.1',
          floor: 12,
          chamber
        }
      })),
      ...[1, 2].flatMap((chamber) =>
        (['first', 'second'] as const).map((half) => ({
          id: `knowledge-${chamber}-${half}`,
          name: 'mcp__genshin__query_team_knowledge',
          input: {
            characterIds:
              half === 'first' ? selectedIds.slice(0, 4) : selectedIds.slice(4, 8),
            floor: 12,
            chamber,
            half
          }
        }))
      )
    ];
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
    const output = this.outputs.shift();
    yield {
      type: 'result',
      subtype: 'success',
      result: JSON.stringify(
        this.addAssignments ? withSmartAssignments(output) : output
      ),
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01
    };
  }
}

function withSmartAssignments(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const plan = structuredClone(value) as Record<string, unknown>;
  const halves = [
    ['first', plan['firstHalfTeam']],
    ['second', plan['secondHalfTeam']]
  ] as const;
  plan['memberAssignments'] = halves.flatMap(([half, rawTeam]) => {
    if (typeof rawTeam !== 'object' || rawTeam === null || Array.isArray(rawTeam)) return [];
    const ids = (rawTeam as { characterIds?: unknown }).characterIds;
    if (!Array.isArray(ids)) return [];
    return ids.flatMap((characterId) => {
      if (typeof characterId !== 'string') return [];
      const index = ABYSS_CHARACTERS.findIndex(({ id }) => String(id) === characterId);
      return [
        {
          characterId,
          half,
          archetypeId: index < 0 ? null : `role-${index + 1}`,
          role: 'support',
          buildStatus: 'current-build',
          citationIds: [`citation-${characterId}`]
        }
      ];
    });
  });
  return plan;
}

class NoToolRunner {
  calls = 0;
  async *run(): AsyncIterable<unknown> {
    this.calls += 1;
    yield { type: 'result', subtype: 'success', result: JSON.stringify(validAbyssPlan()) };
  }
}

class RawInvalidRunner {
  calls = 0;

  async *run(): AsyncIterable<unknown> {
    this.calls += 1;
    yield {
      type: 'result',
      subtype: 'success',
      result: this.calls === 1 ? 'model raw text' : `repair raw text ${this.calls - 1}`,
      usage: { input_tokens: 3, output_tokens: 2 },
      total_cost_usd: 0.001
    };
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
      'mcp__genshin__query_enemy_data',
      'mcp__genshin__query_team_knowledge'
    ]
  };
}

function groundedKnowledge(): KnowledgeContextPacket {
  const ids = ABYSS_CHARACTERS.slice(0, 8).map(({ id }) => String(id));
  return {
    knowledgeVersion: 'grounded-v1',
    buildInterpretations: ids.map((characterId, index) => ({
      characterId,
      archetypeId: `role-${index + 1}`,
      confidence: 'high',
      candidateArchetypeIds: [`role-${index + 1}`],
      contextRequired: false,
      matchedSignals: ['current-build-match'],
      conflictingSignals: [],
      currentBuildUsable: true,
      adjustment: 'none',
      unknowns: []
    })),
    trustedMatches: ids.map((characterId, index) => ({
      id: `match-${characterId}`,
      characterId,
      archetypeId: `role-${index + 1}`,
      role: 'support',
      summary: `reviewed strategy ${characterId}`,
      citationIds: [`citation-${characterId}`]
    })),
    ephemeralMatches: [],
    unknowns: [],
    coverage: { requested: 8, trusted: 8, ephemeral: 0, unknown: 0 },
    citations: ids.map((characterId) => ({
      id: `citation-${characterId}`,
      sourceId: 'reviewed-source',
      url: `https://example.test/${characterId}`,
      title: `reviewed ${characterId}`,
      reviewedAt: '2026-07-24T00:00:00.000Z',
      trust: 'trusted-local'
    }))
  };
}

function pipelineContext(feasibleBaseline = validAbyssPlan()) {
  return buildV2PipelineContext({
    correlationId: 'abyss-test-request',
    profile: {
      schemaVersion: 2,
      uid: '123456789',
      source: 'merged',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      characters: ABYSS_CHARACTERS,
      coverage: {
        ownedCount: ABYSS_CHARACTERS.length,
        detailedCount: 6,
        buildCount: ABYSS_CHARACTERS.length,
        statsCount: ABYSS_CHARACTERS.length,
        enkaShowcaseCount: 8,
        missingDetailCount: 4,
        partial: true
      }
    },
    feasibleBaseline,
    eligibleCharacterIds: ABYSS_CHARACTERS.map(({ id }) => String(id)),
    mechanics: [{ target: '12 层所选房间', facts: ['上下半固定双队'], unknowns: ['精确输出未知'] }],
    interventions: { noBuildChange: true },
    knowledge: groundedKnowledge()
  });
}

describe('AbyssPlanAgent', () => {
  it('continues an existing trace lease without starting or finishing a second run', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const trace = new AgentRunTraceStore();
    const lease = trace.start({
      correlationId: 'abyss-test-request',
      model: 'test-model',
      knowledge: { trusted: 8, ephemeral: 0, unknown: 0, searched: false }
    });
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions(),
      trace: { writer: trace, lease }
    });

    expect(result.ok).toBe(true);
    expect(trace.latest()).toMatchObject({
      correlationId: 'abyss-test-request',
      status: 'running'
    });
    expect(trace.latest()?.stages.map(({ stage, status }) => `${stage}:${status}`)).toEqual([
      'compose:completed',
      'critique:completed',
      'rotation:completed',
      'explain:completed',
      'repair-1:skipped',
      'repair-2:skipped'
    ]);
    expect(JSON.stringify(trace.latest())).not.toContain('123456789');
  });

  it('retains invalid compose model text in a failed latest trace', async () => {
    const runner = new RawInvalidRunner();
    const trace = new AgentRunTraceStore();
    const lease = trace.start({
      correlationId: 'abyss-test-request',
      model: 'test-model',
      knowledge: { trusted: 8, ephemeral: 0, unknown: 0, searched: false }
    });
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions(),
      trace: { writer: trace, lease }
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'AGENT_OUTPUT_INVALID' }]
    });
    expect(trace.latest()).toMatchObject({
      status: 'running'
    });
    expect(trace.latest()?.stages.find(({ stage }) => stage === 'compose')).toMatchObject({
      status: 'failed',
      rawOutput: 'model raw text',
      failure: { code: 'AGENT_OUTPUT_INVALID' }
    });
  });

  it('validates compose output, sends structured issues to one repair turn, then accepts valid JSON', async () => {
    const invalid = validAbyssPlan({
      secondHalfTeam: {
        ...validAbyssPlan().secondHalfTeam,
        characterIds: ['1001', '1006', '1007', '1008']
      }
    });
    const repaired = validAbyssPlan();
    const runner = new FixtureRunner([invalid, repaired]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({
      ok: true,
      repaired: true,
      plan: {
        mode: repaired.mode,
        firstHalfTeam: { characterIds: repaired.firstHalfTeam.characterIds }
      }
    });
    if (!result.ok) throw new Error('Expected successful pipeline');
    expect(result.rotation.rotations).toHaveLength(2);
    expect(result.explanation.explanations).toHaveLength(4);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.02 });
    expect(runner.calls).toHaveLength(5);
    expect(runner.calls[0]?.options.systemPrompt).toContain('AbyssTeamComposer');
    expect(runner.calls[0]?.options.maxTurns).toBe(4);
    expect(runner.calls[0]?.prompt).toContain('feasibleBaseline');
    expect(runner.calls[0]?.prompt).toContain('"locale":"zh-CN"');
    expect(runner.calls[0]?.prompt).toContain('missingFields');
    expect(runner.calls[1]?.prompt).toContain('member-assignments:team-coverage-mismatch');
    expect(runner.calls[1]?.prompt).toContain('只修复');
    expect(runner.profileInputs).toEqual([
      { uid: '123456789', characterIds: expect.any(Array) },
      {
        uid: '123456789',
        characterIds: repaired.firstHalfTeam.characterIds.concat(
          repaired.secondHalfTeam.characterIds
        )
      }
    ]);
    expect(
      runner.calls.slice(2).every(({ options }) => options.allowedBusinessTools?.length === 0)
    ).toBe(true);
  });

  it('returns the final structured issue list after exhausting two failed repairs', async () => {
    const invalid = { ...validAbyssPlan(), chambers: [] };
    const runner = new FixtureRunner([invalid, invalid, invalid]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['CHAMBER_COVERAGE_INVALID', 'PLAN_SCHEMA_INVALID'])
    );
    expect(runner.calls).toHaveLength(3);
  });

  it('tells the agent which half to recompute and rejects changes to the preserved half', async () => {
    const prior = validAbyssPlan();
    const changed = validAbyssPlan({
      secondHalfTeam: { ...prior.secondHalfTeam, purpose: '不应被修改' }
    });
    const runner = new FixtureRunner([changed, prior]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput({ priorPlan: prior, recomputeHalf: 'firstHalf' }),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(prior),
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({ ok: true, repaired: true });
    expect(runner.calls[0]?.prompt).toContain('recomputeHalf');
    expect(runner.calls[0]?.prompt).toContain('firstHalf');
    expect(runner.calls[1]?.prompt).toContain('PRESERVED_HALF_CHANGED');
  });

  it('treats narrative or malformed output as invalid instead of scraping arbitrary prose', async () => {
    const runner = new FixtureRunner(['```json\n{}\n```', 'not-json', 'still-not-json']);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'AGENT_OUTPUT_INVALID' }]
    });
  });

  it('rejects an otherwise valid plan when required tools were not successfully called', async () => {
    const runner = new NoToolRunner();
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'AGENT_OUTPUT_INVALID' }]
    });
    expect(runner.calls).toBe(3);
  });

  it('fails closed when knowledge queries do not cover every final character and target half', async () => {
    class IncompleteKnowledgeRunner extends FixtureRunner {
      override async *run(
        prompt: string,
        options: AgentSdkRunOptions
      ): AsyncIterable<unknown> {
        for await (const message of super.run(prompt, options)) {
          if (
            typeof message === 'object' &&
            message !== null &&
            (message as { type?: string }).type === 'assistant'
          ) {
            const current = structuredClone(message) as {
              message: { content: Array<{ id?: string }> };
            };
            current.message.content = current.message.content.filter(
              ({ id }) => id !== 'knowledge-2-second'
            );
            yield current;
          } else if (
            typeof message === 'object' &&
            message !== null &&
            (message as { type?: string }).type === 'user'
          ) {
            const current = structuredClone(message) as {
              message: { content: Array<{ tool_use_id?: string }> };
            };
            current.message.content = current.message.content.filter(
              ({ tool_use_id }) => tool_use_id !== 'knowledge-2-second'
            );
            yield current;
          } else {
            yield message;
          }
        }
      }
    }
    const runner = new IncompleteKnowledgeRunner([
      validAbyssPlan(),
      validAbyssPlan(),
      validAbyssPlan()
    ]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['tools'],
          details: expect.objectContaining({
            missing: expect.arrayContaining(['query_team_knowledge:12-2-second'])
          })
        })
      ]
    });
  });

  it('fails closed when a half knowledge query includes an unselected extra character', async () => {
    class OverbroadKnowledgeRunner extends FixtureRunner {
      override async *run(
        prompt: string,
        options: AgentSdkRunOptions
      ): AsyncIterable<unknown> {
        for await (const message of super.run(prompt, options)) {
          if (
            typeof message === 'object' &&
            message !== null &&
            (message as { type?: string }).type === 'assistant'
          ) {
            const current = structuredClone(message) as {
              message: {
                content: Array<{ id?: string; input?: { characterIds?: string[] } }>;
              };
            };
            const knowledge = current.message.content.find(
              ({ id }) => id === 'knowledge-1-first'
            );
            knowledge?.input?.characterIds?.push('1009');
            yield current;
          } else {
            yield message;
          }
        }
      }
    }
    const runner = new OverbroadKnowledgeRunner([
      validAbyssPlan(),
      validAbyssPlan(),
      validAbyssPlan()
    ]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          details: expect.objectContaining({
            missing: expect.arrayContaining(['query_team_knowledge:12-1-first'])
          })
        })
      ]
    });
  });

  it.each([
    {
      name: 'current build conflict',
      mutate(packet: KnowledgeContextPacket) {
        const interpretation = packet.buildInterpretations.find(
          ({ characterId }) => characterId === '1008'
        )!;
        interpretation.currentBuildUsable = false;
        interpretation.adjustment = 'required';
        interpretation.conflictingSignals = ['build-role-conflict'];
      }
    }
  ])('fails closed for a $name instead of accepting unrelated cited knowledge', async ({ mutate }) => {
    const packet = groundedKnowledge();
    mutate(packet);
    const currentContext = pipelineContext();
    currentContext.knowledge = packet;
    const runner = new FixtureRunner([
      validAbyssPlan(),
      validAbyssPlan(),
      validAbyssPlan()
    ]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: currentContext,
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: ['tools'] })]
    });
  });

  it('allows a selected knowledge gap only when the plan preserves low confidence and an explicit marker', async () => {
    const currentContext = pipelineContext();
    currentContext.knowledge.trustedMatches = currentContext.knowledge.trustedMatches.filter(
      ({ characterId }) => characterId !== '1008'
    );
    currentContext.knowledge.unknowns = [
      {
        id: 'gap-1008',
        subjectId: '1008',
        kind: 'missing',
        reason: 'No build-compatible reviewed strategy is available.'
      }
    ];
    currentContext.knowledge.coverage = {
      requested: 8,
      trusted: 7,
      ephemeral: 0,
      unknown: 1
    };
    const unmarked = validAbyssPlan();
    const runner = new FixtureRunner([
      unmarked,
      unmarked,
      unmarked
    ]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: currentContext,
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: ['tools'],
          details: expect.objectContaining({
            missing: expect.arrayContaining([
              'member-assignment:1008:unknown-marker-missing'
            ])
          })
        })
      ]
    });

    const markedPlan = withSmartAssignments(
      validAbyssPlan({
        confidence: 'low',
        assumptions: ['1008：知识缺口，按低置信度保守使用。']
      })
    ) as Record<string, unknown>;
    const markedAssignment = (
      markedPlan['memberAssignments'] as Array<Record<string, unknown>>
    ).find(({ characterId }) => characterId === '1008')!;
    markedAssignment['role'] = 'unclassified';
    markedAssignment['buildStatus'] = 'unknown';
    markedAssignment['citationIds'] = [];
    const marked = await new AbyssPlanAgent(
      new FixtureRunner([markedPlan], false)
    ).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: currentContext,
      sdkOptions: sdkOptions()
    });
    expect(marked).toMatchObject({ ok: true, plan: { confidence: 'low' } });
  });

  it('requires an explicit per-character adjustment marker when build changes are allowed', async () => {
    const currentContext = pipelineContext();
    const interpretation = currentContext.knowledge.buildInterpretations.find(
      ({ characterId }) => characterId === '1008'
    )!;
    interpretation.currentBuildUsable = false;
    interpretation.adjustment = 'required';
    interpretation.conflictingSignals = ['build-role-conflict'];
    const input = abyssInput({
      preferences: { ...abyssInput().preferences, noBuildChange: false }
    });
    const unmarked = validAbyssPlan();

    const rejected = await new AbyssPlanAgent(
      new FixtureRunner([unmarked, unmarked, unmarked])
    ).compose({
      input,
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: currentContext,
      sdkOptions: sdkOptions()
    });
    expect(rejected).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          details: expect.objectContaining({
            missing: expect.arrayContaining([
              'member-assignment:1008:build-status-mismatch'
            ])
          })
        })
      ]
    });

    const markedPlan = withSmartAssignments(
      validAbyssPlan({
        warnings: ['1008 requires-adjustment：需要调整装备后才能承担当前职责。']
      })
    ) as Record<string, unknown>;
    const adjustmentAssignment = (
      markedPlan['memberAssignments'] as Array<Record<string, unknown>>
    ).find(({ characterId }) => characterId === '1008')!;
    adjustmentAssignment['buildStatus'] = 'requires-adjustment';
    const accepted = await new AbyssPlanAgent(
      new FixtureRunner([markedPlan], false)
    ).compose({
      input,
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: currentContext,
      sdkOptions: sdkOptions()
    });
    expect(accepted).toMatchObject({ ok: true });
  });

  it('rejects a smart plan that omits the exact eight member assignments', async () => {
    const plan = validAbyssPlan();
    const result = await new AbyssPlanAgent(
      new FixtureRunner([plan, plan, plan], false)
    ).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          details: expect.objectContaining({
            missing: expect.arrayContaining(['member-assignments:exactly-eight'])
          })
        })
      ]
    });
  });

  it.each([
    {
      name: 'cross-character citation',
      mutate(plan: Record<string, unknown>) {
        const assignments = plan['memberAssignments'] as Array<Record<string, unknown>>;
        assignments[0]!['citationIds'] = ['citation-1002'];
      },
      expected: 'member-assignment:1001:citation-subject-mismatch'
    },
    {
      name: 'wrong archetype',
      mutate(plan: Record<string, unknown>) {
        const assignments = plan['memberAssignments'] as Array<Record<string, unknown>>;
        assignments[0]!['archetypeId'] = 'role-2';
      },
      expected: 'member-assignment:1001:archetype-mismatch'
    },
    {
      name: 'wrong reviewed role',
      mutate(plan: Record<string, unknown>) {
        const assignments = plan['memberAssignments'] as Array<Record<string, unknown>>;
        assignments[0]!['role'] = 'driver';
      },
      expected: 'member-assignment:1001:role-mismatch'
    },
    {
      name: 'wrong half',
      mutate(plan: Record<string, unknown>) {
        const assignments = plan['memberAssignments'] as Array<Record<string, unknown>>;
        assignments[0]!['half'] = 'second';
      },
      expected: 'member-assignment:1001:half-mismatch'
    }
  ])('rejects a $name assignment', async ({ mutate, expected }) => {
    const plan = withSmartAssignments(validAbyssPlan()) as Record<string, unknown>;
    mutate(plan);
    const result = await new AbyssPlanAgent(
      new FixtureRunner([plan, plan, plan], false)
    ).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          details: expect.objectContaining({
            missing: expect.arrayContaining([expected])
          })
        })
      ]
    });
  });

  it('rejects current-build assignment when the selected build requires adjustment', async () => {
    const currentContext = pipelineContext();
    const interpretation = currentContext.knowledge.buildInterpretations.find(
      ({ characterId }) => characterId === '1008'
    )!;
    interpretation.currentBuildUsable = false;
    interpretation.adjustment = 'required';
    interpretation.conflictingSignals = ['build-role-conflict'];
    const input = abyssInput({
      preferences: { ...abyssInput().preferences, noBuildChange: false }
    });
    const plan = withSmartAssignments(validAbyssPlan()) as Record<string, unknown>;
    const result = await new AbyssPlanAgent(
      new FixtureRunner([plan, plan, plan], false)
    ).compose({
      input,
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: currentContext,
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          details: expect.objectContaining({
            missing: expect.arrayContaining([
              'member-assignment:1008:build-status-mismatch'
            ])
          })
        })
      ]
    });
  });

  it('uses the v3 prompts that prohibit uncited facts and require build-aware critique', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });

    expect(result.ok).toBe(true);
    expect(runner.calls[0]?.options.systemPrompt).toContain('AbyssTeamComposer v3');
    expect(runner.calls[0]?.options.systemPrompt).toContain('requires-adjustment');
    expect(runner.calls[1]?.options.systemPrompt).toContain('CritiqueAgent v3');
    expect(runner.calls[1]?.options.systemPrompt).toContain('反应触发权');
    expect(runner.calls[1]?.options.systemPrompt).toContain('站场时间');
    expect(runner.calls[2]?.options.systemPrompt).toContain('RotationCoachAgent v3');
    expect(runner.calls[3]?.options.systemPrompt).toContain('ExplainAgent v3');
    expect(runner.calls[3]?.options.systemPrompt).toContain('当前 build');
    expect(runner.calls[3]?.options.systemPrompt).toContain('来源');
  });
});
