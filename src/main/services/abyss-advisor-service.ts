import type { PersistedProfile } from '../../shared/domain.js';
import {
  abyssAdvisorPlanInputSchema,
  abyssAdvisorResultSchema,
  type AbyssAdvisorPlanInput,
  type AbyssAdvisorProgressStep,
  type AbyssAdvisorResult,
  type AbyssPlanIssue,
  type AbyssScenarioView
} from '../../shared/abyss-advisor.js';
import type { AbyssPlanHistoryEntry } from '../../shared/domain.js';
import { ABYSS_MCP_TOOL_NAMES, createAbyssBusinessMcpServer } from './abyss-business-tools.js';
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
  };
  sdkEnvironment: { cwd: string; clientVersion: string };
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
    progress: (step: AbyssAdvisorProgressStep) => void = () => undefined
  ): Promise<AbyssAdvisorResult> {
    progress('reading-roster');
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

    progress('analyzing-rules');
    const scenarioView = await this.options.scenarioService.getView();
    if (scenarioView.status !== 'ready') {
      return blocked([
        {
          code: 'SCENARIO_MISMATCH',
          path: ['scenarioId'],
          message: scenarioView.message
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

    progress('generating-teams');
    const localPreflight = buildLocalAbyssPlan({ input, scenario, characters: profile.characters });
    if (localPreflight.status === 'blocked') return localPreflight;

    let result: AbyssAdvisorResult = localPreflight;
    const apiKey = this.options.config.getApiKey();
    if (apiKey) {
      this.currentAbort?.abort();
      const abortController = new AbortController();
      this.currentAbort = abortController;
      try {
        const mcpServer = createAbyssBusinessMcpServer({
          getProfile: (uid) => (uid === input.uid ? profile : null),
          getScenario: () => scenario,
          getCharacter: (id) =>
            profile.characters.find(({ id: numericId }) => String(numericId) === id)
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
            abortController,
            maxTurns: 4,
            mcpServers: { genshin: mcpServer },
            allowedBusinessTools: [...ABYSS_MCP_TOOL_NAMES]
          }
        });
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
        if (abortController.signal.aborted) throw error;
        result = addAgentFallbackWarning(localPreflight);
      } finally {
        if (this.currentAbort === abortController) this.currentAbort = undefined;
      }
    }

    progress('checking-conflicts');
    progress('writing-tactics');
    if (result.status === 'planned') this.persist(input, result);
    return result;
  }

  private persist(
    input: AbyssAdvisorPlanInput,
    result: Extract<AbyssAdvisorResult, { status: 'planned' }>
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
        interventions: {
          lockedCharacterIds: input.lockedCharacterIds,
          excludedCharacterIds: input.excludedCharacterIds,
          preferences: input.preferences
        },
        plan: result.plan
      });
    } catch {
      // History is secondary; a persistence failure never invalidates an already checked plan.
    }
  }
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
