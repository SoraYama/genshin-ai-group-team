import { createHash } from 'node:crypto';

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
  abyssKnowledgeTargetKey,
  createAbyssBusinessMcpServer,
  type AbyssBusinessToolLog,
  type AbyssKnowledgeTargetKey,
  type AbyssKnowledgeTargetScopes
} from './abyss-business-tools.js';
import { buildLocalAbyssPlan } from './abyss-local-optimizer.js';
import {
  AbyssPlanAgent,
  type AbyssKnowledgeCitationPolicy,
  type AbyssPlanAgentRunner
} from './abyss-plan-agent.js';
import { buildV2PipelineContext } from './v2-agent-context.js';
import type { V2AgentStage, V2PipelineContext } from './v2-agent-pipeline.js';
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
  AgentRunTraceWriter,
  CompleteStageInput
} from './agent-run-trace-store.js';
import {
  AgentTurnError,
  safeAgentTurnFailureDetails
} from './agent-turn-audit.js';

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
      emit('interpreting-builds');
      trace.startStage('knowledge', `candidates=${eligibleCharacterIds.length}`);
      let trustedPacket: KnowledgeContextPacket;
      let trustedTargetScopes: AbyssKnowledgeTargetScopes;
      let coverage: KnowledgeCoverageEvaluation;
      try {
        const runtime = buildAbyssKnowledgeRuntime({
          advisorKnowledge: this.options.advisorKnowledge,
          coverageGate: this.options.coverageGate,
          profile,
          scenario,
          input,
          candidateIds: eligibleCharacterIds
        });
        trustedPacket = runtime.packet;
        trustedTargetScopes = runtime.targetScopes;
        coverage = runtime.coverage;
        auditKnowledgeVersion = trustedPacket.knowledgeVersion;
        emit('checking-knowledge');
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
      let finalTargetScopes = trustedTargetScopes;
      let searched = false;
      if (coverage.required && apiKey !== undefined && this.options.research !== undefined) {
        emit('researching-guides');
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
          searched = researchResult.searchExecuted === true;
          const mergedResearch = mergeEphemeralResearch(
            trustedPacket,
            trustedTargetScopes,
            coverage,
            researchResult
          );
          finalPacket = mergedResearch.packet;
          finalTargetScopes = mergedResearch.targetScopes;
          const researchCitationIds = finalPacket.citations
            .filter(({ trust }) => trust === 'ephemeral-web')
            .map(({ id }) => id);
          const firstGap = researchResult.gaps[0];
          if (firstGap !== undefined || researchResult.failure !== undefined) {
            const failure = researchFailure(
              firstGap?.code ?? 'SEARCH_UNAVAILABLE',
              researchResult.failure
            );
            terminalFailure = failure;
            trace.failStage(
              'research',
              failure,
              {
                ...researchTraceInput(researchResult),
                citationIds: researchCitationIds
              }
            );
          } else {
            trace.completeStage('research', {
              ...researchTraceInput(researchResult),
              citationIds: researchCitationIds
            });
          }
        } catch (error) {
          if (requestAbort.signal.aborted) throw error;
          const failure: AgentFailure = {
            code: 'SEARCH_UNAVAILABLE',
            message: 'Guide research was unavailable.',
            retryable: true
          };
          terminalFailure = failure;
          trace.failStage('research', failure);
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
            knowledge: characterKnowledgeOnly(finalPacket),
            targetKnowledgeViews: buildAbyssTargetKnowledgeViews(
              finalPacket,
              finalTargetScopes
            )
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
                  knowledgePacket: finalPacket,
                  knowledgeScope: {
                    floor: input.floor,
                    chambers: targetChambers(scenario, input),
                    eligibleCharacterIds
                  },
                  knowledgeTargetScopes: finalTargetScopes,
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
            onStageStart: (stage) => {
              if (stage === 'critique') emit('checking-conflicts');
              if (stage === 'rotation' || stage === 'explain') emit('writing-tactics');
            },
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
            const checkedPlan = applyPacketKnowledgeCoverage(
              agent.plan,
              finalPacket,
              finalTargetScopes
            );
            result = abyssAdvisorResultSchema.parse({
              status: 'planned',
              source: 'smart-service',
              issues: [],
              warnings: agent.plan.warnings,
              assumptions: checkedPlan.assumptions,
              knowledgeSummary: {
                trusted: finalPacket.coverage.trusted,
                ephemeral: finalPacket.coverage.ephemeral,
                unknown: finalPacket.coverage.unknown,
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
              teamRisks: renderAbyssTeamRisks(agent.critique),
              memberEvidence: buildAbyssMemberEvidence(
                checkedPlan,
                finalPacket,
                finalTargetScopes
              )
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
  packet: KnowledgeContextPacket,
  targetScopes: AbyssKnowledgeTargetScopes
): AbyssPlanOutput {
  const selectedIds = new Set([
    ...plan.firstHalfTeam.characterIds,
    ...plan.secondHalfTeam.characterIds
  ]);
  const characterUnknowns = packet.unknowns.filter(({ subjectId }) =>
    selectedIds.has(subjectId)
  );
  const targetUnknownIds = new Set(
    Object.values(targetScopes).flatMap((scope) => scope?.unknownIds ?? [])
  );
  const targetUnknowns = packet.unknowns.filter(({ id }) => targetUnknownIds.has(id));
  if (characterUnknowns.length === 0 && targetUnknowns.length === 0) return plan;
  const assumptions: string[] = [];
  if (characterUnknowns.length > 0) {
    assumptions.push(
      `当前队伍仍有 ${characterUnknowns.length} 项知识未知（角色，版本 ${packet.knowledgeVersion}）；未覆盖的职责与能量结论保持低置信度。`
    );
  }
  const targetKeysWithUnknowns = Object.entries(targetScopes).flatMap(([targetKey, scope]) =>
    scope !== undefined && scope.unknownIds.some((id) => targetUnknownIds.has(id))
      ? [targetKey]
      : []
  );
  if (targetUnknowns.length > 0) {
    assumptions.push(
      `目标 ${targetKeysWithUnknowns.join('、')} 仍有 ${targetUnknowns.length} 项机制或场景知识缺口；相关结论保持低置信度。`
    );
  }
  return {
    ...plan,
    confidence: 'low',
    assumptions: [...assumptions, ...plan.assumptions]
  };
}

function buildAbyssMemberEvidence(
  plan: AbyssPlanOutput,
  packet: KnowledgeContextPacket,
  targetScopes: AbyssKnowledgeTargetScopes
): Extract<AbyssAdvisorResult, { status: 'planned' }>['memberEvidence'] {
  const citationsById = new Map(packet.citations.map((citation) => [citation.id, citation]));
  const unknownsById = new Map(packet.unknowns.map((gap) => [gap.id, gap]));
  return plan.memberAssignments.map((assignment) => {
    const assignmentCitationIds = new Set(assignment.citationIds);
    const trustedMatches = packet.trustedMatches.filter(
      ({ characterId, archetypeId, role, citationIds }) =>
        characterId === assignment.characterId &&
        archetypeId === assignment.archetypeId &&
        role === assignment.role &&
        citationIds.some((citationId) => assignmentCitationIds.has(citationId))
    );
    const ephemeralMatches = packet.ephemeralMatches.filter(
      ({ subjectId, citationIds }) =>
        assignment.role === 'unclassified' &&
        subjectId === assignment.characterId &&
        citationIds.some((citationId) => assignmentCitationIds.has(citationId))
    );
    const characterUnknowns = packet.unknowns.filter(
      ({ subjectId }) => subjectId === assignment.characterId
    );
    const targetUnknowns = Object.entries(targetScopes).flatMap(([targetKey, scope]) =>
      scope !== undefined && targetKey.endsWith(`:${assignment.half}`)
        ? scope.unknownIds.flatMap((id) => {
            const gap = unknownsById.get(id);
            return gap === undefined ? [] : [gap];
          })
        : []
    );
    const fitReasons = uniqueStrings(
      [...trustedMatches, ...ephemeralMatches].map(({ summary }) => summary)
    );
    const riskUnknowns = uniqueStrings(
      [...characterUnknowns, ...targetUnknowns].map(({ reason }) => reason)
    );
    return {
      characterId: assignment.characterId,
      half: assignment.half,
      fitReasons:
        fitReasons.length > 0 ? fitReasons : ['暂无可验证的正向适配依据，按未知处理。'],
      currentBuild: [
        `${assignment.buildStatus}；archetype=${assignment.archetypeId ?? 'unknown'}；role=${assignment.role}。`
      ],
      riskUnknowns:
        riskUnknowns.length > 0 ? riskUnknowns : ['无已记录的角色或当前半场知识缺口。'],
      optionalAdjustments: [
        assignment.buildStatus === 'requires-adjustment'
          ? '需要调整装备后再承担当前职责。'
          : assignment.buildStatus === 'unknown'
            ? '缺少可验证依据，不提供确定性换装建议。'
            : '当前 build 可直接使用；换装仅作为可选优化。'
      ],
      sources: assignment.citationIds.flatMap((citationId) => {
        const citation = citationsById.get(citationId);
        return citation === undefined
          ? []
          : [
              {
                citationId,
                sourceId: citation.sourceId,
                url: citation.url,
                title: citation.title,
                reviewedAt: citation.reviewedAt,
                trust: citation.trust
              }
            ];
      })
    };
  });
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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

interface AbyssKnowledgeRuntime {
  packet: KnowledgeContextPacket;
  targetScopes: AbyssKnowledgeTargetScopes;
  coverage: KnowledgeCoverageEvaluation;
}

function buildAbyssKnowledgeRuntime(options: {
  advisorKnowledge: AbyssAdvisorServiceOptions['advisorKnowledge'];
  coverageGate: AbyssAdvisorServiceOptions['coverageGate'];
  profile: PersistedProfile;
  scenario: Extract<AbyssScenarioView, { status: 'ready' }>['scenario'];
  input: AbyssAdvisorPlanInput;
  candidateIds: string[];
}): AbyssKnowledgeRuntime {
  const chambers = options.scenario.floors
    .find(({ floor }) => floor === options.input.floor)
    ?.chambers.filter(
      ({ chamber }) => options.input.chamber === undefined || chamber === options.input.chamber
    ) ?? [];
  const characterInput: AdvisorKnowledgePacketInput = {
    profile: options.profile,
    scenarioTarget: {
      id: `${options.scenario.id}:characters`,
      tags: [],
      shields: [],
      resistances: [],
      immunities: []
    },
    candidateIds: options.candidateIds,
    preferences: options.input.preferences
  };
  const characterPacket = characterKnowledgeOnly(
    options.advisorKnowledge.buildPacket(characterInput)
  );
  const coverageParts: Array<{
    packet: KnowledgeContextPacket;
    evaluation: KnowledgeCoverageEvaluation;
    targetKey?: AbyssKnowledgeTargetKey;
  }> = [
    {
      packet: characterPacket,
      evaluation: options.coverageGate.evaluate(
        characterPacket,
        knowledgeResearchContext(characterInput)
      )
    }
  ];
  const targetScopes: Partial<
    Record<AbyssKnowledgeTargetKey, {
      trustedMatchIds: string[];
      ephemeralMatchIds: string[];
      unknownIds: string[];
    }>
  > = {};
  const targetPackets: KnowledgeContextPacket[] = [];

  for (const chamber of chambers) {
    for (const half of ['first', 'second'] as const) {
      const targetKey = abyssKnowledgeTargetKey(options.input.floor, chamber.chamber, half);
      const combatHalf = half === 'first' ? chamber.firstHalf : chamber.secondHalf;
      const enemies = combatHalf.waves.flatMap(({ enemies: waveEnemies }) => waveEnemies);
      const targetInput: AdvisorKnowledgePacketInput = {
        profile: options.profile,
        scenarioTarget: scopedScenarioTarget(
          `${options.scenario.id}:${targetKey}`,
          enemies,
          combatHalf.waves.length
        ),
        candidateIds: [],
        preferences: options.input.preferences
      };
      const targetPacket = namespaceTargetPacket(
        mechanicKnowledgeOnly(options.advisorKnowledge.buildPacket(targetInput)),
        targetKey
      );
      targetPackets.push(targetPacket);
      targetScopes[targetKey] = {
        trustedMatchIds: targetPacket.trustedMatches.map(({ id }) => id),
        ephemeralMatchIds: targetPacket.ephemeralMatches.map(({ id }) => id),
        unknownIds: targetPacket.unknowns.map(({ id }) => id)
      };
      coverageParts.push({
        packet: targetPacket,
        evaluation: options.coverageGate.evaluate(targetPacket, {
          characters: [],
          scenarioTags: targetInput.scenarioTarget.tags,
          targetKey
        }),
        targetKey
      });
    }
  }

  const packet = combineKnowledgePackets(characterPacket, targetPackets);
  return {
    packet,
    targetScopes,
    coverage: combineKnowledgeCoverage(packet, coverageParts)
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

function scopedScenarioTarget(
  id: string,
  enemies: Array<
    Extract<AbyssScenarioView, { status: 'ready' }>['scenario']['floors'][number]['chambers'][number]['firstHalf']['waves'][number]['enemies'][number]
  >,
  waveCount: number
): AdvisorKnowledgePacketInput['scenarioTarget'] {
  return {
    id,
    tags: Array.from(new Set(enemies.flatMap(({ mechanics }) => mechanics.tags))).slice(0, 24),
    shields: enemies
      .flatMap(({ mechanics }) => mechanics.shields.map(({ element }) => ({ element })))
      .slice(0, 16),
    resistances: enemies
      .flatMap(({ mechanics }) => mechanics.resistances)
      .slice(0, 32),
    immunities: Array.from(
      new Set(enemies.flatMap(({ mechanics }) => mechanics.immunities))
    ).slice(0, 32),
    waveCount: Math.max(1, waveCount),
    enemyCount: Math.max(
      1,
      enemies.reduce((count, { count: enemyCount }) => count + enemyCount, 0)
    )
  };
}

function characterKnowledgeOnly(packet: KnowledgeContextPacket): KnowledgeContextPacket {
  const trustedMatches = packet.trustedMatches.filter(
    ({ characterId }) => characterId !== undefined
  );
  const ephemeralMatches = packet.ephemeralMatches.filter(({ subjectId }) =>
    /^[1-9]\d*$/u.test(subjectId)
  );
  const unknowns = packet.unknowns.filter(
    ({ subjectId, kind }) => /^\d+$/u.test(subjectId) || kind === 'payload-truncated'
  );
  return packetSubset(packet, {
    buildInterpretations: packet.buildInterpretations,
    trustedMatches,
    ephemeralMatches,
    unknowns
  });
}

function mechanicKnowledgeOnly(packet: KnowledgeContextPacket): KnowledgeContextPacket {
  const trustedMatches = packet.trustedMatches.filter(
    ({ mechanicId }) => mechanicId !== undefined
  );
  const ephemeralMatches = packet.ephemeralMatches.filter(({ subjectId }) =>
    /^(?:mechanic|scenario):/u.test(subjectId)
  );
  const unknowns = packet.unknowns.filter(
    ({ subjectId, kind }) =>
      subjectId.startsWith('mechanic:') ||
      subjectId.startsWith('scenario:') ||
      kind === 'payload-truncated'
  );
  return packetSubset(packet, {
    buildInterpretations: [],
    trustedMatches,
    ephemeralMatches,
    unknowns
  });
}

function packetSubset(
  packet: KnowledgeContextPacket,
  subset: Pick<
    KnowledgeContextPacket,
    'buildInterpretations' | 'trustedMatches' | 'ephemeralMatches' | 'unknowns'
  >
): KnowledgeContextPacket {
  const citationIds = new Set(
    [...subset.trustedMatches, ...subset.ephemeralMatches].flatMap(
      ({ citationIds }) => citationIds
    )
  );
  return knowledgeContextPacketSchema.parse({
    knowledgeVersion: packet.knowledgeVersion,
    buildInterpretations: structuredClone(subset.buildInterpretations),
    trustedMatches: structuredClone(subset.trustedMatches),
    ephemeralMatches: structuredClone(subset.ephemeralMatches),
    unknowns: structuredClone(subset.unknowns),
    coverage: {
      requested:
        subset.trustedMatches.length +
        subset.ephemeralMatches.length +
        subset.unknowns.length,
      trusted: subset.trustedMatches.length,
      ephemeral: subset.ephemeralMatches.length,
      unknown: subset.unknowns.length
    },
    citations: packet.citations.filter(({ id }) => citationIds.has(id))
  });
}

function buildAbyssTargetKnowledgeViews(
  packet: KnowledgeContextPacket,
  targetScopes: AbyssKnowledgeTargetScopes
): NonNullable<V2PipelineContext['targetKnowledgeViews']> {
  const trustedById = new Map(packet.trustedMatches.map((match) => [match.id, match]));
  const ephemeralById = new Map(packet.ephemeralMatches.map((match) => [match.id, match]));
  const unknownById = new Map(packet.unknowns.map((gap) => [gap.id, gap]));
  return Object.entries(targetScopes)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([targetKey, scope]) =>
      scope === undefined
        ? []
        : [
            {
              targetKey: targetKey as AbyssKnowledgeTargetKey,
              knowledge: packetSubset(packet, {
                buildInterpretations: [],
                trustedMatches: scope.trustedMatchIds.flatMap((id) => {
                  const match = trustedById.get(id);
                  return match === undefined ? [] : [match];
                }),
                ephemeralMatches: scope.ephemeralMatchIds.flatMap((id) => {
                  const match = ephemeralById.get(id);
                  return match === undefined ? [] : [match];
                }),
                unknowns: scope.unknownIds.flatMap((id) => {
                  const gap = unknownById.get(id);
                  return gap === undefined ? [] : [gap];
                })
              })
            }
          ]
    );
}

function namespaceTargetPacket(
  packet: KnowledgeContextPacket,
  targetKey: AbyssKnowledgeTargetKey
): KnowledgeContextPacket {
  const citationIdMap = new Map(
    packet.citations.map(({ id }) => [id, targetRecordId(targetKey, 'citation', id)])
  );
  return knowledgeContextPacketSchema.parse({
    ...structuredClone(packet),
    trustedMatches: packet.trustedMatches.map((match) => ({
      ...structuredClone(match),
      id: targetRecordId(targetKey, 'trusted', match.id),
      citationIds: match.citationIds.map((id) => {
        const scopedId = citationIdMap.get(id);
        if (scopedId === undefined) throw new Error('Target citation reference is unresolved');
        return scopedId;
      })
    })),
    ephemeralMatches: packet.ephemeralMatches.map((match) => ({
      ...structuredClone(match),
      id: targetRecordId(targetKey, 'ephemeral', match.id),
      citationIds: match.citationIds.map((id) => {
        const scopedId = citationIdMap.get(id);
        if (scopedId === undefined) throw new Error('Target citation reference is unresolved');
        return scopedId;
      })
    })),
    unknowns: packet.unknowns.map((gap) => ({
      ...structuredClone(gap),
      id: targetRecordId(targetKey, 'unknown', gap.id)
    })),
    citations: packet.citations.map((citation) => ({
      ...structuredClone(citation),
      id: citationIdMap.get(citation.id)
    }))
  });
}

function targetRecordId(
  targetKey: AbyssKnowledgeTargetKey,
  kind: 'trusted' | 'ephemeral' | 'unknown' | 'citation',
  originalId: string
): string {
  const digest = createHash('sha256')
    .update(`${targetKey}\u0000${kind}\u0000${originalId}`)
    .digest('hex')
    .slice(0, 24);
  return `target:${targetKey}:${kind}:${digest}`;
}

function combineKnowledgePackets(
  characterPacket: KnowledgeContextPacket,
  targetPackets: KnowledgeContextPacket[]
): KnowledgeContextPacket {
  if (
    targetPackets.some(
      ({ knowledgeVersion }) => knowledgeVersion !== characterPacket.knowledgeVersion
    )
  ) {
    throw new Error('Knowledge packet version mismatch');
  }
  const trustedMatches = uniqueRecordsById([
    ...characterPacket.trustedMatches,
    ...targetPackets.flatMap(({ trustedMatches: matches }) => matches)
  ]);
  const ephemeralMatches = uniqueRecordsById([
    ...characterPacket.ephemeralMatches,
    ...targetPackets.flatMap(({ ephemeralMatches: matches }) => matches)
  ]);
  const unknowns = uniqueRecordsById([
    ...characterPacket.unknowns,
    ...targetPackets.flatMap(({ unknowns: gaps }) => gaps)
  ]);
  const citations = uniqueRecordsById([
    ...characterPacket.citations,
    ...targetPackets.flatMap(({ citations: packetCitations }) => packetCitations)
  ]);
  return knowledgeContextPacketSchema.parse({
    knowledgeVersion: characterPacket.knowledgeVersion,
    buildInterpretations: characterPacket.buildInterpretations,
    trustedMatches,
    ephemeralMatches,
    unknowns,
    coverage: {
      requested: trustedMatches.length + ephemeralMatches.length + unknowns.length,
      trusted: trustedMatches.length,
      ephemeral: ephemeralMatches.length,
      unknown: unknowns.length
    },
    citations
  });
}

function combineKnowledgeCoverage(
  packet: KnowledgeContextPacket,
  parts: Array<{
    packet: KnowledgeContextPacket;
    evaluation: KnowledgeCoverageEvaluation;
    targetKey?: AbyssKnowledgeTargetKey;
  }>
): KnowledgeCoverageEvaluation {
  const tasksByKey = new Map<string, KnowledgeCoverageEvaluation['tasks'][number]>();
  const bindingsByKey = new Map<
    string,
    { unknownIds: Set<string>; targetKeys: Set<string> }
  >();
  for (const part of parts) {
    for (const task of part.evaluation.tasks) tasksByKey.set(task.key, task);
    for (const binding of part.evaluation.bindings) {
      const current = bindingsByKey.get(binding.taskKey) ?? {
        unknownIds: new Set<string>(),
        targetKeys: new Set<string>()
      };
      binding.unknownIndexes.forEach((index) => {
        const gap = part.packet.unknowns[index];
        if (gap !== undefined) current.unknownIds.add(gap.id);
      });
      binding.unknownIds?.forEach((id) => current.unknownIds.add(id));
      binding.targetKeys?.forEach((key) => current.targetKeys.add(key));
      if (part.targetKey !== undefined) current.targetKeys.add(part.targetKey);
      bindingsByKey.set(binding.taskKey, current);
    }
  }
  const unknownIndexById = new Map(packet.unknowns.map(({ id }, index) => [id, index]));
  const tasks = Array.from(tasksByKey.values());
  return {
    required: tasks.length > 0,
    tasks,
    bindings: tasks.map(({ key }) => {
      const binding = bindingsByKey.get(key) ?? {
        unknownIds: new Set<string>(),
        targetKeys: new Set<string>()
      };
      const unknownIds = Array.from(binding.unknownIds);
      return {
        taskKey: key,
        unknownIndexes: unknownIds.flatMap((id) => {
          const index = unknownIndexById.get(id);
          return index === undefined ? [] : [index];
        }),
        unknownIds,
        ...(binding.targetKeys.size === 0
          ? {}
          : { targetKeys: Array.from(binding.targetKeys) })
      };
    })
  };
}

function uniqueRecordsById<T extends { id: string }>(records: T[]): T[] {
  const recordsById = new Map<string, T>();
  for (const record of records) {
    const existing = recordsById.get(record.id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Conflicting knowledge record id: ${record.id}`);
    }
    recordsById.set(record.id, record);
  }
  return Array.from(recordsById.values());
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
  targetScopes: AbyssKnowledgeTargetScopes,
  coverage: KnowledgeCoverageEvaluation,
  research: GuideResearchAgentResult
): { packet: KnowledgeContextPacket; targetScopes: AbyssKnowledgeTargetScopes } {
  const merged = structuredClone(packet);
  const mergedTargetScopes = structuredClone(targetScopes);
  const bindingByTaskKey = new Map(
    coverage.bindings.map(({ taskKey, unknownIndexes, unknownIds, targetKeys }) => [
      taskKey,
      {
        unknownIds:
          unknownIds ??
          unknownIndexes.flatMap((index) => {
            const gap = packet.unknowns[index];
            return gap === undefined ? [] : [gap.id];
          }),
        targetKeys: targetKeys ?? []
      }
    ])
  );
  const resolvedUnknownIds = new Set<string>();
  const existingMatchIds = new Set([
    ...merged.trustedMatches.map(({ id }) => id),
    ...merged.ephemeralMatches.map(({ id }) => id),
    ...merged.unknowns.map(({ id }) => id)
  ]);
  const existingCitationIds = new Set(merged.citations.map(({ id }) => id));

  for (const entry of research.entries) {
    const binding = bindingByTaskKey.get(entry.taskKey);
    if (
      binding === undefined ||
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
    for (const [unknownIndex, unknownId] of binding.unknownIds.entries()) {
      const gap = packet.unknowns.find(({ id }) => id === unknownId);
      if (gap === undefined) continue;
      validMatches.forEach((match, matchIndex) => {
        let id = `${match.id.slice(0, 72)}-b${unknownIndex}-${matchIndex}-${createHash('sha256')
          .update(`${entry.taskKey}\u0000${unknownId}\u0000${match.id}`)
          .digest('hex')
          .slice(0, 16)}`;
        while (existingMatchIds.has(id)) id = `${id.slice(0, 120)}x`;
        existingMatchIds.add(id);
        merged.ephemeralMatches.push({
          ...structuredClone(match),
          id,
          subjectId: gap.subjectId
        });
        for (const targetKeyValue of binding.targetKeys) {
          const targetKey = targetKeyValue as AbyssKnowledgeTargetKey;
          const scope = mergedTargetScopes[targetKey];
          if (scope === undefined) {
            throw new Error('Research target scope unavailable');
          }
          if (!scope.ephemeralMatchIds.includes(id)) scope.ephemeralMatchIds.push(id);
        }
      });
      resolvedUnknownIds.add(unknownId);
    }
  }

  merged.unknowns = merged.unknowns.filter(({ id }) => !resolvedUnknownIds.has(id));
  for (const scope of Object.values(mergedTargetScopes)) {
    if (scope === undefined) continue;
    scope.unknownIds = scope.unknownIds.filter((id) => !resolvedUnknownIds.has(id));
  }
  merged.coverage = {
    requested:
      merged.trustedMatches.length +
      merged.ephemeralMatches.length +
      merged.unknowns.length,
    trusted: merged.trustedMatches.length,
    ephemeral: merged.ephemeralMatches.length,
    unknown: merged.unknowns.length
  };
  return {
    packet: knowledgeContextPacketSchema.parse(merged),
    targetScopes: mergedTargetScopes
  };
}

function researchFailure(
  code: GuideResearchAgentResult['gaps'][number]['code'],
  diagnostic?: GuideResearchAgentResult['failure']
): AgentFailure {
  return {
    code:
      code === 'SEARCH_BUDGET_EXCEEDED' || code === 'SEARCH_OUTPUT_INVALID'
        ? code
        : 'SEARCH_UNAVAILABLE',
    message: 'Guide research did not return a validated result.',
    retryable: code !== 'SEARCH_OUTPUT_INVALID',
    ...(diagnostic === undefined
      ? {}
      : {
          details: {
            sdkCode: diagnostic.sdkCode,
            ...(diagnostic.httpStatus === undefined
              ? {}
              : { httpStatus: String(diagnostic.httpStatus) })
          }
        })
  };
}

function researchTraceInput(
  result: GuideResearchAgentResult
): Omit<CompleteStageInput, 'stage' | 'citationIds'> {
  const audit = result.audit;
  return {
    ...(audit === undefined
      ? {}
      : {
          rawOutput: audit.finalRawText,
          rawMessagesSummary: audit.rawMessagesSummary,
          webSearchEvidence: audit.webSearchEvidence,
          tools: audit.tools.map((tool) => ({
            name: tool.name,
            status: tool.succeeded ? ('completed' as const) : ('failed' as const),
            inputSummary: JSON.stringify(tool.input),
            ...(tool.succeeded
              ? {}
              : {
                  failure: {
                    code: 'SEARCH_UNAVAILABLE' as const,
                    message: 'Research tool call failed.',
                    retryable: true
                  }
                })
          }))
        }),
    usage: {
      inputTokens: result.usage?.inputTokens ?? audit?.usage.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? audit?.usage.outputTokens ?? 0
    }
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
    const diagnostic = safeAgentTurnFailureDetails(error);
    const details = {
      ...(diagnostic.sdkCode === undefined ? {} : { sdkCode: diagnostic.sdkCode }),
      ...(diagnostic.httpStatus === undefined
        ? {}
        : { httpStatus: String(diagnostic.httpStatus) })
    };
    switch (error.code) {
      case 'AGENT_TURN_CANCELLED':
        return {
          code: 'AGENT_ABORTED',
          message: 'Agent request was cancelled.',
          retryable: true,
          ...(Object.keys(details).length === 0 ? {} : { details })
        };
      case 'AGENT_TURN_INCOMPLETE':
      case 'AGENT_TURN_OUTPUT_TOO_LARGE':
        return {
          code: 'AGENT_OUTPUT_INVALID',
          message: 'Agent returned invalid output.',
          retryable: false,
          ...(Object.keys(details).length === 0 ? {} : { details })
        };
      case 'AGENT_TURN_STREAM_FAILED':
      case 'AGENT_TURN_RESULT_ERROR':
        return {
          code: 'PROVIDER_ERROR',
          message: 'Agent provider request failed.',
          retryable: true,
          ...(Object.keys(details).length === 0 ? {} : { details })
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
    input: Omit<CompleteStageInput, 'stage'> = {}
  ): void {
    this.write((writer, lease) =>
      writer.completeStage(lease, {
        ...input,
        stage,
        tools: input.tools ?? [],
        citationIds: input.citationIds ?? [],
        usage: input.usage ?? { inputTokens: 0, outputTokens: 0 }
      })
    );
  }

  failStage(
    stage: 'knowledge' | 'research',
    failure: AgentFailure,
    input: Omit<CompleteStageInput, 'stage'> = {}
  ): void {
    this.write((writer, lease) =>
      writer.failStage(lease, {
        ...input,
        stage,
        tools: input.tools ?? [],
        citationIds: input.citationIds ?? [],
        usage: input.usage ?? { inputTokens: 0, outputTokens: 0 },
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
