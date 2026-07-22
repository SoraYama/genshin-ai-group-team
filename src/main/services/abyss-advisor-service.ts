import type { PersistedProfile } from '../../shared/domain.js';
import {
  abyssAdvisorPlanInputSchema,
  abyssAdvisorResultSchema,
  type AbyssAdvisorPlanInput,
  type AbyssAdvisorProgressEvent,
  type AbyssAdvisorProgressStep,
  type AbyssAdvisorResult,
  type AbyssPlanIssue,
  type AbyssScenarioView
} from '../../shared/abyss-advisor.js';
import type { AbyssPlanHistoryEntry } from '../../shared/domain.js';
import {
  ABYSS_MCP_TOOL_NAMES,
  createAbyssBusinessMcpServer,
  type AbyssBusinessToolLog
} from './abyss-business-tools.js';
import { buildLocalAbyssPlan } from './abyss-local-optimizer.js';
import { AbyssPlanAgent, type AbyssPlanAgentRunner } from './abyss-plan-agent.js';

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
}

export class AbyssAdvisorService {
  private currentAbort: AbortController | undefined;
  private readonly planAgent: AbyssPlanAgent;

  constructor(private readonly options: AbyssAdvisorServiceOptions) {
    this.planAgent = new AbyssPlanAgent(options.runner);
  }

  cancel(): boolean {
    if (!this.currentAbort) return false;
    this.currentAbort.abort();
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
    this.currentAbort?.abort();
    const requestAbort = new AbortController();
    this.currentAbort = requestAbort;
    const emit = (step: AbyssAdvisorProgressStep) =>
      progress({ correlationId: input.correlationId, step });
    const throwIfCancelled = () => {
      if (requestAbort.signal.aborted) throw new Error('cancelled');
    };

    try {
      emit('reading-roster');
      const profile = this.options.profiles.get(input.uid);
      if (!profile) {
        return blocked([
          {
            code: 'ROSTER_INSUFFICIENT',
            path: ['profile'],
            message: '没有找到该 UID 的本地角色资料。',
            details: { required: 8, available: 0, missing: 8 }
          }
        ]);
      }

      emit('analyzing-rules');
      const scenarioView = await abortable(
        this.options.scenarioService.getView(),
        requestAbort.signal
      );
      throwIfCancelled();
      if (scenarioView.status !== 'ready') {
        return blocked([
          {
            code: 'SCENARIO_MISMATCH',
            path: ['scenarioId'],
            message: scenarioView.message
          }
        ]);
      }
      if (scenarioView.trust === 'production' && scenarioView.notCurrent) {
        return blocked([
          {
            code: 'SCENARIO_MISMATCH',
            path: ['scenarioId'],
            message: '当前仅有过期或刷新失败的挑战资料；可查看敌情，但不能据此生成本期方案。'
          }
        ]);
      }
      const scenario = scenarioView.scenario;
      if (scenario.id !== input.scenarioId) {
        return blocked([
          {
            code: 'SCENARIO_MISMATCH',
            path: ['scenarioId'],
            message: '所选场景已发生变化，请重新选择。'
          }
        ]);
      }
      if (scenario.meta.dataVersion !== input.dataVersion) {
        return blocked([
          {
            code: 'DATA_VERSION_MISMATCH',
            path: ['dataVersion'],
            message: '挑战资料已更新，请重新确认楼层与房间。'
          }
        ]);
      }

      emit('generating-teams');
      const localPreflight = buildLocalAbyssPlan({
        input,
        scenario,
        characters: profile.characters
      });
      throwIfCancelled();
      if (localPreflight.status === 'blocked') return localPreflight;

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
          const mcpServer = createAbyssBusinessMcpServer({
            getProfile: (uid) => (uid === input.uid ? profile : null),
            getScenario: () => scenario,
            getCharacter: (id) =>
              profile.characters.find(({ id: numericId }) => String(numericId) === id),
            log: this.options.toolLog
          });
          const agent = await this.planAgent.compose({
            input,
            scenario,
            characters: profile.characters,
            sdkOptions: {
              apiKey,
              baseUrl: this.options.config.getBaseUrl(),
              model: this.options.config.getModel(),
              customHeaders: this.options.config.getCustomHeaders(),
              systemPrompt: '',
              cwd: this.options.sdkEnvironment.cwd,
              clientVersion: this.options.sdkEnvironment.clientVersion,
              abortController: agentAbort,
              maxTurns: 4,
              mcpServers: { genshin: mcpServer },
              allowedBusinessTools: [...ABYSS_MCP_TOOL_NAMES]
            }
          });
          this.options.config.recordUsage?.(
            agent.usage.inputTokens,
            agent.usage.outputTokens,
            agent.usage.estimatedCostUsd
          );
          throwIfCancelled();
          if (agent.ok) {
            result = abyssAdvisorResultSchema.parse({
              status: 'planned',
              source: 'smart-service',
              issues: [],
              warnings: agent.plan.warnings,
              assumptions: agent.plan.assumptions,
              plan: agent.plan
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

      throwIfCancelled();
      emit('checking-conflicts');
      emit('writing-tactics');
      throwIfCancelled();
      if (result.status === 'planned') this.persist(input, result, profile, scenarioView);
      return result;
    } finally {
      if (this.currentAbort === requestAbort) this.currentAbort = undefined;
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
        schemaVersion: result.plan.schemaVersion,
        dataVersion: result.plan.dataVersion,
        mode: 'spiral-abyss',
        target: { floor: input.floor, ...(input.chamber ? { chamber: input.chamber } : {}) },
        source: result.source,
        scenarioTrust: scenarioView.trust,
        scenarioFreshness: scenarioView.freshness,
        scenarioNotCurrent: scenarioView.notCurrent,
        interventions: {
          lockedCharacterIds: input.lockedCharacterIds,
          excludedCharacterIds: input.excludedCharacterIds,
          preferences: input.preferences
        },
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

function blocked(issues: AbyssPlanIssue[]): AbyssAdvisorResult {
  return abyssAdvisorResultSchema.parse({
    status: 'blocked',
    source: 'local-rules',
    issues,
    warnings: [],
    assumptions: []
  });
}
