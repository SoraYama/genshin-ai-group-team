import type { CharacterProfile } from '../../shared/domain.js';
import type {
  TheaterAdvisorPlanInput,
  TheaterPlanIssue,
  TheaterPlanOutput,
  TheaterScenario
} from '../../shared/theater-advisor.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import {
  THEATER_COMPOSER_PROMPT_V1,
  THEATER_REPAIR_PROMPT_V1
} from '../agents/theater-composer/prompt.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import {
  addAgentUsage,
  runAuditedAgentTurn,
  type AgentUsage,
  type AuditedAgentRunner,
  type ToolAudit
} from './agent-turn-audit.js';
import { validateTheaterPlan } from './theater-plan-validator.js';

export type TheaterPlanAgentRunner = AuditedAgentRunner;
export interface TheaterPlanAgentInput {
  input: TheaterAdvisorPlanInput;
  scenario: TheaterScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  sdkOptions: AgentSdkRunOptions;
  sdkOptionsForRound?: (round: 'compose' | 'repair') => AgentSdkRunOptions;
}
export type TheaterPlanAgentResult =
  | {
      ok: true;
      repaired: boolean;
      plan: TheaterPlanOutput;
      vigorBudget: Array<{ act: number; before: number; spent: number; after: number }>;
      usage: AgentUsage;
    }
  | { ok: false; issues: TheaterPlanIssue[]; usage: AgentUsage };

export class TheaterPlanAgent {
  constructor(private readonly runner: TheaterPlanAgentRunner) {}
  async compose(context: TheaterPlanAgentInput): Promise<TheaterPlanAgentResult> {
    const compose = await runAuditedAgentTurn({
      runner: this.runner,
      prompt: composePayload(context),
      sdkOptions: context.sdkOptionsForRound?.('compose') ?? context.sdkOptions,
      systemPrompt: THEATER_COMPOSER_PROMPT_V1,
      auditContext: { correlationId: context.input.correlationId, round: 'compose' }
    });
    const first = validateOutput(compose.text, context, compose.tools);
    if (first.ok) return { ...first, repaired: false, usage: compose.usage };
    const repair = await runAuditedAgentTurn({
      runner: this.runner,
      prompt: JSON.stringify({
        instruction: '只修复以下确定性问题，并返回完整路线方案。',
        issues: first.issues,
        previousOutput: parseOrRaw(compose.text),
        request: publicRequest(context)
      }),
      sdkOptions: context.sdkOptionsForRound?.('repair') ?? context.sdkOptions,
      systemPrompt: `${THEATER_COMPOSER_PROMPT_V1}\n\n${THEATER_REPAIR_PROMPT_V1}`,
      auditContext: { correlationId: context.input.correlationId, round: 'repair' }
    });
    const repaired = validateOutput(repair.text, context, repair.tools);
    const usage = addAgentUsage(compose.usage, repair.usage);
    return repaired.ok ? { ...repaired, repaired: true, usage } : { ...repaired, usage };
  }
}

function validateOutput(raw: string, context: TheaterPlanAgentInput, tools: ToolAudit[]) {
  let plan: unknown;
  try {
    plan = JSON.parse(raw);
  } catch {
    return invalid('智能服务没有返回完整 JSON 路线。');
  }
  const toolIssue = requiredTools(context, tools, plan);
  if (toolIssue) return { ok: false as const, issues: [toolIssue] };
  return validateTheaterPlan({ ...context, plan });
}

function requiredTools(
  context: TheaterPlanAgentInput,
  tools: ToolAudit[],
  plan: unknown
): TheaterPlanIssue | undefined {
  const successful = tools.filter(({ succeeded }) => succeeded);
  const has = (name: string, predicate: (input: Record<string, unknown>) => boolean = () => true) =>
    successful.some((use) => use.name === name && predicate(use.input));
  const missing: string[] = [];
  if (!has('mcp__genshin__read_profile_cache', (value) => value['uid'] === context.input.uid))
    missing.push('read_profile_cache');
  const targetActs = context.scenario.acts
    .filter(({ act }) => context.input.act === undefined || context.input.act === act)
    .map(({ act }) => act);
  targetActs.forEach((act) => {
    if (
      !has(
        'mcp__genshin__query_theater_act',
        (value) =>
          value['scenarioId'] === context.scenario.id &&
          value['dataVersion'] === context.scenario.meta.dataVersion &&
          value['act'] === act
      )
    )
      missing.push(`query_theater_act:${act}`);
  });
  const cast = isRecord(plan) && isRecord(plan['cast']) ? plan['cast'] : undefined;
  const castKeys = [
    'selectedCharacterIds',
    'openingCharacterIds',
    'trialCharacterIds',
    'specialGuestCharacterIds',
    'supportCharacterIds'
  ] as const;
  const selected = cast
    ? castKeys.flatMap((key) =>
        Array.isArray(cast[key])
          ? cast[key].filter((id): id is string => typeof id === 'string')
          : []
      )
    : [];
  const candidates =
    isRecord(plan) && Array.isArray(plan['acts'])
      ? plan['acts'].flatMap((act) =>
          isRecord(act) && Array.isArray(act['candidateCharacterIds'])
            ? act['candidateCharacterIds'].filter((id): id is string => typeof id === 'string')
            : []
        )
      : [];
  const requiredKnowledgeIds = [...new Set([...selected, ...candidates])];
  const queried = new Set(
    successful
      .filter(({ name }) => name === 'mcp__genshin__query_genshin_db')
      .flatMap(({ input }) =>
        Array.isArray(input['characterIds'])
          ? input['characterIds'].filter((id): id is string => typeof id === 'string')
          : []
      )
  );
  if (requiredKnowledgeIds.length === 0 || requiredKnowledgeIds.some((id) => !queried.has(id)))
    missing.push('query_genshin_db:all-cast-and-candidates');
  return missing.length === 0
    ? undefined
    : {
        code: 'AGENT_OUTPUT_INVALID',
        path: ['tools'],
        message: '智能服务没有成功读取本轮方案所需的角色、幕次与角色知识。',
        details: { missing }
      };
}

function composePayload(context: TheaterPlanAgentInput): string {
  return JSON.stringify({
    task: '生成幻想真境剧诗演员池、活力与逐幕路线',
    request: publicRequest(context),
    availableCharacterIds: context.characters.map(({ id }) => String(id)),
    toolPolicy: {
      required: ['read_profile_cache', 'query_theater_act:each-target-act', 'query_genshin_db'],
      unknownMeansUnknown: true
    }
  });
}
function publicRequest(context: TheaterPlanAgentInput) {
  const { input, scenario } = context;
  return {
    uid: input.uid,
    scenarioId: scenario.id,
    dataVersion: scenario.meta.dataVersion,
    ...(input.act === undefined ? {} : { act: input.act }),
    target: input.target,
    preferences: input.preferences,
    selectedCharacterIds: input.selectedCharacterIds,
    excludedCharacterIds: input.excludedCharacterIds,
    castInterventions: {
      opening: input.selectedOpeningCharacterIds,
      trial: input.selectedTrialCharacterIds,
      specialGuest: input.selectedSpecialGuestCharacterIds,
      support: input.selectedSupportCharacterIds
    }
  };
}
function invalid(message: string) {
  return {
    ok: false as const,
    issues: [{ code: 'AGENT_OUTPUT_INVALID' as const, path: [], message }]
  };
}
function parseOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { invalidOutput: true };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
