import type { CharacterProfile } from '../../shared/domain.js';
import {
  type AbyssAdvisorPlanInput,
  type AbyssPlanIssue,
  type AbyssPlanOutput,
  type AbyssScenario
} from '../../shared/abyss-advisor.js';
import {
  ABYSS_COMPOSER_PROMPT_V1,
  ABYSS_REPAIR_PROMPT_V1
} from '../agents/abyss-composer/prompt.js';
import type {
  V2CritiqueOutput,
  V2ExplainOutput,
  V2PipelineContext,
  V2RotationOutput
} from '../agents/contracts.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import type { AgentUsage, ToolAudit } from './agent-turn-audit.js';
import { validateAbyssPlan } from './abyss-plan-validator.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import { runV2AgentPipeline, type V2AgentStage } from './v2-agent-pipeline.js';
import type { AgentRunTraceWriter } from './agent-run-trace-store.js';

export interface AbyssPlanAgentRunner {
  run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown>;
}

export interface AbyssPlanAgentInput {
  input: AbyssAdvisorPlanInput;
  scenario: AbyssScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  pipelineContext: V2PipelineContext;
  sdkOptions: AgentSdkRunOptions;
  sdkOptionsForStage?: (stage: V2AgentStage) => AgentSdkRunOptions;
  onUsageDelta?: (usage: AgentUsage) => void;
}

export type AbyssPlanAgentResult =
  | {
      ok: true;
      repaired: boolean;
      repairs: number;
      plan: AbyssPlanOutput;
      critique: V2CritiqueOutput;
      rotation: V2RotationOutput;
      explanation: V2ExplainOutput;
      usage: AgentUsage;
    }
  | { ok: false; issues: AbyssPlanIssue[]; usage: AgentUsage };

export class AbyssPlanAgent {
  constructor(
    private readonly runner: AbyssPlanAgentRunner,
    private readonly trace?: AgentRunTraceWriter
  ) {}

  async compose(context: AbyssPlanAgentInput): Promise<AbyssPlanAgentResult> {
    const result = await runV2AgentPipeline<AbyssPlanOutput, AbyssPlanIssue>({
      runner: this.runner,
      context: context.pipelineContext,
      trace: this.trace,
      onUsageDelta: context.onUsageDelta,
      sdkOptionsForStage: context.sdkOptionsForStage ?? (() => context.sdkOptions),
      composer: {
        initialPrompt: buildComposePayload(context),
        systemPrompt: ABYSS_COMPOSER_PROMPT_V1,
        repairPrompt: ABYSS_REPAIR_PROMPT_V1,
        validate: (text, tools) => validateAgentOutput(text, context, tools)
      },
      invalidIssue: (stage, message) => ({
        code: 'AGENT_OUTPUT_INVALID' as const,
        path: [stage],
        message
      })
    });
    if (!result.ok) return { ok: false, issues: result.issues, usage: result.usage };
    const plan = applyAbyssStageOutputs(result.plan, result.critique);
    return {
      ok: true,
      repaired: result.repairs > 0,
      repairs: result.repairs,
      plan,
      critique: result.critique,
      rotation: result.rotation,
      explanation: result.explanation,
      usage: result.usage
    };
  }
}

function validateAgentOutput(
  raw: string,
  context: Pick<AbyssPlanAgentInput, 'input' | 'scenario' | 'characters' | 'knowledge'>,
  tools: ToolAudit[]
): { ok: true; plan: AbyssPlanOutput } | { ok: false; issues: AbyssPlanIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: 'AGENT_OUTPUT_INVALID',
          path: [],
          message: '智能服务没有返回完整 JSON 方案。'
        }
      ]
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      issues: [
        {
          code: 'AGENT_OUTPUT_INVALID',
          path: [],
          message: '智能服务返回的内容不是方案对象。'
        }
      ]
    };
  }
  const toolIssue = validateRequiredTools(context, tools, parsed);
  if (toolIssue) return { ok: false, issues: [toolIssue] };
  return validateAbyssPlan({ ...context, plan: parsed });
}

function validateRequiredTools(
  context: Pick<AbyssPlanAgentInput, 'input' | 'scenario' | 'characters'>,
  tools: ToolAudit[],
  plan: Record<string, unknown>
): AbyssPlanIssue | undefined {
  const successful = tools.filter(({ succeeded }) => succeeded);
  const has = (name: string, predicate: (input: Record<string, unknown>) => boolean = () => true) =>
    successful.some((use) => use.name === name && predicate(use.input));
  const missing: string[] = [];
  const plannedIds = ['firstHalfTeam', 'secondHalfTeam'].flatMap((key) => {
    const team = isRecord(plan[key]) ? plan[key] : {};
    return Array.isArray(team['characterIds'])
      ? team['characterIds'].filter((id): id is string => typeof id === 'string')
      : [];
  });
  const ownedIds = new Set(context.characters.map(({ id }) => String(id)));
  const plannedOwnedIds = plannedIds.filter((id) => ownedIds.has(id));
  const detailedProfileIds = new Set(
    successful
      .filter(
        ({ name, input }) =>
          name === 'mcp__genshin__read_profile_cache' && input['uid'] === context.input.uid
      )
      .flatMap(({ input }) =>
        Array.isArray(input['characterIds'])
          ? input['characterIds'].filter((id): id is string => typeof id === 'string')
          : []
      )
  );
  if (plannedOwnedIds.length === 0 || plannedOwnedIds.some((id) => !detailedProfileIds.has(id))) {
    missing.push('read_profile_cache:selected-character-details');
  }
  const queriedCharacterIds = new Set(
    successful
      .filter(({ name }) => name === 'mcp__genshin__query_genshin_db')
      .flatMap(({ input }) =>
        Array.isArray(input['characterIds'])
          ? input['characterIds'].filter((id): id is string => typeof id === 'string')
          : []
      )
  );
  if (plannedIds.length === 0 || plannedIds.some((id) => !queriedCharacterIds.has(id))) {
    missing.push('query_genshin_db:selected-characters');
  }

  const targetFloor = context.scenario.floors.find(({ floor }) => floor === context.input.floor);
  const targetChambers =
    targetFloor?.chambers.filter(
      ({ chamber }) => context.input.chamber === undefined || chamber === context.input.chamber
    ) ?? [];
  targetChambers.forEach(({ chamber }) => {
    if (
      !has(
        'mcp__genshin__query_enemy_data',
        (input) =>
          input['scenarioId'] === context.scenario.id &&
          input['dataVersion'] === context.scenario.meta.dataVersion &&
          input['floor'] === context.input.floor &&
          input['chamber'] === chamber
      )
    ) {
      missing.push(`query_enemy_data:${context.input.floor}-${chamber}`);
    }
  });
  if (missing.length === 0) return undefined;
  return {
    code: 'AGENT_OUTPUT_INVALID',
    path: ['tools'],
    message: '智能服务没有成功读取生成方案所需的全部角色与逐房间敌情。',
    details: { missing }
  };
}

function buildComposePayload(context: AbyssPlanAgentInput): string {
  return JSON.stringify({
    task: '联合生成深境螺旋上下半固定双队',
    request: publicRequest(context),
    availableCharacterIds: context.characters.map(({ id }) => String(id)),
    toolPolicy: {
      required: ['read_profile_cache', 'query_enemy_data', 'query_genshin_db'],
      unknownMeansUnknown: true
    }
  });
}

function publicRequest(context: Pick<AbyssPlanAgentInput, 'input' | 'scenario'>) {
  return {
    uid: context.input.uid,
    scenarioId: context.scenario.id,
    dataVersion: context.scenario.meta.dataVersion,
    locale: context.input.locale,
    floor: context.input.floor,
    chamber: context.input.chamber,
    preferences: context.input.preferences,
    lockedCharacterIds: context.input.lockedCharacterIds,
    excludedCharacterIds: context.input.excludedCharacterIds,
    ...(context.input.priorPlan && context.input.recomputeHalf
      ? {
          recomputeHalf: context.input.recomputeHalf,
          priorPlan: context.input.priorPlan,
          preservationRule:
            context.input.recomputeHalf === 'firstHalf'
              ? 'secondHalfTeam 与每个 chambers.secondHalf 必须逐字段保持不变'
              : 'firstHalfTeam 与每个 chambers.firstHalf 必须逐字段保持不变'
        }
      : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyAbyssStageOutputs(
  plan: AbyssPlanOutput,
  critique: V2CritiqueOutput
): AbyssPlanOutput {
  return {
    ...plan,
    chambers: plan.chambers.map((chamber) => {
      const enrich = (half: 'first' | 'second') => {
        const current = half === 'first' ? chamber.firstHalf : chamber.secondHalf;
        const risks = critique.issues
          .filter(
            ({ target }) =>
              target.kind === 'abyss-chamber' &&
              target.floor === chamber.floor &&
              target.chamber === chamber.chamber &&
              target.half === half
          )
          .map(({ message }) => message);
        return {
          ...current,
          risks: [...current.risks, ...risks]
        };
      };
      return {
        ...chamber,
        firstHalf: enrich('first'),
        secondHalf: enrich('second')
      };
    })
  };
}
