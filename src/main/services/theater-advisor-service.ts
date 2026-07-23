import type { PersistedProfile, TheaterPlanHistoryEntry } from '../../shared/domain.js';
import { createPlayerCycleSnapshot } from '../../shared/history-snapshot.js';
import {
  theaterAdvisorPlanInputSchema,
  theaterAdvisorResultSchema,
  type TheaterAdvisorPlanInput,
  type TheaterAdvisorProgressEvent,
  type TheaterAdvisorProgressStep,
  type TheaterAdvisorResult,
  type TheaterPlanIssue,
  type TheaterScenarioView
} from '../../shared/theater-advisor.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import {
  THEATER_MCP_TOOL_NAMES,
  createTheaterBusinessMcpServer,
  type TheaterBusinessToolLog
} from './theater-business-tools.js';
import { evaluateTheaterEligibility } from './theater-eligibility.js';
import { buildLocalTheaterPlan } from './theater-local-planner.js';
import { TheaterPlanAgent, type TheaterPlanAgentRunner } from './theater-plan-agent.js';
import { buildV2PipelineContext } from './v2-agent-context.js';
import type { V2AgentStage } from './v2-agent-pipeline.js';
import { renderV2Narrative } from './v2-narrative.js';

export interface TheaterAdvisorServiceOptions {
  runner: TheaterPlanAgentRunner;
  scenarioService: { getView: () => Promise<TheaterScenarioView> };
  profiles: { get: (uid: string) => PersistedProfile | null | undefined };
  history: {
    appendTheater: (
      input: Omit<TheaterPlanHistoryEntry, 'id' | 'createdAt'>
    ) => TheaterPlanHistoryEntry | void;
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
  planningDelayMs?: number;
  toolLog?: (event: TheaterBusinessToolLog) => void;
  auditLog?: (event: TheaterAdvisorAuditLog) => void;
  knowledge?: CharacterKnowledgeReader;
}

export interface TheaterAdvisorAuditLog {
  correlationId: string;
  scenarioId: string;
  dataVersion: string;
  knowledgeVersion: string;
  outcome: 'planned' | 'blocked' | 'history-write-failed';
  source: TheaterAdvisorResult['source'];
  issueCodes: string[];
  parameterSummary: Readonly<{
    target: TheaterAdvisorPlanInput['target'];
    act: number | 'all';
    selectedCount: number;
    excludedCount: number;
  }>;
}

export class TheaterAdvisorService {
  private currentRequest: { correlationId: string; abortController: AbortController } | undefined;
  private readonly planAgent: TheaterPlanAgent;

  constructor(private readonly options: TheaterAdvisorServiceOptions) {
    this.planAgent = new TheaterPlanAgent(options.runner);
  }

  cancel(correlationId: string): boolean {
    if (!this.currentRequest || this.currentRequest.correlationId !== correlationId) return false;
    this.currentRequest.abortController.abort();
    return true;
  }

  async recommend(
    inputValue: TheaterAdvisorPlanInput,
    progress: (event: TheaterAdvisorProgressEvent) => void = () => undefined
  ): Promise<TheaterAdvisorResult> {
    const parsed = theaterAdvisorPlanInputSchema.safeParse(inputValue);
    if (!parsed.success) {
      return blockedResult({
        correlationId: inputValue.correlationId || 'invalid-request',
        trust: 'production',
        freshness: 'unknown',
        issues: [{ code: 'INPUT_INVALID', path: [], message: '路线条件格式不正确。' }]
      });
    }
    const input = parsed.data;
    const finish = (result: TheaterAdvisorResult) => {
      try {
        this.options.auditLog?.({
          correlationId: input.correlationId,
          scenarioId: input.scenarioId,
          dataVersion: input.dataVersion,
          knowledgeVersion: this.options.knowledge?.version ?? 'unavailable',
          outcome: result.status,
          source: result.source,
          issueCodes: [...new Set(result.issues.map(({ code }) => code))],
          parameterSummary: {
            target: input.target,
            act: input.act ?? 'all',
            selectedCount: input.selectedCharacterIds.length,
            excludedCount: input.excludedCharacterIds.length
          }
        });
      } catch {
        /* audit must not alter a checked plan */
      }
      return result;
    };
    this.currentRequest?.abortController.abort();
    const requestAbort = new AbortController();
    this.currentRequest = { correlationId: input.correlationId, abortController: requestAbort };
    const emit = (step: TheaterAdvisorProgressStep) =>
      progress({ correlationId: input.correlationId, step });
    const ensureActive = () => {
      if (requestAbort.signal.aborted) throw new Error('cancelled');
    };

    try {
      emit('reading-roster');
      const profile = this.options.profiles.get(input.uid);
      if (!profile)
        return finish(
          blockedResult({
            correlationId: input.correlationId,
            trust: 'production',
            freshness: 'unknown',
            issues: [
              {
                code: 'ROSTER_INSUFFICIENT',
                path: ['profile'],
                message: '没有找到该 UID 的本地角色资料。'
              }
            ]
          })
        );
      const scenarioView = await abortable(
        this.options.scenarioService.getView(),
        requestAbort.signal
      );
      ensureActive();
      if (scenarioView.status !== 'ready')
        return finish(
          blockedResult({
            correlationId: input.correlationId,
            trust: 'production',
            freshness: 'unknown',
            issues: [
              { code: 'SCENARIO_MISMATCH', path: ['scenarioId'], message: scenarioView.message }
            ]
          })
        );
      const trust = scenarioView.trust;
      const freshness = scenarioView.freshness;
      if (trust === 'production' && !scenarioView.usableForRecommendation) {
        return finish(
          blockedResult({
            correlationId: input.correlationId,
            trust,
            freshness,
            issues: [
              {
                code: 'SCENARIO_MISMATCH',
                path: ['scenarioId'],
                message: '当前仅有过期或无法判断时效的剧诗资料；可查看，但不能据此生成本期路线。'
              }
            ]
          })
        );
      }
      const scenario = scenarioView.scenario;
      if (scenario.id !== input.scenarioId)
        return finish(
          blockedResult({
            correlationId: input.correlationId,
            trust,
            freshness,
            issues: [
              {
                code: 'SCENARIO_MISMATCH',
                path: ['scenarioId'],
                message: '所选剧诗周期已变化，请重新确认。'
              }
            ]
          })
        );
      if (scenario.meta.dataVersion !== input.dataVersion)
        return finish(
          blockedResult({
            correlationId: input.correlationId,
            trust,
            freshness,
            issues: [
              {
                code: 'DATA_VERSION_MISMATCH',
                path: ['dataVersion'],
                message: '剧诗资料已更新，请重新确认演员池。'
              }
            ]
          })
        );

      emit('checking-eligibility');
      const eligibility = evaluateTheaterEligibility({
        input,
        scenario,
        characters: profile.characters,
        knowledge: this.options.knowledge
      });
      if (eligibility.status === 'blocked') {
        return finish(
          blockedResult({
            correlationId: input.correlationId,
            trust,
            freshness,
            eligibility,
            issues: [
              {
                code: 'ROSTER_INSUFFICIENT',
                path: ['profile', 'characters'],
                message: `按已确认规则还缺 ${eligibility.shortage} 名可入场角色。`
              }
            ]
          })
        );
      }
      emit('planning-cast');
      const local = buildLocalTheaterPlan({
        input,
        scenario,
        characters: profile.characters,
        knowledge: this.options.knowledge,
        scenarioTrust: trust,
        scenarioFreshness: freshness
      });
      ensureActive();
      if (local.status === 'blocked') return finish(local);
      const planningDelayMs = Math.max(0, Math.min(this.options.planningDelayMs ?? 0, 1_000));
      if (planningDelayMs > 0) {
        await abortable(
          new Promise<void>((resolve) => setTimeout(resolve, planningDelayMs)),
          requestAbort.signal
        );
        ensureActive();
      }
      let result: TheaterAdvisorResult = local;
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
          const base = {
            apiKey,
            baseUrl: this.options.config.getBaseUrl(),
            model: this.options.config.getModel(),
            customHeaders: this.options.config.getCustomHeaders(),
            systemPrompt: '',
            cwd: this.options.sdkEnvironment.cwd,
            clientVersion: this.options.sdkEnvironment.clientVersion,
            abortController: agentAbort,
            maxTurns: 4,
            allowedBusinessTools: [...THEATER_MCP_TOOL_NAMES]
          };
          const eligibleCharacterIds = unique([
            ...eligibility.eligibleOwnedCharacterIds,
            ...local.plan.cast.openingCharacterIds,
            ...local.plan.cast.selectedCharacterIds,
            ...local.plan.cast.trialCharacterIds,
            ...local.plan.cast.specialGuestCharacterIds,
            ...local.plan.cast.supportCharacterIds,
            ...local.plan.acts.flatMap(({ candidateCharacterIds }) => candidateCharacterIds)
          ]);
          const pipelineContext = buildV2PipelineContext({
            correlationId: input.correlationId,
            profile,
            feasibleBaseline: local.plan,
            eligibleCharacterIds,
            locale: input.locale,
            mechanics: scenario.acts
              .filter(({ act }) => input.act === undefined || input.act === act)
              .map(({ act, encounters, pathNotes }) => ({
                target: `第 ${act} 幕`,
                facts: [
                  ...encounters.flatMap(({ waves }) =>
                    waves.flatMap(({ enemies }) =>
                      enemies.map(
                        ({ enemy }) =>
                          enemy.names['zh-CN'] ?? enemy.names['zh-Hans'] ?? '未命名敌人'
                      )
                    )
                  ),
                  ...pathNotes.map(({ text }) => text)
                ],
                unknowns: pathNotes.some(({ kind }) => kind === 'random')
                  ? ['随机路线的实际结果未知。']
                  : ['未在当期资料中标注的数值保持未知。']
              })),
            interventions: {
              target: input.target,
              ...(input.act ? { act: input.act } : {}),
              selectedCharacterIds: input.selectedCharacterIds,
              excludedCharacterIds: input.excludedCharacterIds,
              selectedOpeningCharacterIds: input.selectedOpeningCharacterIds,
              selectedTrialCharacterIds: input.selectedTrialCharacterIds,
              selectedSpecialGuestCharacterIds: input.selectedSpecialGuestCharacterIds,
              selectedSupportCharacterIds: input.selectedSupportCharacterIds,
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
              return { ...base, allowedBusinessTools: [] };
            }
            return {
              ...base,
              mcpServers: {
                genshin: createTheaterBusinessMcpServer({
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
            sdkOptions: base,
            sdkOptionsForStage,
            onUsageDelta: (usage) =>
              this.options.config.recordUsage?.(
                usage.inputTokens,
                usage.outputTokens,
                usage.estimatedCostUsd
              )
          });
          ensureActive();
          result = agent.ok
            ? theaterAdvisorResultSchema.parse({
                ...local,
                source: 'smart-service',
                plan: agent.plan,
                vigorBudget: agent.vigorBudget,
                narrative: renderV2Narrative({
                  mode: 'imaginarium-theater',
                  locale: input.locale,
                  critique: agent.critique,
                  rotation: agent.rotation,
                  explanation: agent.explanation
                }),
                routeGuidance: {
                  ...local.routeGuidance,
                  notes: unique([
                    ...local.routeGuidance.notes,
                    ...agent.critique.issues.map(({ target, message }) =>
                      target.kind === 'theater-act'
                        ? `第 ${target.act} 幕风险：${message}`
                        : message
                    )
                  ])
                },
                warnings: unique([...local.warnings, ...agent.plan.warnings]),
                assumptions: unique([...local.assumptions, ...agent.plan.assumptions])
              })
            : fallback(local);
        } catch (error) {
          if (requestAbort.signal.aborted) throw new Error('cancelled');
          if (!timedOut && agentAbort.signal.aborted) throw error;
          result = fallback(local);
        } finally {
          clearTimeout(timeout);
          requestAbort.signal.removeEventListener('abort', cancelAgent);
        }
      }
      if (result.status === 'planned' && trust === 'production' && scenarioView.refreshWarning)
        result = warning(result, scenarioView.refreshWarning);
      emit('budgeting-vigor');
      emit('writing-route');
      ensureActive();
      if (result.status === 'planned') this.persist(input, result, profile, scenarioView);
      return finish(result);
    } finally {
      if (this.currentRequest?.abortController === requestAbort) this.currentRequest = undefined;
    }
  }

  private persist(
    input: TheaterAdvisorPlanInput,
    result: Extract<TheaterAdvisorResult, { status: 'planned' }>,
    profile: PersistedProfile,
    view: Extract<TheaterScenarioView, { status: 'ready' }>
  ) {
    try {
      const scenario = view.scenario;
      const poolSources = new Map<
        string,
        Array<'opening' | 'trial' | 'special-guest' | 'support'>
      >();
      (['opening', 'trial', 'specialGuest', 'support'] as const).forEach((key) =>
        scenario.pools[key].forEach(({ id }) => {
          const label = key === 'specialGuest' ? ('special-guest' as const) : key;
          poolSources.set(id, [...(poolSources.get(id) ?? []), label]);
        })
      );
      const planIds = unique([
        ...result.plan.cast.selectedCharacterIds,
        ...result.plan.cast.openingCharacterIds,
        ...result.plan.cast.trialCharacterIds,
        ...result.plan.cast.specialGuestCharacterIds,
        ...result.plan.cast.supportCharacterIds,
        ...result.plan.acts.flatMap(({ candidateCharacterIds }) => candidateCharacterIds)
      ]);
      const ownedById = new Map(
        profile.characters.map((character) => [String(character.id), character])
      );
      const entityById = new Map(
        Object.values(scenario.pools)
          .flat()
          .map((entry) => [entry.id, entry])
      );
      const sourceById = new Map<
        string,
        'owned' | 'opening' | 'trial' | 'special-guest' | 'support'
      >();
      result.plan.cast.selectedCharacterIds.forEach((id) => sourceById.set(id, 'owned'));
      result.plan.cast.openingCharacterIds.forEach((id) => sourceById.set(id, 'opening'));
      result.plan.cast.trialCharacterIds.forEach((id) => sourceById.set(id, 'trial'));
      result.plan.cast.specialGuestCharacterIds.forEach((id) =>
        sourceById.set(id, 'special-guest')
      );
      result.plan.cast.supportCharacterIds.forEach((id) => sourceById.set(id, 'support'));
      const plannedActs = new Set(result.plan.acts.map(({ act }) => act));
      const priorityIds = new Set(result.routeGuidance.arcanaPriorityIds);
      this.options.history.appendTheater({
        uid: input.uid,
        scenarioId: result.plan.scenarioId,
        playerCycle: createPlayerCycleSnapshot(scenario.meta),
        schemaVersion: 2,
        dataVersion: result.plan.dataVersion,
        mode: 'imaginarium-theater',
        ...(input.act === undefined ? {} : { act: input.act }),
        target: input.target,
        source: result.source,
        scenarioTrust: view.trust,
        scenarioFreshness: view.freshness,
        scenarioNotCurrent: view.notCurrent,
        interventions: input,
        eligibility: result.eligibility,
        cast: planIds.map((id) => {
          const owned = ownedById.get(id);
          const sources = poolSources.get(id) ?? [];
          const source = sourceById.get(id);
          if (!source) throw new Error('Validated plan actor source missing');
          if (source === 'owned') {
            if (!owned) throw new Error('Validated owned actor snapshot missing');
            return {
              id,
              name: owned.name,
              nameRef: { kind: 'profile-character' as const, id },
              element: owned.element,
              ...(owned.level === undefined ? {} : { level: owned.level }),
              source: 'owned' as const,
              ...(sources.length ? { poolSources: sources } : {})
            };
          }
          const entity = entityById.get(id);
          return {
            id,
            name: entity?.names['zh-CN'] ?? entity?.names['zh-Hans'] ?? owned?.name ?? '未命名演员',
            ...(entity ? { names: entity.names } : {}),
            nameRef: { kind: 'scenario-entity' as const, id },
            ...(owned?.element ? { element: owned.element } : {}),
            ...(owned?.level === undefined ? {} : { level: owned.level }),
            source,
            ...(sources.length ? { poolSources: sources } : {})
          };
        }),
        vigorBudget: result.vigorBudget,
        nodeBudget: result.nodeBudget,
        arcanaSnapshots: (scenario.arcanaNodes ?? [])
          .filter(({ id }) => priorityIds.has(id))
          .map(({ id, name }) => ({
            id,
            nameRef: name.id,
            names: name.names
          })),
        encounterSnapshots: scenario.acts
          .filter(({ act }) => plannedActs.has(act))
          .flatMap(({ act, encounters }) =>
            encounters.map(({ id: encounterId, waves }) => {
              const enemyById = new Map(
                waves
                  .flatMap(({ enemies }) => enemies)
                  .map(({ enemy }) => [enemy.id, enemy] as const)
              );
              return {
                act,
                encounterId,
                enemyRefs: [...enemyById.values()].map(({ id, names }) => ({ id, names }))
              };
            })
          ),
        routeGuidance: result.routeGuidance,
        narrative: result.narrative,
        plan: result.plan
      });
    } catch {
      try {
        this.options.auditLog?.({
          correlationId: input.correlationId,
          scenarioId: input.scenarioId,
          dataVersion: input.dataVersion,
          knowledgeVersion: this.options.knowledge?.version ?? 'unavailable',
          outcome: 'history-write-failed',
          source: result.source,
          issueCodes: ['HISTORY_WRITE_FAILED'],
          parameterSummary: {
            target: input.target,
            act: input.act ?? 'all',
            selectedCount: input.selectedCharacterIds.length,
            excludedCount: input.excludedCharacterIds.length
          }
        });
      } catch {
        /* secondary audit must not alter a checked plan */
      }
    }
  }
}

function fallback(
  result: Extract<TheaterAdvisorResult, { status: 'planned' }>
): TheaterAdvisorResult {
  const message = '智能服务未能给出通过检查的路线，已改用更保守的本地规则。';
  return theaterAdvisorResultSchema.parse({
    ...result,
    source: 'local-rules',
    warnings: [message, ...result.warnings],
    plan: { ...result.plan, warnings: [message, ...result.plan.warnings] }
  });
}
function warning(
  result: Extract<TheaterAdvisorResult, { status: 'planned' }>,
  message: string
): TheaterAdvisorResult {
  return theaterAdvisorResultSchema.parse({
    ...result,
    warnings: [message, ...result.warnings],
    plan: { ...result.plan, warnings: [message, ...result.plan.warnings] }
  });
}
function blockedResult(options: {
  correlationId: string;
  trust: 'production' | 'development-sample';
  freshness: 'fresh' | 'expiring' | 'stale' | 'unknown';
  issues: TheaterPlanIssue[];
  eligibility?: TheaterAdvisorResult['eligibility'];
}): TheaterAdvisorResult {
  return theaterAdvisorResultSchema.parse({
    status: 'blocked',
    correlationId: options.correlationId,
    source: 'local-rules',
    scenarioTrust: options.trust,
    scenarioFreshness: options.freshness,
    issues: options.issues,
    warnings: [],
    assumptions: [],
    eligibility: options.eligibility ?? {
      status: 'blocked',
      requiredHeadcount: 1,
      eligibleOwnedCount: 0,
      hardQualifiedCount: 0,
      shortage: 1,
      eligibleOwnedCharacterIds: [],
      ineligibleOwned: [],
      pools: [],
      constructionAdvice: [
        { kind: 'headcount-gap', missing: 1, note: '当前资料不足，暂时无法完成资格检查。' }
      ]
    }
  });
}
function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new Error('cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
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
