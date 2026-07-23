import type { PersistedProfile, StygianPlanHistoryEntry } from '../../shared/domain.js';
import { createPlayerCycleSnapshot } from '../../shared/history-snapshot.js';
import {
  stygianAdvisorPlanInputSchema,
  stygianAdvisorResultSchema,
  type StygianAdvisorPlanInput,
  type StygianAdvisorProgressEvent,
  type StygianAdvisorProgressStep,
  type StygianAdvisorResult,
  type StygianPlanIssue,
  type StygianScenarioView
} from '../../shared/stygian-advisor.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import {
  STYGIAN_MCP_TOOL_NAMES,
  createStygianBusinessMcpServer,
  type StygianBusinessToolLog
} from './stygian-business-tools.js';
import {
  assessStygianDifficultyEvidence,
  buildLocalStygianPlan
} from './stygian-local-optimizer.js';
import { StygianPlanAgent, type StygianPlanAgentRunner } from './stygian-plan-agent.js';
import type { V2CritiqueOutput, V2ExplainOutput, V2RotationOutput } from '../agents/contracts.js';
import { buildV2PipelineContext } from './v2-agent-context.js';
import type { V2AgentStage } from './v2-agent-pipeline.js';
import { renderV2Narrative } from './v2-narrative.js';

export interface StygianAdvisorServiceOptions {
  runner: StygianPlanAgentRunner;
  scenarioService: { getView: () => Promise<StygianScenarioView> };
  profiles: { get: (uid: string) => PersistedProfile | null | undefined };
  history: {
    appendStygian: (
      input: Omit<StygianPlanHistoryEntry, 'id' | 'createdAt'>
    ) => StygianPlanHistoryEntry | void;
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
  toolLog?: (event: StygianBusinessToolLog) => void;
  auditLog?: (event: StygianAdvisorAuditLog) => void;
  knowledge?: CharacterKnowledgeReader;
}

export interface StygianAdvisorAuditLog {
  correlationId: string;
  scenarioId: string;
  dataVersion: string;
  knowledgeVersion: string;
  outcome: 'planned' | 'blocked';
  source: StygianAdvisorResult['source'];
  issueCodes: string[];
  parameterSummary: Readonly<{
    difficultyId: string;
    target: StygianAdvisorPlanInput['target'];
    phase: number | 'all';
    reuseRule: 'forbidden' | 'allowed' | 'limited' | 'unknown';
    lockedCount: number;
    excludedCount: number;
  }>;
}

export class StygianAdvisorService {
  private currentRequest: { correlationId: string; abortController: AbortController } | undefined;
  private readonly planAgent: StygianPlanAgent;

  constructor(private readonly options: StygianAdvisorServiceOptions) {
    this.planAgent = new StygianPlanAgent(options.runner);
  }

  cancel(correlationId: string): boolean {
    if (!this.currentRequest || this.currentRequest.correlationId !== correlationId) return false;
    this.currentRequest.abortController.abort();
    return true;
  }

  async recommend(
    inputValue: StygianAdvisorPlanInput,
    progress: (event: StygianAdvisorProgressEvent) => void = () => undefined
  ): Promise<StygianAdvisorResult> {
    const parsedInput = stygianAdvisorPlanInputSchema.safeParse(inputValue);
    if (!parsedInput.success) {
      return blocked([
        {
          code: 'INPUT_INVALID',
          path:
            parsedInput.error.issues[0]?.path.map((part) =>
              typeof part === 'symbol' ? String(part) : part
            ) ?? [],
          message: '配队条件格式不正确。'
        }
      ]);
    }
    const input = parsedInput.data;
    let auditReuseRule: StygianAdvisorAuditLog['parameterSummary']['reuseRule'] = 'unknown';
    const finish = (result: StygianAdvisorResult): StygianAdvisorResult => {
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
            difficultyId: input.difficultyId,
            target: input.target,
            phase: input.phase ?? 'all',
            reuseRule: auditReuseRule,
            lockedCount: input.lockedCharacterIds.length,
            excludedCount: input.excludedCharacterIds.length
          }
        });
      } catch {
        // Observability must never change a checked result.
      }
      return result;
    };

    this.currentRequest?.abortController.abort();
    const requestAbort = new AbortController();
    this.currentRequest = { correlationId: input.correlationId, abortController: requestAbort };
    const emit = (step: StygianAdvisorProgressStep) =>
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
              details: { available: 0 }
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
            { code: 'SCENARIO_MISMATCH', path: ['scenarioId'], message: scenarioView.message }
          ])
        );
      }
      if (scenarioView.trust === 'production' && !scenarioView.usableForRecommendation) {
        return finish(
          blocked([
            {
              code: 'SCENARIO_MISMATCH',
              path: ['scenarioId'],
              message: '当前仅有过期或无法判断时效的挑战资料；可查看，但不能据此生成本期方案。'
            }
          ])
        );
      }
      const scenario = scenarioView.scenario;
      auditReuseRule = scenario.crossPartyReusePolicy.rule;
      if (scenario.id !== input.scenarioId) {
        return finish(
          blocked([
            {
              code: 'SCENARIO_MISMATCH',
              path: ['scenarioId'],
              message: '所选场景已发生变化，请重新确认。'
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
              message: '挑战资料已更新，请重新确认难度。'
            }
          ])
        );
      }

      emit('allocating-parties');
      const localPreflight = buildLocalStygianPlan({
        input,
        scenario,
        characters: profile.characters,
        knowledge: this.options.knowledge
      });
      throwIfCancelled();
      if (localPreflight.status === 'blocked') return finish(localPreflight);

      let result: StygianAdvisorResult = localPreflight;
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
            allowedBusinessTools: [...STYGIAN_MCP_TOOL_NAMES]
          };
          const eligibleCharacterIds = profile.characters
            .map(({ id }) => String(id))
            .filter((id) => !input.excludedCharacterIds.includes(id));
          const pipelineContext = buildV2PipelineContext({
            correlationId: input.correlationId,
            profile,
            feasibleBaseline: localPreflight.plan,
            eligibleCharacterIds,
            locale: input.locale,
            mechanics: scenario.phases.map((phase) => ({
              target: `第 ${phase.phase} 阶段`,
              facts: [
                phase.boss.enemy.names['zh-CN'] ??
                  phase.boss.enemy.names['zh-Hans'] ??
                  '未命名首领',
                ...phase.phaseModifiers.map(({ description }) => description),
                ...phase.bossModifiers.map(({ description }) => description)
              ],
              unknowns: ['未在当期资料中标注的数值与首领行为保持未知。']
            })),
            interventions: {
              target: input.target,
              difficultyId: input.difficultyId,
              ...(input.phase ? { phase: input.phase } : {}),
              lockedCharacterIds: input.lockedCharacterIds,
              excludedCharacterIds: input.excludedCharacterIds,
              preferences: input.preferences
            },
            knowledge: {
              version: this.options.knowledge?.version ?? 'unavailable',
              unknownCharacterIds:
                this.options.knowledge?.coverageFor(eligibleCharacterIds).unknownCharacterIds ??
                eligibleCharacterIds
            }
          });
          const sdkOptionsForStage = (stage: V2AgentStage) => {
            if (stage === 'critique' || stage === 'rotation' || stage === 'explain') {
              return { ...baseSdkOptions, allowedBusinessTools: [] };
            }
            return {
              ...baseSdkOptions,
              mcpServers: {
                genshin: createStygianBusinessMcpServer({
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
            result = checkedAgentResult(
              agent.plan,
              localPreflight,
              profile,
              scenario,
              input,
              agent.critique,
              agent.rotation,
              agent.explanation
            );
          } else {
            result = addFallbackWarning(localPreflight);
          }
        } catch (error) {
          if (requestAbort.signal.aborted) throw new Error('cancelled');
          if (!timedOut && agentAbort.signal.aborted) throw error;
          result = addFallbackWarning(localPreflight);
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
      emit('checking-mechanics');
      emit('writing-guidance');
      throwIfCancelled();
      if (result.status === 'planned') this.persist(input, result, profile, scenarioView);
      return finish(result);
    } finally {
      if (this.currentRequest?.abortController === requestAbort) this.currentRequest = undefined;
    }
  }

  private persist(
    input: StygianAdvisorPlanInput,
    result: Extract<StygianAdvisorResult, { status: 'planned' }>,
    profile: PersistedProfile,
    scenarioView: Extract<StygianScenarioView, { status: 'ready' }>
  ): void {
    try {
      const difficulty = scenarioView.scenario.difficulties.find(
        ({ id }) => id === input.difficultyId
      );
      if (!difficulty) return;
      const usedIds = Array.from(
        new Set(result.plan.phases.flatMap(({ team }) => team.characterIds))
      );
      this.options.history.appendStygian({
        uid: input.uid,
        scenarioId: result.plan.scenarioId,
        playerCycle: createPlayerCycleSnapshot(scenarioView.scenario.meta),
        schemaVersion: result.plan.schemaVersion,
        dataVersion: result.plan.dataVersion,
        mode: 'stygian-onslaught',
        difficultyId: input.difficultyId,
        difficultyNames: difficulty.name.names,
        ...(input.phase === undefined ? {} : { phase: input.phase }),
        target: input.target,
        reusePolicy: scenarioView.scenario.crossPartyReusePolicy,
        source: result.source,
        scenarioTrust: scenarioView.trust,
        scenarioFreshness: scenarioView.freshness,
        scenarioNotCurrent: scenarioView.notCurrent,
        interventions: {
          locale: input.locale,
          lockedCharacterIds: input.lockedCharacterIds,
          excludedCharacterIds: input.excludedCharacterIds,
          target: input.target,
          difficultyId: input.difficultyId,
          preferences: input.preferences
        },
        narrative: result.narrative,
        characters: usedIds.flatMap((id) => {
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
        phaseGuidance: result.phaseGuidance,
        difficultyAssessment: result.difficultyAssessment,
        plan: result.plan
      });
    } catch {
      // History is secondary and cannot invalidate a checked result.
    }
  }
}

function checkedAgentResult(
  plan: Extract<StygianAdvisorResult, { status: 'planned' }>['plan'],
  local: Extract<StygianAdvisorResult, { status: 'planned' }>,
  profile: PersistedProfile,
  scenario: Extract<StygianScenarioView, { status: 'ready' }>['scenario'],
  input: StygianAdvisorPlanInput,
  critique: V2CritiqueOutput,
  rotation: V2RotationOutput,
  explanation: V2ExplainOutput
): StygianAdvisorResult {
  const selectedIds = Array.from(new Set(plan.phases.flatMap(({ team }) => team.characterIds)));
  const selectedCharacters = selectedIds.flatMap((id) => {
    const character = profile.characters.find(({ id: numericId }) => String(numericId) === id);
    return character ? [character] : [];
  });
  const difficulty = scenario.difficulties.find(({ id }) => id === input.difficultyId)!;
  const assessment = assessStygianDifficultyEvidence({
    difficultyOrder: difficulty.order,
    target: input.target,
    difficultyIdsByOrder: scenario.difficulties
      .slice()
      .sort((left, right) => left.order - right.order)
      .map(({ id }) => id),
    selectedCharacters
  });
  const confidence =
    assessment.recommendation === 'lower-difficulty'
      ? 'low'
      : assessment.recommendation === 'proceed-with-caution' && plan.confidence === 'high'
        ? 'medium'
        : plan.confidence;
  return stygianAdvisorResultSchema.parse({
    ...local,
    source: 'smart-service',
    warnings: Array.from(new Set([...local.warnings, ...plan.warnings])),
    assumptions: Array.from(new Set([...local.assumptions, ...plan.assumptions])),
    narrative: renderV2Narrative({
      mode: 'stygian-onslaught',
      locale: input.locale,
      critique,
      rotation,
      explanation
    }),
    plan: {
      ...plan,
      confidence,
      warnings: Array.from(new Set([...local.warnings, ...plan.warnings])),
      assumptions: Array.from(new Set([...local.assumptions, ...plan.assumptions]))
    },
    phaseGuidance: local.phaseGuidance.map((guidance) => ({
      ...guidance,
      mechanismBasis: [...guidance.mechanismBasis],
      risks: [
        ...guidance.risks,
        ...critique.issues
          .filter(
            ({ target }) => target.kind === 'stygian-phase' && target.phase === guidance.phase
          )
          .map(({ message }) => message)
      ]
    })),
    difficultyAssessment: assessment
  });
}

function addFallbackWarning(
  result: Extract<StygianAdvisorResult, { status: 'planned' }>
): StygianAdvisorResult {
  const warning = '智能服务未能给出通过检查的方案，已改用更保守的本地规则。';
  return stygianAdvisorResultSchema.parse({
    ...result,
    source: 'local-rules',
    warnings: [warning, ...result.warnings],
    plan: { ...result.plan, warnings: [warning, ...result.plan.warnings] }
  });
}

function addPlanWarning(
  result: Extract<StygianAdvisorResult, { status: 'planned' }>,
  warning: string
): Extract<StygianAdvisorResult, { status: 'planned' }> {
  return stygianAdvisorResultSchema.parse({
    ...result,
    warnings: [warning, ...result.warnings],
    plan: { ...result.plan, warnings: [warning, ...result.plan.warnings] }
  }) as Extract<StygianAdvisorResult, { status: 'planned' }>;
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

function blocked(issues: StygianPlanIssue[]): StygianAdvisorResult {
  return stygianAdvisorResultSchema.parse({
    status: 'blocked',
    source: 'local-rules',
    issues,
    warnings: [],
    assumptions: []
  });
}
