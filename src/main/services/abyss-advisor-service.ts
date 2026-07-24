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
import {
  ABYSS_MCP_TOOL_NAMES,
  createAbyssBusinessMcpServer,
  type AbyssBusinessToolLog
} from './abyss-business-tools.js';
import { buildLocalAbyssPlan } from './abyss-local-optimizer.js';
import { AbyssPlanAgent, type AbyssPlanAgentRunner } from './abyss-plan-agent.js';
import {
  buildUnknownKnowledgeContext,
  buildV2PipelineContext
} from './v2-agent-context.js';
import type { V2AgentStage } from './v2-agent-pipeline.js';
import { renderAbyssTeamRisks, renderV2Narrative } from './v2-narrative.js';

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
    const finish = (result: AbyssAdvisorResult): AbyssAdvisorResult => {
      try {
        this.options.auditLog?.({
          correlationId: input.correlationId,
          scenarioId: input.scenarioId,
          dataVersion: input.dataVersion,
          knowledgeVersion: this.options.knowledge?.version ?? 'unavailable',
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

      emit('generating-teams');
      const localPreflight = buildLocalAbyssPlan({
        input,
        scenario,
        characters: profile.characters,
        knowledge: this.options.knowledge
      });
      throwIfCancelled();
      if (localPreflight.status === 'blocked') return finish(localPreflight);

      let result: AbyssAdvisorResult = localPreflight;
      const apiKey = this.options.config.getApiKey();
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
          const eligibleCharacterIds = profile.characters
            .map(({ id }) => String(id))
            .filter((id) => !input.excludedCharacterIds.includes(id));
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
            knowledge: buildUnknownKnowledgeContext(
              this.options.knowledge?.version ?? 'unavailable',
              this.options.knowledge?.coverageFor(eligibleCharacterIds).unknownCharacterIds ??
                eligibleCharacterIds
            )
          });
          const baseSdkOptions = {
            apiKey,
            baseUrl: this.options.config.getBaseUrl(),
            model: this.options.config.getModel(),
            customHeaders: this.options.config.getCustomHeaders(),
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
                  knowledge: this.options.knowledge,
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
            onUsageDelta: (usage) =>
              this.options.config.recordUsage?.(
                usage.inputTokens,
                usage.outputTokens,
                usage.estimatedCostUsd
              )
          });
          throwIfCancelled();
          if (agent.ok) {
            const checkedPlan = applyKnowledgeCoverage(agent.plan, this.options.knowledge);
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
                searched: false
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
            result = addAgentFallbackWarning(localPreflight);
          }
        } catch (error) {
          if (requestAbort.signal.aborted) throw new Error('cancelled');
          if (!timedOut && agentAbort.signal.aborted) throw error;
          result = addAgentFallbackWarning(localPreflight);
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
      throwIfCancelled();
      emit('checking-conflicts');
      emit('writing-tactics');
      throwIfCancelled();
      if (result.status === 'planned') this.persist(input, result, profile, scenarioView);
      return finish(result);
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
  result: Extract<AbyssAdvisorResult, { status: 'planned' }>
): AbyssAdvisorResult {
  const warning = '智能服务未能给出通过检查的方案，已改用更保守的本地规则。';
  return abyssAdvisorResultSchema.parse({
    ...result,
    warnings: [warning, ...result.warnings],
    plan: { ...result.plan, warnings: [warning, ...result.plan.warnings] }
  });
}

function applyKnowledgeCoverage(
  plan: AbyssPlanOutput,
  knowledge?: CharacterKnowledgeReader
): AbyssPlanOutput {
  if (!knowledge) return plan;
  const selectedIds = [...plan.firstHalfTeam.characterIds, ...plan.secondHalfTeam.characterIds];
  const coverage = knowledge.coverageFor(selectedIds);
  if (coverage.known === coverage.requested) return plan;
  const assumption = `角色知识仅覆盖 ${coverage.known} / ${coverage.requested}（版本 ${coverage.knowledgeVersion}）；未覆盖角色的职责与技能保持未知。`;
  return {
    ...plan,
    confidence: 'low',
    assumptions: [assumption, ...plan.assumptions]
  };
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
