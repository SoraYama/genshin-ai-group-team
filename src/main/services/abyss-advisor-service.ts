import type { PersistedProfile } from '../../shared/domain.js';
import {
  abyssAdvisorPlanInputSchema,
  abyssAdvisorResultSchema,
  type AbyssAdvisorPlanInput,
  type AbyssAdvisorProgressEvent,
  type AbyssAdvisorProgressStep,
  type AbyssAdvisorResult,
  type AbyssPlanIssue,
  type AbyssPlanOutput,
  type AbyssScenarioView
} from '../../shared/abyss-advisor.js';
import type { AbyssPlanHistoryEntry } from '../../shared/domain.js';
import { createPlayerCycleSnapshot } from '../../shared/history-snapshot.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import type { AdvisorKnowledgeReader } from '../../shared/advisor-knowledge.js';
import {
  knowledgeContextPacketSchema,
  type KnowledgeContextPacket
} from '../../shared/advisor-knowledge.js';
import type { AgentFailure } from '../../shared/agent-run-trace.js';
import {
  ABYSS_MCP_TOOL_NAMES,
  createAbyssBusinessMcpServer,
  type AbyssBusinessToolLog
} from './abyss-business-tools.js';
import { buildLocalAbyssPlan } from './abyss-local-optimizer.js';
import {
  AbyssPlanAgent,
  type AbyssKnowledgeCitationPolicy,
  type AbyssPlanAgentRunner
} from './abyss-plan-agent.js';
import { buildV2PipelineContext } from './v2-agent-context.js';
import type { V2AgentStage } from './v2-agent-pipeline.js';
import { renderAbyssTeamRisks, renderV2Narrative } from './v2-narrative.js';
import type {
  AdvisorKnowledgePacketInput,
  AdvisorKnowledgeService
} from './advisor-knowledge-service.js';
import type {
  KnowledgeCoverageEvaluation,
  KnowledgeCoverageGate,
  KnowledgeResearchContext
} from './knowledge-coverage-gate.js';
import type { GuideResearchAgentResult } from './guide-research-contract.js';
import type {
  AgentRunTraceLease,
  AgentRunTraceWriter
} from './agent-run-trace-store.js';
import { AgentTurnError } from './agent-turn-audit.js';

export interface AbyssAdvisorServiceOptions {
  runner: AbyssPlanAgentRunner;
  scenarioService: { getView: () => Promise<AbyssScenarioView> };
  profiles: { get: (uid: string) => PersistedProfile | null | undefined };
  history: {
    appendAbyss: (
      input: Omit<AbyssPlanHistoryEntry, 'id' | 'createdAt'>
    ) => AbyssPlanHistoryEntry | void;
  };
  config: {
    getApiKey: () => string | undefined;
    getBaseUrl: () => string;
    getModel: () => string;
    getCustomHeaders: () => Record<string, string>;
    recordUsage?: (inputTokens: number, outputTokens: number, estimatedCostUsd: number) => void;
  };
  sdkEnvironment: { cwd: string; clientVersion: string };
  agentTimeoutMs?: number;
  toolLog?: (event: AbyssBusinessToolLog) => void;
  auditLog?: (event: AbyssAdvisorAuditLog) => void;
  knowledge?: CharacterKnowledgeReader;
  strategyKnowledge: AdvisorKnowledgeReader;
  advisorKnowledge: Pick<AdvisorKnowledgeService, 'buildPacket'>;
  coverageGate: Pick<KnowledgeCoverageGate, 'evaluate'>;
  research?: {
    research: (
      input: {
        tasks: KnowledgeCoverageEvaluation['tasks'];
        knowledgeVersion: string;
      },
      context: { signal: AbortSignal }
    ) => Promise<GuideResearchAgentResult>;
  };
  trace?: AgentRunTraceWriter;
  citationPolicy?: AbyssKnowledgeCitationPolicy;
}

export interface AbyssAdvisorAuditLog {
  correlationId: string;
  scenarioId: string;
  dataVersion: string;
  knowledgeVersion: string;
  outcome: 'planned' | 'blocked';
  source: AbyssAdvisorResult['source'];
  issueCodes: string[];
  parameterSummary: Readonly<{
    floor: number;
    chamber: number | 'all';
    lockedCount: number;
    excludedCount: number;
    recompute: 'firstHalf' | 'secondHalf' | 'both';
  }>;
}

export class AbyssAdvisorService {
  private currentRequest: { correlationId: string; abortController: AbortController } | undefined;
  private readonly planAgent: AbyssPlanAgent;

  constructor(private readonly options: AbyssAdvisorServiceOptions) {
    this.planAgent = new AbyssPlanAgent(options.runner);
  }

  cancel(correlationId: string): boolean {
    if (!this.currentRequest || this.currentRequest.correlationId !== correlationId) return false;
    this.currentRequest.abortController.abort();
    return true;
  }

  async recommend(
    inputValue: AbyssAdvisorPlanInput,
    progress: (event: AbyssAdvisorProgressEvent) => void = () => undefined
  ): Promise<AbyssAdvisorResult> {
    const inputResult = abyssAdvisorPlanInputSchema.safeParse(inputValue);
    if (!inputResult.success) {
      return blocked([
        {
          code: 'INPUT_INVALID',
          path:
            inputResult.error.issues[0]?.path.map((part) =>
              typeof part === 'symbol' ? String(part) : part
            ) ?? [],
          message: '配队条件格式不正确。'
        }
      ]);
    }
    const input = inputResult.data;
    let auditKnowledgeVersion = 'unavailable';
    const recordAudit = (result: AbyssAdvisorResult): AbyssAdvisorResult => {
      try {
        this.options.auditLog?.({
          correlationId: input.correlationId,
          scenarioId: input.scenarioId,
          dataVersion: input.dataVersion,
          knowledgeVersion: auditKnowledgeVersion,
          outcome: result.status,
          source: result.source,
          issueCodes: Array.from(new Set(result.issues.map(({ code }) => code))),
          parameterSummary: {
            floor: input.floor,
            chamber: input.chamber ?? 'all',
            lockedCount: input.lockedCharacterIds.length,
            excludedCount: input.excludedCharacterIds.length,
            recompute: input.recomputeHalf ?? 'both'
          }
        });
      } catch {
        // Observability is secondary and must not affect a checked recommendation.
      }
      return result;
    };
    this.currentRequest?.abortController.abort();
    const requestAbort = new AbortController();
    this.currentRequest = { correlationId: input.correlationId, abortController: requestAbort };
    const apiKey = this.options.config.getApiKey();
    const customHeaders = this.options.config.getCustomHeaders();
    const trace = new RecommendationTrace(this.options.trace, {
      correlationId: input.correlationId,
      model: apiKey ? this.options.config.getModel() : '[local-rules]',
      sensitiveValues: [
        input.uid,
        ...(apiKey === undefined ? [] : [apiKey]),
        ...Object.values(customHeaders)
      ]
    });
    const finish = (
      result: AbyssAdvisorResult,
      failure?: AgentFailure
    ): AbyssAdvisorResult => {
      trace.finish(result.status === 'blocked' ? 'blocked' : result.source, failure);
      return recordAudit(result);
    };
    const emit = (step: AbyssAdvisorProgressStep) =>
      progress({ correlationId: input.correlationId, step });
    const throwIfCancelled = () => {
      if (requestAbort.signal.aborted) throw new Error('cancelled');
    };

    try {
      emit('reading-roster');
      const profile = this.options.profiles.get(input.uid);
      if (!profile) {
        return finish(
          blocked([
            {
              code: 'ROSTER_INSUFFICIENT',
              path: ['profile'],
              message: '没有找到该 UID 的本地角色资料。',
              details: { required: 8, available: 0, missing: 8 }
            }
          ])
        );
      }

      emit('analyzing-rules');
      const scenarioView = await abortable(
        this.options.scenarioService.getView(),
        requestAbort.signal
      );
      throwIfCancelled();
      if (scenarioView.status !== 'ready') {
        return finish(
          blocked([
            {
              code: 'SCENARIO_MISMATCH',
              path: ['scenarioId'],
              message: scenarioView.message
            }
          ])
        );
      }
      if (scenarioView.trust === 'production' && !scenarioView.usableForRecommendation) {
        return finish(
          blocked([
            {
              code: 'SCENARIO_MISMATCH',
              path: ['scenarioId'],
              message: '当前仅有过期或刷新失败的挑战资料；可查看敌情，但不能据此生成本期方案。'
            }
          ])
        );
      }
      const scenario = scenarioView.scenario;
      if (scenario.id !== input.scenarioId) {
        return finish(
          blocked([
            {
              code: 'SCENARIO_MISMATCH',
              path: ['scenarioId'],
              message: '所选场景已发生变化，请重新选择。'
            }
          ])
        );
      }
      if (scenario.meta.dataVersion !== input.dataVersion) {
        return finish(
          blocked([
            {
              code: 'DATA_VERSION_MISMATCH',
              path: ['dataVersion'],
              message: '挑战资料已更新，请重新确认楼层与房间。'
            }
          ])
        );
      }

      const localPreflight = buildLocalAbyssPlan({
        input,
        scenario,
        characters: profile.characters,
        knowledge: this.options.knowledge
      });
      throwIfCancelled();
      if (localPreflight.status === 'blocked') return finish(localPreflight);

      let result: AbyssAdvisorResult = localPreflight;
      let terminalFailure: AgentFailure | undefined;
      const eligibleCharacterIds = profile.characters
        .map(({ id }) => String(id))
        .filter((id) => !input.excludedCharacterIds.includes(id));
      const knowledgeInput = abyssKnowledgeInput({
        profile,
        scenario,
        input,
        candidateIds: eligibleCharacterIds
      });
      emit('interpreting-builds');
      trace.startStage('knowledge', `candidates=${eligibleCharacterIds.length}`);
      let trustedPacket: KnowledgeContextPacket;
      let coverage: KnowledgeCoverageEvaluation;
      try {
        trustedPacket = this.options.advisorKnowledge.buildPacket(knowledgeInput);
        auditKnowledgeVersion = trustedPacket.knowledgeVersion;
        emit('checking-knowledge');
        coverage = this.options.coverageGate.evaluate(
          trustedPacket,
          knowledgeResearchContext(knowledgeInput)
        );
        trace.completeStage('knowledge', {
          citationIds: trustedPacket.citations.map(({ id }) => id)
        });
      } catch {
        const failure: AgentFailure = {
          code: 'VALIDATION_FAILED',
          message: 'Trusted knowledge preparation failed.',
          retryable: false
        };
        trace.failStage('knowledge', failure);
        return finish(
          addAgentFallbackWarning(localPreflight, failure),
          failure
        );
      }

      let finalPacket = trustedPacket;
      let searched = false;
      if (coverage.required && apiKey !== undefined && this.options.research !== undefined) {
        emit('researching-guides');
        searched = true;
        trace.startStage('research', `tasks=${coverage.tasks.length}`);
        try {
          const researchResult = await abortable(
            this.options.research.research(
              {
                tasks: coverage.tasks,
                knowledgeVersion: trustedPacket.knowledgeVersion
              },
              { signal: requestAbort.signal }
            ),
            requestAbort.signal
          );
          throwIfCancelled();
          finalPacket = mergeEphemeralResearch(trustedPacket, coverage, researchResult);
          const researchCitationIds = finalPacket.citations
            .filter(({ trust }) => trust === 'ephemeral-web')
            .map(({ id }) => id);
          const firstGap = researchResult.gaps[0];
          if (researchResult.entries.length === 0 && firstGap !== undefined) {
            trace.failStage('research', researchFailure(firstGap.code));
          } else {
            trace.completeStage('research', { citationIds: researchCitationIds });
          }
        } catch (error) {
          if (requestAbort.signal.aborted) throw error;
          trace.failStage('research', {
            code: 'SEARCH_UNAVAILABLE',
            message: 'Guide research was unavailable.',
            retryable: true
          });
        }
      } else {
        trace.skipStage(
          'research',
          coverage.required ? 'Research provider unavailable.' : 'Trusted coverage is complete.'
        );
      }
      trace.updateKnowledge({
        trusted: finalPacket.coverage.trusted,
        ephemeral: finalPacket.coverage.ephemeral,
        unknown: finalPacket.coverage.unknown,
        searched
      });

      emit('generating-teams');
      if (apiKey) {
        const agentAbort = new AbortController();
        const cancelAgent = () => agentAbort.abort();
        requestAbort.signal.addEventListener('abort', cancelAgent, { once: true });
        let timedOut = false;
        const timeout = setTimeout(
          () => {
            timedOut = true;
            agentAbort.abort();
          },
          Math.max(1, Math.min(this.options.agentTimeoutMs ?? 60_000, 120_000))
        );
        try {
          const pipelineContext = buildV2PipelineContext({
            correlationId: input.correlationId,
            profile,
            feasibleBaseline: localPreflight.plan,
            eligibleCharacterIds,
            locale: input.locale,
            mechanics: abyssMechanicsContext(scenario, input),
            interventions: {
              lockedCharacterIds: input.lockedCharacterIds,
              excludedCharacterIds: input.excludedCharacterIds,
              preferences: input.preferences,
              ...(input.recomputeHalf ? { recomputeHalf: input.recomputeHalf } : {})
            },
            knowledge: finalPacket
          });
          const baseSdkOptions = {
            apiKey,
            baseUrl: this.options.config.getBaseUrl(),
            model: this.options.config.getModel(),
            customHeaders,
            systemPrompt: '',
            cwd: this.options.sdkEnvironment.cwd,
            clientVersion: this.options.sdkEnvironment.clientVersion,
            abortController: agentAbort,
            maxTurns: 4,
            allowedBusinessTools: [...ABYSS_MCP_TOOL_NAMES]
          };
          const sdkOptionsForStage = (stage: V2AgentStage) => {
            if (stage === 'critique' || stage === 'rotation' || stage === 'explain') {
              return { ...baseSdkOptions, allowedBusinessTools: [] };
            }
            return {
              ...baseSdkOptions,
              mcpServers: {
                genshin: createAbyssBusinessMcpServer({
                  getProfile: (uid) => (uid === input.uid ? profile : null),
                  getScenario: () => scenario,
                  knowledgePacket: pipelineContext.knowledge,
                  knowledgeScope: {
                    floor: input.floor,
                    chambers: targetChambers(scenario, input),
                    eligibleCharacterIds
                  },
                  auditContext: {
                    correlationId: input.correlationId,
                    scenarioId: scenario.id,
                    dataVersion: scenario.meta.dataVersion,
                    round: stage
                  },
                  log: this.options.toolLog
                })
              }
            };
          };
          const agent = await this.planAgent.compose({
            input,
            scenario,
            characters: profile.characters,
            knowledge: this.options.knowledge,
            pipelineContext,
            sdkOptions: baseSdkOptions,
            sdkOptionsForStage,
            trace: trace.pipelineSession(),
            citationPolicy: this.options.citationPolicy,
            onUsageDelta: (usage) =>
              this.options.config.recordUsage?.(
                usage.inputTokens,
                usage.outputTokens,
                usage.estimatedCostUsd
              )
          });
          throwIfCancelled();
          if (agent.ok) {
            const checkedPlan = applyPacketKnowledgeCoverage(agent.plan, finalPacket);
            result = abyssAdvisorResultSchema.parse({
              status: 'planned',
              source: 'smart-service',
              issues: [],
              warnings: agent.plan.warnings,
              assumptions: checkedPlan.assumptions,
              knowledgeSummary: {
                trusted: pipelineContext.knowledge.coverage.trusted,
                ephemeral: pipelineContext.knowledge.coverage.ephemeral,
                unknown: pipelineContext.knowledge.coverage.unknown,
                searched
              },
              plan: checkedPlan,
              narrative: renderV2Narrative({
                mode: 'spiral-abyss',
                locale: input.locale,
                critique: agent.critique,
                rotation: agent.rotation,
                explanation: agent.explanation
              }),
              teamRisks: renderAbyssTeamRisks(agent.critique)
            });
          } else {
            terminalFailure = agent.failure;
            result = addAgentFallbackWarning(localPreflight, agent.failure);
          }
        } catch (error) {
          if (requestAbort.signal.aborted) throw error;
          terminalFailure = agentFailureFromError(error, timedOut);
          result = addAgentFallbackWarning(localPreflight, terminalFailure);
        } finally {
          clearTimeout(timeout);
          requestAbort.signal.removeEventListener('abort', cancelAgent);
        }
      }

      if (
        result.status === 'planned' &&
        scenarioView.trust === 'production' &&
        scenarioView.refreshWarning
      ) {
        result = addPlanWarning(result, scenarioView.refreshWarning);
      }
      if (result.status === 'planned' && result.source === 'local-rules') {
        result = withKnowledgeSummary(result, finalPacket, searched);
      }
      throwIfCancelled();
      emit('checking-conflicts');
      emit('writing-tactics');
      throwIfCancelled();
      if (result.status === 'planned') this.persist(input, result, profile, scenarioView);
      return finish(result, terminalFailure);
    } catch (error) {
      if (requestAbort.signal.aborted) {
        trace.finish('blocked', {
          code: 'AGENT_ABORTED',
          message: 'Recommendation was cancelled.',
          retryable: true
        });
        throw new Error('cancelled', { cause: error });
      }
      trace.finish('blocked', {
        code: 'PROVIDER_ERROR',
        message: 'Recommendation failed unexpectedly.',
        retryable: true
      });
      throw error;
    } finally {
      if (this.currentRequest?.abortController === requestAbort) this.currentRequest = undefined;
    }
  }

  private persist(
    input: AbyssAdvisorPlanInput,
    result: Extract<AbyssAdvisorResult, { status: 'planned' }>,
    profile: PersistedProfile,
    scenarioView: Extract<AbyssScenarioView, { status: 'ready' }>
  ): void {
    try {
      this.options.history.appendAbyss({
        uid: input.uid,
        scenarioId: result.plan.scenarioId,
        playerCycle: createPlayerCycleSnapshot(scenarioView.scenario.meta),
        schemaVersion: result.plan.schemaVersion,
        dataVersion: result.plan.dataVersion,
        mode: 'spiral-abyss',
        target: { floor: input.floor, ...(input.chamber ? { chamber: input.chamber } : {}) },
        source: result.source,
        scenarioTrust: scenarioView.trust,
        scenarioFreshness: scenarioView.freshness,
        scenarioNotCurrent: scenarioView.notCurrent,
        interventions: {
          locale: input.locale,
          lockedCharacterIds: input.lockedCharacterIds,
          excludedCharacterIds: input.excludedCharacterIds,
          preferences: input.preferences,
          ...(input.recomputeHalf ? { recomputeHalf: input.recomputeHalf } : {})
        },
        narrative: result.narrative,
        teamRisks: result.teamRisks,
        characters: [
          ...result.plan.firstHalfTeam.characterIds,
          ...result.plan.secondHalfTeam.characterIds
        ].flatMap((id) => {
          const character = profile.characters.find(
            ({ id: numericId }) => String(numericId) === id
          );
          return character
            ? [
                {
                  id,
                  name: character.name,
                  element: character.element,
                  ...(character.level === undefined ? {} : { level: character.level })
                }
              ]
            : [];
        }),
        plan: result.plan
      });
    } catch {
      // History is secondary; a persistence failure never invalidates an already checked plan.
    }
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error('cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function addAgentFallbackWarning(
  result: Extract<AbyssAdvisorResult, { status: 'planned' }>,
  failure: AgentFailure = {
    code: 'AGENT_OUTPUT_INVALID',
    message: 'Agent output failed validation.',
    retryable: false
  }
): AbyssAdvisorResult {
  const warning = fallbackWarning(failure.code);
  return abyssAdvisorResultSchema.parse({
    ...result,
    warnings: [warning, ...result.warnings],
    plan: { ...result.plan, warnings: [warning, ...result.plan.warnings] }
  });
}

function applyPacketKnowledgeCoverage(
  plan: AbyssPlanOutput,
  packet: KnowledgeContextPacket
): AbyssPlanOutput {
  const selectedIds = new Set([
    ...plan.firstHalfTeam.characterIds,
    ...plan.secondHalfTeam.characterIds
  ]);
  const unknown = packet.unknowns.filter(({ subjectId }) => selectedIds.has(subjectId));
  if (unknown.length === 0) return plan;
  const assumption = `当前队伍仍有 ${unknown.length} 项知识未知（版本 ${packet.knowledgeVersion}）；未覆盖的职责、能量与机制结论保持低置信度。`;
  return {
    ...plan,
    confidence: 'low',
    assumptions: [assumption, ...plan.assumptions]
  };
}

function withKnowledgeSummary(
  result: Extract<AbyssAdvisorResult, { status: 'planned' }>,
  packet: KnowledgeContextPacket,
  searched: boolean
): Extract<AbyssAdvisorResult, { status: 'planned' }> {
  return abyssAdvisorResultSchema.parse({
    ...result,
    knowledgeSummary: {
      trusted: packet.coverage.trusted,
      ephemeral: packet.coverage.ephemeral,
      unknown: packet.coverage.unknown,
      searched
    }
  }) as Extract<AbyssAdvisorResult, { status: 'planned' }>;
}

function fallbackWarning(code: AgentFailure['code']): string {
  switch (code) {
    case 'PROVIDER_ERROR':
    case 'SDK_START_FAILED':
      return '智能服务请求失败，已改用更保守的本地规则。';
    case 'AGENT_TIMEOUT':
      return '智能服务响应超时，已改用更保守的本地规则。';
    case 'AGENT_ABORTED':
      return '智能服务已取消，已改用更保守的本地规则。';
    case 'TOOL_REQUIREMENT_FAILED':
      return '智能服务未完成必要资料核对，已改用更保守的本地规则。';
    default:
      return '智能服务未能给出通过检查的方案，已改用更保守的本地规则。';
  }
}

function addPlanWarning(
  result: Extract<AbyssAdvisorResult, { status: 'planned' }>,
  warning: string
): Extract<AbyssAdvisorResult, { status: 'planned' }> {
  return abyssAdvisorResultSchema.parse({
    ...result,
    warnings: [warning, ...result.warnings],
    plan: { ...result.plan, warnings: [warning, ...result.plan.warnings] }
  }) as Extract<AbyssAdvisorResult, { status: 'planned' }>;
}

function blocked(issues: AbyssPlanIssue[]): AbyssAdvisorResult {
  return abyssAdvisorResultSchema.parse({
    status: 'blocked',
    source: 'local-rules',
    issues,
    warnings: [],
    assumptions: [],
    knowledgeSummary: { trusted: 0, ephemeral: 0, unknown: 0, searched: false }
  });
}

function abyssMechanicsContext(
  scenario: Extract<AbyssScenarioView, { status: 'ready' }>['scenario'],
  input: AbyssAdvisorPlanInput
) {
  const floor = scenario.floors.find(({ floor: value }) => value === input.floor);
  return (floor?.chambers ?? [])
    .filter(({ chamber }) => input.chamber === undefined || chamber === input.chamber)
    .flatMap(({ chamber, firstHalf, secondHalf }) =>
      (
        [
          ['上半', firstHalf],
          ['下半', secondHalf]
        ] as const
      ).map(([label, half]) => ({
        target: `${input.floor} 层第 ${chamber} 间${label}`,
        facts: [
          ...half.waves.flatMap(({ enemies }) =>
            enemies.flatMap(({ enemy, mechanics }) => [
              enemy.names['zh-CN'] ?? enemy.names['zh-Hans'] ?? '未命名敌人',
              ...mechanics.tags
            ])
          )
        ],
        unknowns: ['未在当期资料中标注的数值与机制保持未知。']
      }))
    );
}

function abyssKnowledgeInput(options: {
  profile: PersistedProfile;
  scenario: Extract<AbyssScenarioView, { status: 'ready' }>['scenario'];
  input: AbyssAdvisorPlanInput;
  candidateIds: string[];
}): AdvisorKnowledgePacketInput {
  const chambers = options.scenario.floors
    .find(({ floor }) => floor === options.input.floor)
    ?.chambers.filter(
      ({ chamber }) => options.input.chamber === undefined || chamber === options.input.chamber
    );
  const enemies = (chambers ?? []).flatMap(({ firstHalf, secondHalf }) =>
    [...firstHalf.waves, ...secondHalf.waves].flatMap(({ enemies: waveEnemies }) => waveEnemies)
  );
  return {
    profile: options.profile,
    scenarioTarget: {
      id: `${options.scenario.id}:${options.input.floor}:${options.input.chamber ?? 'all'}`,
      tags: Array.from(new Set(enemies.flatMap(({ mechanics }) => mechanics.tags))).slice(0, 24),
      shields: enemies.flatMap(({ mechanics }) =>
        mechanics.shields.map(({ element }) => ({ element }))
      ),
      resistances: enemies.flatMap(({ mechanics }) => mechanics.resistances),
      immunities: enemies.flatMap(({ mechanics }) => mechanics.immunities),
      waveCount: (chambers ?? []).reduce(
        (count, { firstHalf, secondHalf }) =>
          count + firstHalf.waves.length + secondHalf.waves.length,
        0
      ),
      enemyCount: enemies.reduce((count, { count: enemyCount }) => count + enemyCount, 0)
    },
    candidateIds: options.candidateIds,
    preferences: options.input.preferences
  };
}

function knowledgeResearchContext(input: AdvisorKnowledgePacketInput): KnowledgeResearchContext {
  const candidates = new Set(input.candidateIds);
  return {
    characters: input.profile.characters.flatMap((character) =>
      candidates.has(String(character.id))
        ? [
            {
              id: String(character.id),
              name: character.name,
              element: character.element
            }
          ]
        : []
    ),
    scenarioTags: input.scenarioTarget.tags
  };
}

function targetChambers(
  scenario: Extract<AbyssScenarioView, { status: 'ready' }>['scenario'],
  input: AbyssAdvisorPlanInput
): number[] {
  return (
    scenario.floors
      .find(({ floor }) => floor === input.floor)
      ?.chambers.filter(
        ({ chamber }) => input.chamber === undefined || chamber === input.chamber
      )
      .map(({ chamber }) => chamber) ?? []
  );
}

function mergeEphemeralResearch(
  packet: KnowledgeContextPacket,
  coverage: KnowledgeCoverageEvaluation,
  research: GuideResearchAgentResult
): KnowledgeContextPacket {
  const merged = structuredClone(packet);
  const bindingByTaskKey = new Map(
    coverage.bindings.map(({ taskKey, unknownIndexes }) => [taskKey, unknownIndexes])
  );
  const resolvedUnknownIndexes = new Set<number>();
  const existingMatchIds = new Set([
    ...merged.trustedMatches.map(({ id }) => id),
    ...merged.ephemeralMatches.map(({ id }) => id),
    ...merged.unknowns.map(({ id }) => id)
  ]);
  const existingCitationIds = new Set(merged.citations.map(({ id }) => id));

  for (const entry of research.entries) {
    const unknownIndexes = bindingByTaskKey.get(entry.taskKey);
    if (
      unknownIndexes === undefined ||
      entry.value.trust !== 'ephemeral-web' ||
      entry.value.conflicts.length > 0
    ) {
      continue;
    }
    const citationsById = new Map(entry.value.citations.map((citation) => [citation.id, citation]));
    const validMatches = entry.value.matches.filter(({ citationIds }) =>
      citationIds.every(
        (citationId) =>
          citationsById.get(citationId)?.trust === 'ephemeral-web'
      )
    );
    if (validMatches.length === 0) continue;
    entry.value.citations.forEach((citation) => {
      if (!existingCitationIds.has(citation.id)) {
        merged.citations.push(structuredClone(citation));
        existingCitationIds.add(citation.id);
      }
    });
    for (const unknownIndex of unknownIndexes) {
      const gap = packet.unknowns[unknownIndex];
      if (gap === undefined) continue;
      validMatches.forEach((match, matchIndex) => {
        let id = `${match.id.slice(0, 96)}-b${unknownIndex}-${matchIndex}`;
        while (existingMatchIds.has(id)) id = `${id.slice(0, 120)}x`;
        existingMatchIds.add(id);
        merged.ephemeralMatches.push({
          ...structuredClone(match),
          id,
          subjectId: gap.subjectId
        });
      });
      resolvedUnknownIndexes.add(unknownIndex);
    }
  }

  merged.unknowns = merged.unknowns.filter(
    (_gap, index) => !resolvedUnknownIndexes.has(index)
  );
  merged.coverage = {
    requested:
      merged.trustedMatches.length +
      merged.ephemeralMatches.length +
      merged.unknowns.length,
    trusted: merged.trustedMatches.length,
    ephemeral: merged.ephemeralMatches.length,
    unknown: merged.unknowns.length
  };
  return knowledgeContextPacketSchema.parse(merged);
}

function researchFailure(code: GuideResearchAgentResult['gaps'][number]['code']): AgentFailure {
  return {
    code:
      code === 'SEARCH_BUDGET_EXCEEDED' || code === 'SEARCH_OUTPUT_INVALID'
        ? code
        : 'SEARCH_UNAVAILABLE',
    message: 'Guide research did not return a validated result.',
    retryable: code !== 'SEARCH_OUTPUT_INVALID'
  };
}

function agentFailureFromError(error: unknown, timedOut: boolean): AgentFailure {
  if (timedOut) {
    return {
      code: 'AGENT_TIMEOUT',
      message: 'Agent request timed out.',
      retryable: true
    };
  }
  if (error instanceof AgentTurnError) {
    switch (error.code) {
      case 'AGENT_TURN_CANCELLED':
        return { code: 'AGENT_ABORTED', message: 'Agent request was cancelled.', retryable: true };
      case 'AGENT_TURN_INCOMPLETE':
      case 'AGENT_TURN_OUTPUT_TOO_LARGE':
        return {
          code: 'AGENT_OUTPUT_INVALID',
          message: 'Agent returned invalid output.',
          retryable: false
        };
      case 'AGENT_TURN_STREAM_FAILED':
      case 'AGENT_TURN_RESULT_ERROR':
        return {
          code: 'PROVIDER_ERROR',
          message: 'Agent provider request failed.',
          retryable: true
        };
    }
  }
  return {
    code: 'PROVIDER_ERROR',
    message: 'Agent provider request failed.',
    retryable: true
  };
}

class RecommendationTrace {
  private writer: AgentRunTraceWriter | undefined;
  private lease: AgentRunTraceLease | undefined;

  constructor(
    writer: AgentRunTraceWriter | undefined,
    input: {
      correlationId: string;
      model: string;
      sensitiveValues: string[];
    }
  ) {
    this.writer = writer;
    if (writer === undefined) return;
    try {
      this.lease = writer.start({
        ...input,
        knowledge: { trusted: 0, ephemeral: 0, unknown: 0, searched: false }
      });
    } catch {
      this.writer = undefined;
    }
  }

  startStage(stage: 'knowledge' | 'research', inputSummary: string): void {
    this.write((writer, lease) => writer.startStage(lease, { stage, inputSummary }));
  }

  completeStage(
    stage: 'knowledge' | 'research',
    input: { citationIds?: string[] } = {}
  ): void {
    this.write((writer, lease) =>
      writer.completeStage(lease, {
        stage,
        tools: [],
        citationIds: input.citationIds ?? [],
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    );
  }

  failStage(stage: 'knowledge' | 'research', failure: AgentFailure): void {
    this.write((writer, lease) =>
      writer.failStage(lease, {
        stage,
        tools: [],
        citationIds: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        failure
      })
    );
  }

  skipStage(stage: 'research', inputSummary: string): void {
    this.write((writer, lease) => writer.skipStage(lease, { stage, inputSummary }));
  }

  updateKnowledge(knowledge: {
    trusted: number;
    ephemeral: number;
    unknown: number;
    searched: boolean;
  }): void {
    this.write((writer, lease) => writer.updateKnowledge(lease, knowledge));
  }

  pipelineSession():
    | { writer: AgentRunTraceWriter; lease: AgentRunTraceLease }
    | undefined {
    return this.writer === undefined || this.lease === undefined
      ? undefined
      : { writer: this.writer, lease: this.lease };
  }

  finish(
    finalSource: 'smart-service' | 'local-rules' | 'blocked',
    failure?: AgentFailure
  ): void {
    this.write((writer, lease) => writer.finish(lease, { finalSource, ...(failure ? { failure } : {}) }));
  }

  private write(
    operation: (writer: AgentRunTraceWriter, lease: AgentRunTraceLease) => void
  ): void {
    if (this.writer === undefined || this.lease === undefined) return;
    try {
      operation(this.writer, this.lease);
    } catch {
      this.writer = undefined;
      this.lease = undefined;
    }
  }
}
