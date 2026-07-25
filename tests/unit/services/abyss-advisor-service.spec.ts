import { describe, expect, it, vi } from 'vitest';

import { AbyssAdvisorService } from '../../../src/main/services/abyss-advisor-service.js';
import { CharacterKnowledgeStore } from '../../../src/main/services/character-knowledge-store.js';
import type {
  AdvisorKnowledgeReader,
  KnowledgeContextPacket
} from '../../../src/shared/advisor-knowledge.js';
import { knowledgeContextPacketSchema } from '../../../src/shared/advisor-knowledge.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import type { AbyssScenarioView } from '../../../src/shared/abyss-advisor.js';
import { AgentRunTraceStore } from '../../../src/main/services/agent-run-trace-store.js';
import { AgentTurnError } from '../../../src/main/services/agent-turn-audit.js';
import type { GuideResearchAgentResult } from '../../../src/main/services/guide-research-contract.js';
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
  calls = 0;
  readonly prompts: string[] = [];
  constructor(
    private readonly outputs: unknown[],
    private readonly assignmentMode: 'trusted' | 'unknown-1008' | 'ephemeral-1008' = 'trusted'
  ) {}
  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls += 1;
    this.prompts.push(prompt);
    if (options.systemPrompt.includes('CritiqueAgent v3')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          decision: 'accept',
          issues: [
            {
              code: 'energy-window-tight',
              severity: 'soft',
              target: { kind: 'abyss-team', half: 'first' },
              message: '能量窗口偏紧。'
            }
          ]
        })
      };
      return;
    }
    if (options.systemPrompt.includes('RotationCoachAgent v3')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          rotations: (['first', 'second'] as const).map((half) => ({
            ...directive({ kind: 'abyss-team', half })
          }))
        })
      };
      return;
    }
    if (options.systemPrompt.includes('ExplainAgent v3')) {
      const plan = validAbyssPlan();
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          explanations: plan.chambers.flatMap(({ floor, chamber }) =>
            (['first', 'second'] as const).map((half) =>
              directive({ kind: 'abyss-chamber', floor, chamber, half })
            )
          )
        })
      };
      return;
    }
    const request = JSON.parse(prompt) as { context: { profileRef: { uid: string } } };
    const candidate = this.outputs[0] as ReturnType<typeof validAbyssPlan>;
    const selectedCharacterIds = [
      ...(candidate.firstHalfTeam?.characterIds ?? []),
      ...(candidate.secondHalfTeam?.characterIds ?? [])
    ];
    const toolUses = [
      {
        id: 'profile',
        name: 'mcp__genshin__read_profile_cache',
        input: { uid: request.context.profileRef.uid, characterIds: selectedCharacterIds }
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
      {
        id: 'knowledge-first-1',
        name: 'mcp__genshin__query_team_knowledge',
        input: {
          characterIds: selectedCharacterIds.slice(0, 4),
          floor: 12,
          chamber: 1,
          half: 'first'
        }
      },
      {
        id: 'knowledge-second-1',
        name: 'mcp__genshin__query_team_knowledge',
        input: {
          characterIds: selectedCharacterIds.slice(4, 8),
          floor: 12,
          chamber: 1,
          half: 'second'
        }
      },
      {
        id: 'knowledge-first-2',
        name: 'mcp__genshin__query_team_knowledge',
        input: {
          characterIds: selectedCharacterIds.slice(0, 4),
          floor: 12,
          chamber: 2,
          half: 'first'
        }
      },
      {
        id: 'knowledge-second-2',
        name: 'mcp__genshin__query_team_knowledge',
        input: {
          characterIds: selectedCharacterIds.slice(4, 8),
          floor: 12,
          chamber: 2,
          half: 'second'
        }
      }
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
    yield {
      type: 'result',
      subtype: 'success',
      result: JSON.stringify(
        withServiceAssignments(this.outputs.shift(), this.assignmentMode)
      ),
      usage: { input_tokens: 12, output_tokens: 6 },
      total_cost_usd: 0.02
    };
  }
}

function withServiceAssignments(
  value: unknown,
  mode: 'trusted' | 'unknown-1008' | 'ephemeral-1008'
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const plan = structuredClone(value) as Record<string, unknown>;
  plan['memberAssignments'] = (
    [
      ['first', plan['firstHalfTeam']],
      ['second', plan['secondHalfTeam']]
    ] as const
  ).flatMap(([half, rawTeam]) => {
    if (typeof rawTeam !== 'object' || rawTeam === null || Array.isArray(rawTeam)) return [];
    const ids = (rawTeam as { characterIds?: unknown }).characterIds;
    if (!Array.isArray(ids)) return [];
    return ids.flatMap((characterId) => {
      if (typeof characterId !== 'string') return [];
      const index = ABYSS_CHARACTERS.findIndex(({ id }) => String(id) === characterId);
      const isSpecial = characterId === '1008' && mode !== 'trusted';
      return [
        {
          characterId,
          half,
          archetypeId: index < 0 ? null : `archetype-${index + 1}`,
          role: isSpecial ? 'unclassified' : 'support',
          buildStatus: mode === 'unknown-1008' && isSpecial ? 'unknown' : 'current-build',
          citationIds:
            mode === 'unknown-1008' && isSpecial
              ? []
              : mode === 'ephemeral-1008' && isSpecial
                ? ['web-citation-gap']
                : [`trusted-citation-${index + 1}`]
        }
      ];
    });
  });
  return plan;
}

class ProviderFailureRunner {
  async *run(): AsyncIterable<unknown> {
    yield await Promise.reject(
      new AgentTurnError('AGENT_TURN_STREAM_FAILED', 'upstream 500: TOP-SECRET-BODY')
    );
  }
}

class ZeroUsageRunner extends FixtureRunner {
  override async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    for await (const message of super.run(prompt, options)) {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === 'result'
      ) {
        yield {
          ...(message as Record<string, unknown>),
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0
        };
      } else {
        yield message;
      }
    }
  }
}

class HangingRunner {
  async *run(_prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    await new Promise<void>((resolve) => {
      options.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'aborted' };
    throw new Error('aborted');
  }
}

class HangingAtStageRunner {
  calls = 0;
  private releaseStarted!: () => void;
  readonly stageStarted = new Promise<void>((resolve) => {
    this.releaseStarted = resolve;
  });

  constructor(private readonly hangingCall: number) {}

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls += 1;
    if (this.calls === this.hangingCall) {
      this.releaseStarted();
      await new Promise<void>((resolve) => {
        options.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    }
    const fixture = new FixtureRunner([validAbyssPlan()]);
    for await (const message of fixture.run(prompt, options)) yield message;
  }
}

function readyScenario() {
  return {
    status: 'ready' as const,
    trust: 'production' as const,
    snapshotStatus: 'ready' as const,
    notCurrent: false,
    usableForRecommendation: true,
    freshness: 'fresh' as const,
    checkedAt: '2026-07-23T00:00:00.000Z',
    scenario: abyssScenario()
  };
}

function profile(characters = ABYSS_CHARACTERS) {
  return {
    schemaVersion: 2 as const,
    uid: '123456789',
    source: 'merged' as const,
    fetchedAt: '2026-07-23T00:00:00.000Z',
    characters,
    coverage: {
      ownedCount: characters.length,
      detailedCount: characters.filter(({ completeness }) => completeness === 'detailed').length,
      buildCount: characters.length,
      statsCount: characters.length,
      enkaShowcaseCount: characters.length,
      missingDetailCount: characters.filter(({ completeness }) => completeness !== 'detailed')
        .length,
      partial: characters.some(({ completeness }) => completeness !== 'detailed')
    }
  };
}

function trustedPacket(
  overrides: Partial<KnowledgeContextPacket> = {}
): KnowledgeContextPacket {
  const selected = ABYSS_CHARACTERS.slice(0, 8).map(({ id }) => String(id));
  const citations = selected.map((characterId, index) => ({
    id: `trusted-citation-${index + 1}`,
    sourceId: 'trusted-test-source',
    url: `https://example.test/character-${characterId}`,
    title: `Reviewed strategy ${index + 1}`,
    reviewedAt: '2026-07-24T00:00:00.000Z',
    trust: 'trusted-local' as const
  }));
  const packet: KnowledgeContextPacket = {
    knowledgeVersion: 'trusted-test-v1',
    buildInterpretations: selected.map((characterId, index) => ({
      characterId,
      archetypeId: `archetype-${index + 1}`,
      confidence: 'high',
      candidateArchetypeIds: [`archetype-${index + 1}`],
      contextRequired: false,
      matchedSignals: ['reviewed-build-signal'],
      conflictingSignals: [],
      currentBuildUsable: true,
      adjustment: 'none',
      unknowns: []
    })),
    trustedMatches: selected.map((characterId, index) => ({
      id: `trusted-character-${characterId}`,
      characterId,
      archetypeId: `archetype-${index + 1}`,
      role: 'support',
      summary: `Reviewed strategy for ${characterId}.`,
      factStatements: ['Reviewed role and build fit.'],
      citationIds: [citations[index]!.id]
    })),
    ephemeralMatches: [],
    unknowns: [],
    coverage: { requested: 8, trusted: 8, ephemeral: 0, unknown: 0 },
    citations,
    ...overrides
  };
  return packet;
}

function packetWithGap(): KnowledgeContextPacket {
  const base = trustedPacket();
  return {
    ...base,
    trustedMatches: base.trustedMatches.slice(0, 7),
    unknowns: [
      {
        id: 'gap-character-1008',
        subjectId: '1008',
        kind: 'missing',
        reason: 'No reviewed local character strategy covers the current candidate build.'
      }
    ],
    coverage: { requested: 8, trusted: 7, ephemeral: 0, unknown: 1 },
    citations: base.citations.slice(0, 7)
  };
}

function packetWithTargetMechanic(options: {
  match?: boolean;
  gap?: boolean;
}): KnowledgeContextPacket {
  const base = trustedPacket();
  const mechanicMatch = {
    id: 'trusted-mechanic-shield-breaking',
    mechanicId: 'shield-breaking',
    summary: 'Reviewed shield-breaking strategy.',
    citationIds: ['citation-shield-breaking']
  };
  const mechanicGap = {
    id: 'gap-mechanic-shield-breaking',
    subjectId: 'mechanic:shield-breaking',
    kind: 'conflict' as const,
    reason: 'This target has contradictory shield tags.'
  };
  return knowledgeContextPacketSchema.parse({
    ...base,
    trustedMatches: [
      ...base.trustedMatches,
      ...(options.match ? [mechanicMatch] : [])
    ],
    unknowns: [...base.unknowns, ...(options.gap ? [mechanicGap] : [])],
    citations: [
      ...base.citations,
      ...(options.match
        ? [
            {
              id: 'citation-shield-breaking',
              sourceId: 'reviewed-source',
              url: 'https://example.test/shield-breaking',
              title: 'Reviewed shield strategy',
              reviewedAt: '2026-07-24T00:00:00.000Z',
              trust: 'trusted-local' as const
            }
          ]
        : [])
    ],
    coverage: {
      requested:
        base.trustedMatches.length +
        (options.match ? 1 : 0) +
        (options.gap ? 1 : 0),
      trusted: base.trustedMatches.length + (options.match ? 1 : 0),
      ephemeral: 0,
      unknown: options.gap ? 1 : 0
    }
  });
}

function successfulResearch(): GuideResearchAgentResult {
  return {
    entries: [
      {
        taskKey: 'anonymous-gap-task',
        origin: 'research',
        value: {
          trust: 'ephemeral-web',
          matches: [
            {
              id: 'web-match-gap',
              subjectId: 'guide-subject-gap',
              summary: 'Validated ephemeral role guidance.',
              citationIds: ['web-citation-gap']
            }
          ],
          citations: [
            {
              id: 'web-citation-gap',
              sourceId: 'trusted-test-source',
              url: 'https://example.test/guide-gap',
              title: 'Guide gap',
              reviewedAt: '2026-07-24T00:00:00.000Z',
              trust: 'ephemeral-web'
            }
          ],
          applicability: {
            characterNames: [],
            scenarioTags: [],
            buildSignals: ['build-unknown-present']
          },
          conflicts: [],
          researchedAt: '2026-07-24T00:00:00.000Z'
        }
      }
    ],
    gaps: [],
    searchExecuted: true,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  };
}

function service(options: {
  runner: FixtureRunner | ProviderFailureRunner | ZeroUsageRunner;
  apiKey?: string;
  characters?: typeof ABYSS_CHARACTERS;
  appendAbyss?: ReturnType<typeof vi.fn>;
  scenarioView?: AbyssScenarioView;
  agentTimeoutMs?: number;
  recordUsage?: ReturnType<typeof vi.fn>;
  scenarioService?: { getView: () => Promise<AbyssScenarioView> };
  knowledge?: CharacterKnowledgeStore;
  toolLog?: ReturnType<typeof vi.fn>;
  auditLog?: ReturnType<typeof vi.fn>;
  packet?: KnowledgeContextPacket;
  targetPackets?: Record<string, KnowledgeContextPacket>;
  buildPacket?: ReturnType<typeof vi.fn>;
  research?: { research: ReturnType<typeof vi.fn> };
  trace?: AgentRunTraceStore;
  coverageTasks?: Array<{
    key: string;
    reason: 'missing';
    scenarioTags: string[];
  }>;
  coverageEvaluate?: (
    packet: KnowledgeContextPacket,
    context: { targetKey?: string }
  ) => {
    required: boolean;
    tasks: Array<{ key: string; reason: 'missing'; scenarioTags: string[] }>;
    bindings: Array<{
      taskKey: string;
      unknownIndexes: number[];
      targetKeys?: string[];
    }>;
  };
}) {
  const strategyKnowledge = new Proxy({} as AdvisorKnowledgeReader, {
    get() {
      throw new Error('strategy knowledge must remain unused until the knowledge pipeline lands');
    }
  });
  return new AbyssAdvisorService({
    runner: options.runner,
    scenarioService: options.scenarioService ?? {
      getView: async () => options.scenarioView ?? readyScenario()
    },
    profiles: { get: () => profile(options.characters) },
    history: { appendAbyss: options.appendAbyss ?? vi.fn() },
    config: {
      getApiKey: () => options.apiKey,
      getBaseUrl: () => 'https://example.test',
      getModel: () => 'test-model',
      getCustomHeaders: () => ({}),
      recordUsage: options.recordUsage
    },
    sdkEnvironment: { cwd: '/tmp/gta-test', clientVersion: 'test' },
    agentTimeoutMs: options.agentTimeoutMs,
    knowledge: options.knowledge,
    strategyKnowledge,
    advisorKnowledge: {
      buildPacket:
        options.buildPacket ??
        vi.fn((input: { scenarioTarget: { id: string } }) => {
          const targetKey = input.scenarioTarget.id.split(':').slice(-3).join(':');
          return options.targetPackets?.[targetKey] ?? options.packet ?? trustedPacket();
        })
    },
    coverageGate: {
      evaluate: vi.fn(
        options.coverageEvaluate ??
          ((
            currentPacket: KnowledgeContextPacket,
            context: { targetKey?: string }
          ) => ({
          required:
            (options.coverageTasks?.length ?? 0) > 0 && currentPacket.unknowns.length > 0,
          tasks: currentPacket.unknowns.length > 0 ? (options.coverageTasks ?? []) : [],
          bindings:
            currentPacket.unknowns.length > 0
              ? (options.coverageTasks ?? []).map(({ key }) => ({
                  taskKey: key,
                  unknownIndexes: currentPacket.unknowns.map((_gap, index) => index),
                  ...(context.targetKey ? { targetKeys: [context.targetKey] } : {})
                }))
              : []
          }))
      )
    },
    research: options.research,
    trace: options.trace,
    toolLog: options.toolLog,
    auditLog: options.auditLog
  });
}

describe('AbyssAdvisorService', () => {
  it('derives five-section member evidence only from validated assignments and citation registry', async () => {
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan()]),
      apiKey: 'secret',
      packet: trustedPacket()
    }).recommend(abyssInput());

    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      memberEvidence: expect.arrayContaining([
        {
          characterId: '1001',
          half: 'first',
          fitReasons: ['Reviewed strategy for 1001.'],
          currentBuild: expect.arrayContaining([expect.stringContaining('current-build')]),
          riskUnknowns: expect.any(Array),
          optionalAdjustments: expect.any(Array),
          sources: [
            {
              citationId: 'trusted-citation-1',
              sourceId: 'trusted-test-source',
              url: 'https://example.test/character-1001',
              title: 'Reviewed strategy 1',
              reviewedAt: '2026-07-24T00:00:00.000Z',
              trust: 'trusted-local'
            }
          ]
        }
      ])
    });
    if (result.status !== 'planned') throw new Error('Expected a planned result');
    expect(result.memberEvidence).toHaveLength(8);
    expect(JSON.stringify(result.memberEvidence)).not.toMatch(/model-source|invented-url/i);
  });

  it('uses complete trusted knowledge without research and keeps one trace owner', async () => {
    const research = { research: vi.fn() };
    const trace = new AgentRunTraceStore();
    const progress: string[] = [];
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan()]),
      apiKey: 'secret',
      packet: trustedPacket(),
      research,
      trace
    }).recommend(abyssInput(), ({ step }) => progress.push(step));

    expect(research.research).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      knowledgeSummary: { trusted: 8, ephemeral: 0, unknown: 0, searched: false }
    });
    expect(progress).toEqual([
      'reading-roster',
      'analyzing-rules',
      'interpreting-builds',
      'checking-knowledge',
      'generating-teams',
      'checking-conflicts',
      'writing-tactics',
      'writing-tactics'
    ]);
    expect(trace.latest()).toMatchObject({
      correlationId: 'abyss-test-request',
      status: 'completed',
      finalSource: 'smart-service',
      knowledge: { trusted: 8, ephemeral: 0, unknown: 0, searched: false }
    });
    expect(trace.latest()?.usage.outputTokens).toBeGreaterThan(0);
    expect(trace.latest()?.stages.filter(({ stage }) => stage === 'knowledge')).toHaveLength(1);
    expect(trace.latest()?.stages.filter(({ stage }) => stage === 'research')).toHaveLength(1);
  });

  it('researches only anonymous gaps and keeps accepted results ephemeral', async () => {
    const research = { research: vi.fn(async () => successfulResearch()) };
    const trace = new AgentRunTraceStore();
    const packet = packetWithGap();
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan()], 'ephemeral-1008'),
      apiKey: 'secret',
      packet,
      research,
      trace,
      coverageTasks: [
        { key: 'anonymous-gap-task', reason: 'missing', scenarioTags: ['multi-wave'] }
      ]
    }).recommend(abyssInput());

    expect(research.research).toHaveBeenCalledOnce();
    expect(research.research).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          {
            key: 'anonymous-gap-task',
            reason: 'missing',
            scenarioTags: ['multi-wave']
          }
        ],
        knowledgeVersion: 'trusted-test-v1'
      }),
      expect.any(Object)
    );
    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      knowledgeSummary: { searched: true, ephemeral: 1, unknown: 0, trusted: 7 }
    });
    expect(packet.ephemeralMatches).toEqual([]);
    expect(packet.trustedMatches).toHaveLength(7);
    expect(trace.latest()?.knowledge).toEqual({
      searched: true,
      ephemeral: 1,
      unknown: 0,
      trusted: 7
    });
  });

  it('propagates live research raw output, messages, WebSearch evidence, tools, and usage into the single trace', async () => {
    const researchResult = successfulResearch() as GuideResearchAgentResult & {
      searchExecuted?: boolean;
      usage?: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
      audit?: Record<string, unknown>;
    };
    researchResult.searchExecuted = true;
    researchResult.usage = { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.01 };
    researchResult.audit = {
      text: '{"schemaVersion":1}',
      finalRawText: '{"schemaVersion":1}',
      rawMessagesSummary: {
        totalMessages: 3,
        messages: [
          { type: 'assistant', textTruncated: false },
          { type: 'user', textTruncated: false },
          {
            type: 'result',
            subtype: 'success',
            textPreview: '{"schemaVersion":1}',
            textTruncated: false
          }
        ],
        truncated: false
      },
      tools: [
        {
          id: 'search-1',
          name: 'WebSearch',
          input: { query: '原神 角色攻略' },
          succeeded: true,
          correlationId: 'unscoped',
          round: 'single'
        }
      ],
      webSearchEvidence: {
        attempts: [
          {
            toolUseId: 'search-1',
            query: '原神 角色攻略',
            status: 'resolved',
            urls: ['https://example.test/guide-gap']
          }
        ],
        truncated: false
      },
      usage: researchResult.usage
    };
    const trace = new AgentRunTraceStore();
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan()], 'ephemeral-1008'),
      apiKey: 'secret',
      packet: packetWithGap(),
      research: { research: vi.fn(async () => researchResult) },
      coverageTasks: [
        { key: 'anonymous-gap-task', reason: 'missing', scenarioTags: ['multi-wave'] }
      ],
      trace
    }).recommend(abyssInput());

    expect(result).toMatchObject({ status: 'planned', source: 'smart-service' });
    expect(trace.latest()).toMatchObject({
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
      knowledge: { searched: true },
      stages: expect.arrayContaining([
        expect.objectContaining({
          stage: 'research',
          status: 'completed',
          rawOutput: '{"schemaVersion":1}',
          rawMessagesSummary: expect.objectContaining({ totalMessages: 3 }),
          webSearchEvidence: expect.objectContaining({
            attempts: [
              expect.objectContaining({ toolUseId: 'search-1', status: 'resolved' })
            ]
          }),
          tools: [expect.objectContaining({ name: 'WebSearch', status: 'completed' })],
          usage: { inputTokens: 5, outputTokens: 3 }
        })
      ])
    });
    expect(trace.latest()?.usage.inputTokens).toBeGreaterThanOrEqual(5);
    expect(trace.latest()?.usage.outputTokens).toBeGreaterThanOrEqual(3);
  });

  it('records mixed cache success and live provider failure as a partial failed research stage', async () => {
    const first = packetWithTargetMechanic({ gap: true });
    const second = packetWithTargetMechanic({ gap: true });
    const base = trustedPacket();
    const partial = successfulResearch() as GuideResearchAgentResult & {
      audit?: NonNullable<GuideResearchAgentResult['audit']>;
    };
    partial.entries[0]!.taskKey = 'first-task';
    partial.entries[0]!.origin = 'cache';
    partial.entries[0]!.value.matches[0]!.subjectId = 'mechanic:shield-breaking';
    partial.gaps = [{ taskKey: 'second-task', code: 'SEARCH_UNAVAILABLE' }];
    partial.failure = {
      sdkCode: 'AGENT_TURN_STREAM_FAILED',
      httpStatus: 503
    };
    partial.usage = { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.01 };
    partial.audit = {
      text: '{"partial":true}',
      finalRawText: '{"partial":true}',
      rawMessagesSummary: {
        totalMessages: 1,
        messages: [
          {
            type: 'result',
            subtype: 'error',
            textPreview: '{"partial":true}',
            textTruncated: false
          }
        ],
        truncated: false
      },
      tools: [
        {
          id: 'search-partial',
          name: 'WebSearch',
          input: { query: '原神 机制攻略' },
          succeeded: true,
          correlationId: 'unscoped',
          round: 'single'
        }
      ],
      webSearchEvidence: {
        attempts: [
          {
            toolUseId: 'search-partial',
            query: '原神 机制攻略',
            status: 'resolved',
            urls: ['https://example.test/guide-gap']
          }
        ],
        truncated: false
      },
      usage: partial.usage
    };
    const trace = new AgentRunTraceStore();
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan({ confidence: 'high' })]),
      apiKey: 'secret',
      trace,
      buildPacket: vi.fn((input: { scenarioTarget: { id: string } }) => {
        const targetKey = input.scenarioTarget.id.split(':').slice(-3).join(':');
        if (targetKey === '12:1:first') return first;
        if (targetKey === '12:1:second') return second;
        return base;
      }),
      coverageEvaluate: (packet, { targetKey }) => {
        if (
          packet.unknowns.length === 0 ||
          (targetKey !== '12:1:first' && targetKey !== '12:1:second')
        ) {
          return { required: false, tasks: [], bindings: [] };
        }
        const taskKey = targetKey === '12:1:first' ? 'first-task' : 'second-task';
        return {
          required: true,
          tasks: [{ key: taskKey, reason: 'missing', scenarioTags: [targetKey] }],
          bindings: [
            {
              taskKey,
              unknownIndexes: [0],
              targetKeys: [targetKey]
            }
          ]
        };
      },
      research: { research: vi.fn(async () => partial) }
    }).recommend(abyssInput());

    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      plan: { confidence: 'low' },
      knowledgeSummary: { searched: true, ephemeral: 1, unknown: 1 }
    });
    expect(trace.latest()?.stages.find(({ stage }) => stage === 'research')).toMatchObject({
      status: 'failed',
      failure: {
        code: 'SEARCH_UNAVAILABLE',
        details: {
          sdkCode: 'AGENT_TURN_STREAM_FAILED',
          httpStatus: '503'
        }
      },
      rawOutput: '{"partial":true}',
      rawMessagesSummary: expect.objectContaining({ totalMessages: 1 }),
      webSearchEvidence: expect.objectContaining({
        attempts: [expect.objectContaining({ toolUseId: 'search-partial' })]
      }),
      tools: [expect.objectContaining({ name: 'WebSearch', status: 'completed' })],
      usage: { inputTokens: 5, outputTokens: 3 }
    });
  });

  it('keeps a cache-only research resolution searched false with empty raw audit and zero usage', async () => {
    const cacheOnly = successfulResearch() as GuideResearchAgentResult & {
      searchExecuted?: boolean;
      usage?: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
    };
    cacheOnly.entries[0]!.origin = 'cache';
    cacheOnly.searchExecuted = false;
    cacheOnly.usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    const trace = new AgentRunTraceStore();
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan()], 'ephemeral-1008'),
      apiKey: 'secret',
      packet: packetWithGap(),
      research: { research: vi.fn(async () => cacheOnly) },
      coverageTasks: [
        { key: 'anonymous-gap-task', reason: 'missing', scenarioTags: ['multi-wave'] }
      ],
      trace
    }).recommend(abyssInput());
    const researchStage = trace.latest()?.stages.find(({ stage }) => stage === 'research');

    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      knowledgeSummary: { searched: false, ephemeral: 1, unknown: 0 }
    });
    expect(researchStage).toMatchObject({
      status: 'completed',
      tools: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    });
    expect(researchStage).not.toHaveProperty('rawOutput');
    expect(researchStage).not.toHaveProperty('rawMessagesSummary');
    expect(researchStage).not.toHaveProperty('webSearchEvidence');
  });

  it('keeps a conflicted research result unknown instead of exposing it as usable ephemeral knowledge', async () => {
    const conflicted = successfulResearch();
    conflicted.entries[0]!.value.conflicts = ['Two reviewed guide sections disagree on the role.'];
    const result = await service({
      runner: new FixtureRunner(
        [
          validAbyssPlan({
            confidence: 'low',
            assumptions: ['1008：知识缺口，按低置信度保守使用。']
          })
        ],
        'unknown-1008'
      ),
      apiKey: 'secret',
      packet: packetWithGap(),
      research: { research: vi.fn(async () => conflicted) },
      coverageTasks: [
        { key: 'anonymous-gap-task', reason: 'missing', scenarioTags: ['multi-wave'] }
      ]
    }).recommend(abyssInput());

    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      knowledgeSummary: { searched: true, trusted: 7, ephemeral: 0, unknown: 1 }
    });
  });

  it('keeps a research citation-id collision unknown instead of reusing trusted metadata', async () => {
    const collided = successfulResearch();
    collided.entries[0]!.value.matches[0]!.citationIds = ['trusted-citation-1'];
    collided.entries[0]!.value.citations[0]!.id = 'trusted-citation-1';
    const result = await service({
      runner: new FixtureRunner(
        [
          validAbyssPlan({
            confidence: 'low',
            assumptions: ['1008：知识缺口，按低置信度保守使用。']
          })
        ],
        'unknown-1008'
      ),
      apiKey: 'secret',
      packet: packetWithGap(),
      research: { research: vi.fn(async () => collided) },
      coverageTasks: [
        { key: 'anonymous-gap-task', reason: 'missing', scenarioTags: ['multi-wave'] }
      ]
    }).recommend(abyssInput());

    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      knowledgeSummary: { searched: true, trusted: 7, ephemeral: 0, unknown: 1 }
    });
  });

  it('builds mechanic knowledge independently per half and keeps a failed target gap low-confidence', async () => {
    const base = trustedPacket();
    const first = packetWithTargetMechanic({ match: true });
    const second = packetWithTargetMechanic({ gap: true });
    const buildPacket = vi.fn(
      (input: { scenarioTarget: { id: string }; candidateIds: string[] }) => {
      const targetKey = input.scenarioTarget.id.split(':').slice(-3).join(':');
      if (targetKey === '12:1:first') return first;
      if (targetKey === '12:1:second') return second;
      return base;
      }
    );
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan({ confidence: 'high' })]),
      apiKey: 'secret',
      buildPacket,
      research: {
        research: vi.fn(async (): Promise<GuideResearchAgentResult> => ({
          entries: [],
          gaps: [{ taskKey: 'anonymous-gap-task', code: 'SEARCH_UNAVAILABLE' }],
          searchExecuted: true,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
        }))
      },
      coverageTasks: [
        { key: 'anonymous-gap-task', reason: 'missing', scenarioTags: ['elemental-shield'] }
      ]
    }).recommend(abyssInput());

    expect(
      buildPacket.mock.calls.map(
        ([input]) => (input as { scenarioTarget: { id: string } }).scenarioTarget.id
      )
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/:characters$/),
        expect.stringMatching(/:12:1:first$/),
        expect.stringMatching(/:12:1:second$/)
      ])
    );
    expect(
      buildPacket.mock.calls
        .filter(
          ([input]) =>
            !(input as { scenarioTarget: { id: string } }).scenarioTarget.id.endsWith(
              ':characters'
            )
        )
        .every(
          ([input]) =>
            input.candidateIds.length === 0
        )
    ).toBe(true);
    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      plan: { confidence: 'low' }
    });
    expect(result.assumptions.join(' ')).toContain('12:1:second');
    expect(result.assumptions.join(' ')).not.toContain('12:1:first 知识缺口');
  });

  it('namespaces colliding target gap ids so opposite halves retain their own subjects', async () => {
    const first = packetWithTargetMechanic({ gap: true });
    first.unknowns[0] = {
      ...first.unknowns[0]!,
      subjectId: 'scenario:first-only',
      reason: 'First-half only gap.'
    };
    const second = packetWithTargetMechanic({ gap: true });
    second.unknowns[0] = {
      ...second.unknowns[0]!,
      subjectId: 'scenario:second-only',
      reason: 'Second-half only gap.'
    };
    const base = trustedPacket();
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan({ confidence: 'high' })]),
      apiKey: 'secret',
      buildPacket: vi.fn((input: { scenarioTarget: { id: string } }) => {
        const targetKey = input.scenarioTarget.id.split(':').slice(-3).join(':');
        if (targetKey === '12:1:first') return first;
        if (targetKey === '12:1:second') return second;
        return base;
      })
    }).recommend(abyssInput());

    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      plan: { confidence: 'low' },
      knowledgeSummary: { unknown: 2 }
    });
    expect(result.assumptions.join(' ')).toContain('12:1:first');
    expect(result.assumptions.join(' ')).toContain('12:1:second');
  });

  it('serializes target research only inside its canonical half view in every agent stage', async () => {
    const first = packetWithTargetMechanic({ gap: true });
    first.unknowns[0] = {
      ...first.unknowns[0]!,
      subjectId: 'scenario:first-research',
      reason: 'First-half research gap.'
    };
    const second = packetWithTargetMechanic({ gap: true });
    second.unknowns[0] = {
      ...second.unknowns[0]!,
      subjectId: 'scenario:second-research',
      reason: 'Second-half research gap.'
    };
    const base = trustedPacket();
    const runner = new FixtureRunner([validAbyssPlan()]);
    const researchEntry = (
      taskKey: string,
      subject: string,
      summary: string,
      citationId: string
    ): GuideResearchAgentResult['entries'][number] => ({
      taskKey,
      origin: 'research',
      value: {
        trust: 'ephemeral-web',
        matches: [
          {
            id: `match-${taskKey}`,
            subjectId: subject,
            summary,
            citationIds: [citationId]
          }
        ],
        citations: [
          {
            id: citationId,
            sourceId: `source-${taskKey}`,
            url: `https://example.test/${taskKey}`,
            title: summary,
            reviewedAt: '2026-07-24T00:00:00.000Z',
            trust: 'ephemeral-web'
          }
        ],
        applicability: { characterNames: [], scenarioTags: [], buildSignals: [] },
        conflicts: [],
        researchedAt: '2026-07-24T00:00:00.000Z'
      }
    });
    await service({
      runner,
      apiKey: 'secret',
      buildPacket: vi.fn((input: { scenarioTarget: { id: string } }) => {
        const targetKey = input.scenarioTarget.id.split(':').slice(-3).join(':');
        if (targetKey === '12:1:first') return first;
        if (targetKey === '12:1:second') return second;
        return base;
      }),
      coverageEvaluate: (packet, { targetKey }) => {
        if (
          packet.unknowns.length === 0 ||
          (targetKey !== '12:1:first' && targetKey !== '12:1:second')
        ) {
          return { required: false, tasks: [], bindings: [] };
        }
        const taskKey = targetKey === '12:1:first' ? 'first-task' : 'second-task';
        return {
          required: true,
          tasks: [{ key: taskKey, reason: 'missing', scenarioTags: [targetKey] }],
          bindings: [
            {
              taskKey,
              unknownIndexes: [0],
              targetKeys: [targetKey]
            }
          ]
        };
      },
      research: {
        research: vi.fn(async () => ({
          entries: [
            researchEntry(
              'first-task',
              'scenario:first-research',
              'FIRST_TARGET_ONLY',
              'web-first'
            ),
            researchEntry(
              'second-task',
              'scenario:second-research',
              'SECOND_TARGET_ONLY',
              'web-second'
            )
          ],
          gaps: [],
          searchExecuted: true,
          usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }
        }))
      }
    }).recommend(abyssInput());

    expect(runner.prompts).toHaveLength(4);
    for (const prompt of runner.prompts) {
      const payload = JSON.parse(prompt) as {
        context: {
          knowledge: KnowledgeContextPacket;
          targetKnowledgeViews: Array<{
            targetKey: string;
            knowledge: KnowledgeContextPacket;
          }>;
        };
      };
      expect(JSON.stringify(payload.context.knowledge)).not.toMatch(
        /FIRST_TARGET_ONLY|SECOND_TARGET_ONLY|web-first|web-second/
      );
      const firstView = payload.context.targetKnowledgeViews.find(
        ({ targetKey }) => targetKey === '12:1:first'
      );
      const secondView = payload.context.targetKnowledgeViews.find(
        ({ targetKey }) => targetKey === '12:1:second'
      );
      expect(JSON.stringify(firstView)).toContain('FIRST_TARGET_ONLY');
      expect(JSON.stringify(firstView)).not.toMatch(/SECOND_TARGET_ONLY|web-second/);
      expect(JSON.stringify(secondView)).toContain('SECOND_TARGET_ONLY');
      expect(JSON.stringify(secondView)).not.toMatch(/FIRST_TARGET_ONLY|web-first/);
    }
  });

  it('preserves the provider failure when falling back to a feasible local plan', async () => {
    const trace = new AgentRunTraceStore();
    const result = await service({
      runner: new ProviderFailureRunner(),
      apiKey: 'secret',
      packet: trustedPacket(),
      trace
    }).recommend(abyssInput());

    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.warnings.join(' ')).toContain('智能服务请求失败');
    expect(JSON.stringify(result)).not.toMatch(/TOP-SECRET|upstream 500/i);
    expect(trace.latest()).toMatchObject({
      status: 'failed',
      finalSource: 'local-rules',
      failure: { code: 'PROVIDER_ERROR' }
    });
    expect(JSON.stringify(trace.latest())).not.toMatch(/TOP-SECRET|upstream 500/i);
  });

  it('does not label a schema-valid response smart-service when total model usage is zero', async () => {
    const trace = new AgentRunTraceStore();
    const result = await service({
      runner: new ZeroUsageRunner([validAbyssPlan()]),
      apiKey: 'secret',
      packet: trustedPacket(),
      trace
    }).recommend(abyssInput());

    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(trace.latest()).toMatchObject({
      finalSource: 'local-rules',
      failure: { code: 'AGENT_OUTPUT_INVALID' }
    });
  });

  it('finishes a local infeasibility as blocked without starting the model', async () => {
    const trace = new AgentRunTraceStore();
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await service({
      runner,
      apiKey: 'secret',
      characters: ABYSS_CHARACTERS.slice(0, 7),
      trace
    }).recommend(abyssInput());

    expect(runner.calls).toBe(0);
    expect(result.status).toBe('blocked');
    expect(trace.latest()).toMatchObject({
      status: 'completed',
      finalSource: 'blocked'
    });
  });

  it('continues with trusted knowledge when guide research fails and keeps the gap explicit', async () => {
    const trace = new AgentRunTraceStore();
    const research = {
      research: vi.fn(async (): Promise<GuideResearchAgentResult> => ({
        entries: [],
        gaps: [{ taskKey: 'anonymous-gap-task', code: 'SEARCH_UNAVAILABLE' }],
        searchExecuted: true,
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        failure: { sdkCode: 'AGENT_TURN_STREAM_FAILED', httpStatus: 503 }
      }))
    };
    const result = await service({
      runner: new FixtureRunner(
        [
          validAbyssPlan({
            confidence: 'low',
            assumptions: ['1008：知识缺口，按低置信度保守使用。']
          })
        ],
        'unknown-1008'
      ),
      apiKey: 'secret',
      packet: packetWithGap(),
      research,
      trace,
      coverageTasks: [
        { key: 'anonymous-gap-task', reason: 'missing', scenarioTags: ['multi-wave'] }
      ]
    }).recommend(abyssInput());

    expect(result).toMatchObject({
      status: 'planned',
      source: 'smart-service',
      knowledgeSummary: { searched: true, ephemeral: 0, unknown: 1, trusted: 7 }
    });
    if (result.status === 'planned') {
      expect(result.plan.confidence).toBe('low');
      expect(result.assumptions.join(' ')).toContain('知识');
    }
    expect(
      trace.latest()?.stages.find(({ stage }) => stage === 'research')
    ).toMatchObject({
      status: 'failed',
      failure: {
        code: 'SEARCH_UNAVAILABLE',
        details: {
          sdkCode: 'AGENT_TURN_STREAM_FAILED',
          httpStatus: '503'
        }
      }
    });
    expect(JSON.stringify(trace.latest())).not.toMatch(/body|secret|private-query/i);
  });

  it('records a correlated, redacted result audit with stable issue codes', async () => {
    const auditLog = vi.fn();
    const result = await service({
      runner: new FixtureRunner([]),
      characters: ABYSS_CHARACTERS.slice(0, 7),
      auditLog
    }).recommend(abyssInput());

    expect(result.status).toBe('blocked');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'abyss-test-request',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1',
        knowledgeVersion: 'unavailable',
        outcome: 'blocked',
        issueCodes: ['ROSTER_INSUFFICIENT'],
        parameterSummary: expect.objectContaining({ floor: 12, recompute: 'both' })
      })
    );
    expect(JSON.stringify(auditLog.mock.calls)).not.toMatch(
      /123456789|测试角色|api.?key|authorization/i
    );
  });

  it('uses the strict agent plan, emits player-semantic progress, and persists an immutable snapshot', async () => {
    const appendAbyss = vi.fn();
    const recordUsage = vi.fn();
    const runner = new FixtureRunner([validAbyssPlan()]);
    const advisor = service({ runner, apiKey: 'secret', appendAbyss, recordUsage });
    const progress: string[] = [];
    const result = await advisor.recommend(abyssInput(), ({ correlationId, step }) =>
      progress.push(`${correlationId}:${step}`)
    );

    expect(result).toMatchObject({ status: 'planned', source: 'smart-service' });
    if (result.status !== 'planned') throw new Error('Expected planned result');
    expect(result.narrative).toMatchObject({
      origin: 'agent-structured',
      requestedLocale: 'zh-CN',
      summary: {
        'zh-CN': expect.any(String),
        'en-US': expect.any(String)
      }
    });
    expect(result.teamRisks).toEqual([
      expect.objectContaining({ half: 'first', code: 'energy-window-tight' })
    ]);
    expect(progress).toEqual([
      'abyss-test-request:reading-roster',
      'abyss-test-request:analyzing-rules',
      'abyss-test-request:interpreting-builds',
      'abyss-test-request:checking-knowledge',
      'abyss-test-request:generating-teams',
      'abyss-test-request:checking-conflicts',
      'abyss-test-request:writing-tactics',
      'abyss-test-request:writing-tactics'
    ]);
    expect(runner.calls).toBe(4);
    expect(recordUsage).toHaveBeenCalledWith(12, 6, 0.02);
    expect(appendAbyss).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: 'abyss.2026-07',
        schemaVersion: 2,
        dataVersion: '2026.07.1',
        mode: 'spiral-abyss',
        source: 'smart-service',
        scenarioTrust: 'production',
        playerCycle: {
          status: 'known',
          label: '2026-01-01 — 2026-02-01',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: '2026-02-01T00:00:00.000Z'
        },
        plan: expect.objectContaining({
          mode: 'spiral-abyss',
          firstHalfTeam: expect.objectContaining({
            characterIds: validAbyssPlan().firstHalfTeam.characterIds
          })
        })
      })
    );
  });

  it('runs two repairs then falls back to the local joint optimizer when all attempts fail', async () => {
    const invalid = { ...validAbyssPlan(), chambers: [] };
    const runner = new FixtureRunner([invalid, invalid, invalid]);
    const appendAbyss = vi.fn();
    const result = await service({ runner, apiKey: 'secret', appendAbyss }).recommend(abyssInput());

    expect(runner.calls).toBe(3);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    if (result.status !== 'planned') throw new Error('Expected local fallback');
    expect(result.narrative.sections.map(({ targetKey }) => targetKey)).toEqual(
      localAbyssNarrativeTargets()
    );
    expect(appendAbyss).toHaveBeenCalledWith(
      expect.objectContaining({ narrative: result.narrative })
    );
    expect(result.warnings.join(' ')).toContain('智能服务');
  });

  it('downgrades smart output when selected-character knowledge coverage is incomplete', async () => {
    const runner = new FixtureRunner(
      [
        validAbyssPlan({
          confidence: 'low',
          assumptions: ['1008：知识缺口，按低置信度保守使用。']
        })
      ],
      'unknown-1008'
    );
    const result = await service({
      runner,
      apiKey: 'secret',
      packet: packetWithGap()
    }).recommend(abyssInput());

    expect(result.status).toBe('planned');
    if (result.status === 'planned') {
      expect(result.source).toBe('smart-service');
      expect(result.plan.confidence).toBe('low');
      expect(result.assumptions.join(' ')).toContain('1 项知识未知');
      expect(result.plan.assumptions.join(' ')).toContain('trusted-test-v1');
      expect(result.knowledgeSummary).toEqual({
        trusted: 7,
        ephemeral: 0,
        unknown: 1,
        searched: false
      });
    }
    const composePayload = JSON.parse(runner.prompts[0]!) as {
      context: { knowledge: { unknowns: Array<{ subjectId: string }> } };
    };
    expect(composePayload.context.knowledge.unknowns.map(({ subjectId }) => subjectId)).toEqual([
      '1008'
    ]);
  });

  it('uses local rules without invoking the agent when the smart service is not configured', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const appendAbyss = vi.fn();
    const result = await service({ runner, appendAbyss }).recommend(abyssInput());
    expect(runner.calls).toBe(0);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    if (result.status !== 'planned') throw new Error('Expected local plan');
    expect(result.narrative.sections.map(({ targetKey }) => targetKey)).toEqual(
      localAbyssNarrativeTargets()
    );
    expect(appendAbyss).toHaveBeenCalledWith(
      expect.objectContaining({ narrative: result.narrative })
    );
  });

  it('returns blocked instead of an invalid agent request when the roster has fewer than eight characters', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await service({
      runner,
      apiKey: 'secret',
      characters: ABYSS_CHARACTERS.slice(0, 7)
    }).recommend(abyssInput());
    expect(runner.calls).toBe(0);
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'ROSTER_INSUFFICIENT' }]
    });
  });

  it('blocks scenario identity drift before either agent or fallback generation', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await service({ runner, apiKey: 'secret' }).recommend(
      abyssInput({ dataVersion: 'wrong' })
    );
    expect(runner.calls).toBe(0);
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'DATA_VERSION_MISMATCH' }]
    });
  });

  it('keeps stale or last-known-good production data read-only', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await service({
      runner,
      apiKey: 'secret',
      scenarioView: {
        status: 'ready',
        trust: 'production',
        snapshotStatus: 'last-known-good',
        refreshErrorCode: 'network-unavailable',
        notCurrent: true,
        usableForRecommendation: false,
        freshness: 'stale',
        checkedAt: '2026-07-23T00:00:00.000Z',
        scenario: abyssScenario()
      }
    }).recommend(abyssInput());
    expect(runner.calls).toBe(0);
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'SCENARIO_MISMATCH' }]
    });
  });

  it.each(['fresh', 'expiring'] as const)(
    'allows verified last-known-good %s data and carries the refresh warning into the plan',
    async (freshness) => {
      const runner = new FixtureRunner([validAbyssPlan()]);
      const result = await service({
        runner,
        scenarioView: {
          status: 'ready',
          trust: 'production',
          snapshotStatus: 'last-known-good',
          refreshErrorCode: 'network-unavailable',
          refreshWarning: '正在使用最近一次已确认的资料；本次刷新失败。',
          notCurrent: false,
          usableForRecommendation: true,
          freshness,
          checkedAt: '2026-07-23T00:00:00.000Z',
          scenario: abyssScenario()
        }
      }).recommend(abyssInput());

      expect(result.status).toBe('planned');
      expect(result.warnings).toContain('正在使用最近一次已确认的资料；本次刷新失败。');
      if (result.status === 'planned') {
        expect(result.plan.warnings).toContain('正在使用最近一次已确认的资料；本次刷新失败。');
      }
    }
  );

  it('aborts a hung smart-service request and falls back to local rules', async () => {
    const appendAbyss = vi.fn();
    const trace = new AgentRunTraceStore();
    const advisor = service({
      runner: new HangingRunner() as never,
      apiKey: 'secret',
      agentTimeoutMs: 10,
      appendAbyss,
      trace
    });
    const result = await advisor.recommend(abyssInput());
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.warnings.join(' ')).toContain('智能服务');
    expect(appendAbyss).toHaveBeenCalledTimes(1);
    expect(appendAbyss).toHaveBeenCalledWith(expect.objectContaining({ source: 'local-rules' }));
    expect(trace.latest()).toMatchObject({
      status: 'failed',
      finalSource: 'local-rules',
      failure: { code: 'AGENT_TIMEOUT' }
    });
  });

  it.each([
    {
      stage: 'Critique',
      hangingCall: 2,
      expectedTail: ['generating-teams', 'checking-conflicts']
    },
    {
      stage: 'Rotation',
      hangingCall: 3,
      expectedTail: ['generating-teams', 'checking-conflicts', 'writing-tactics']
    },
    {
      stage: 'Explain',
      hangingCall: 4,
      expectedTail: [
        'generating-teams',
        'checking-conflicts',
        'writing-tactics',
        'writing-tactics'
      ]
    }
  ])(
    'announces a hanging $stage stage before cancellation without saving partial history',
    async ({ hangingCall, expectedTail }) => {
    const runner = new HangingAtStageRunner(hangingCall);
    const appendAbyss = vi.fn();
    const recordUsage = vi.fn();
    const trace = new AgentRunTraceStore();
    const progress: string[] = [];
    const advisor = service({
      runner: runner as never,
      apiKey: 'secret',
      agentTimeoutMs: 1_000,
      appendAbyss,
      recordUsage,
      trace
    });
    const pending = advisor.recommend(abyssInput(), ({ step }) => progress.push(step));
    await runner.stageStarted;
    expect(progress.slice(-expectedTail.length)).toEqual(expectedTail);
    expect(advisor.cancel('abyss-test-request')).toBe(true);
    await expect(pending).rejects.toThrow('cancelled');
    expect(runner.calls).toBe(hangingCall);
    expect(recordUsage).toHaveBeenCalledWith(12, 6, 0.02);
    expect(appendAbyss).not.toHaveBeenCalled();
    expect(trace.latest()).toMatchObject({
      status: 'failed',
      finalSource: 'blocked',
      failure: { code: 'AGENT_ABORTED' }
    });
    }
  );

  it('cancels while scenario data is still loading and never starts generation or history writes', async () => {
    let resolveScenario!: (view: AbyssScenarioView) => void;
    const scenarioPromise = new Promise<AbyssScenarioView>((resolve) => {
      resolveScenario = resolve;
    });
    const appendAbyss = vi.fn();
    const runner = new FixtureRunner([validAbyssPlan()]);
    const advisor = service({
      runner,
      apiKey: 'secret',
      appendAbyss,
      scenarioService: { getView: () => scenarioPromise }
    });

    const pending = advisor.recommend(abyssInput());
    expect(advisor.cancel('abyss-test-request')).toBe(true);
    await expect(pending).rejects.toThrow('cancelled');
    resolveScenario(readyScenario());
    expect(runner.calls).toBe(0);
    expect(appendAbyss).not.toHaveBeenCalled();
  });

  it('ignores a stale correlation cancel after a newer request has started', async () => {
    const releases: Array<(view: AbyssScenarioView) => void> = [];
    const advisor = service({
      runner: new FixtureRunner([]),
      scenarioService: {
        getView: () =>
          new Promise<AbyssScenarioView>((resolve) => {
            releases.push(resolve);
          })
      }
    });
    const oldRequest = advisor.recommend(abyssInput({ correlationId: 'stale-request' }));
    const oldOutcome = oldRequest.catch((error: unknown) => error);
    const newRequest = advisor.recommend(abyssInput({ correlationId: 'current-request' }));

    expect(advisor.cancel('stale-request')).toBe(false);
    releases[1]?.(readyScenario());
    await expect(newRequest).resolves.toMatchObject({ status: 'planned' });
    await expect(oldOutcome).resolves.toMatchObject({ message: expect.stringMatching(/cancelled/) });
  });

  it('persists development-sample trust so history cannot present rehearsal data as current', async () => {
    const appendAbyss = vi.fn();
    const baseScenario = abyssScenario();
    const development = {
      status: 'ready' as const,
      trust: 'development-sample' as const,
      notCurrent: true as const,
      freshness: 'unknown' as const,
      checkedAt: '2026-07-23T00:00:00.000Z',
      scenario: {
        mode: baseScenario.mode,
        id: 'development.spiral-abyss.sample',
        meta: {
          schemaVersion: 2 as const,
          dataVersion: 'development.sample-v1',
          effectiveFrom: baseScenario.meta.effectiveFrom,
          reviewedAt: baseScenario.meta.reviewedAt,
          reviewedBy: baseScenario.meta.reviewedBy,
          syntheticProvenance: {
            kind: 'synthetic-development-data' as const,
            disclaimer: '仅用于演练。',
            fields: [{ fieldPath: 'scenario.floors' as const, note: '合成敌情。' }]
          }
        },
        blessing: baseScenario.blessing,
        floors: baseScenario.floors
      }
    } satisfies AbyssScenarioView;
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan()]),
      appendAbyss,
      scenarioView: development
    }).recommend(
      abyssInput({
        scenarioId: development.scenario.id,
        dataVersion: development.scenario.meta.dataVersion
      })
    );

    expect(result.status).toBe('planned');
    expect(appendAbyss).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioTrust: 'development-sample' })
    );
  });
});

function localAbyssNarrativeTargets(): string[] {
  return [
    'abyss-team:first',
    'abyss-team:second',
    'abyss-chamber:12:1:first',
    'abyss-chamber:12:1:second',
    'abyss-chamber:12:2:first',
    'abyss-chamber:12:2:second'
  ];
}
