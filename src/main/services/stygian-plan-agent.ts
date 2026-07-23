import type { CharacterProfile } from '../../shared/domain.js';
import {
  type StygianAdvisorPlanInput,
  type StygianPlanIssue,
  type StygianPlanOutput,
  type StygianScenario
} from '../../shared/stygian-advisor.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import {
  STYGIAN_COMPOSER_PROMPT_V1,
  STYGIAN_REPAIR_PROMPT_V1
} from '../agents/stygian-composer/prompt.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import {
  addAgentUsage,
  runAuditedAgentTurn,
  type AgentUsage,
  type AuditedAgentRunner,
  type ToolAudit
} from './agent-turn-audit.js';
import { validateStygianPlan } from './stygian-plan-validator.js';

export type StygianPlanAgentRunner = AuditedAgentRunner;

export interface StygianPlanAgentInput {
  input: StygianAdvisorPlanInput;
  scenario: StygianScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  sdkOptions: AgentSdkRunOptions;
}

export type StygianPlanAgentResult =
  | { ok: true; repaired: boolean; plan: StygianPlanOutput; usage: AgentUsage }
  | { ok: false; issues: StygianPlanIssue[]; usage: AgentUsage };

export class StygianPlanAgent {
  constructor(private readonly runner: StygianPlanAgentRunner) {}

  async compose(context: StygianPlanAgentInput): Promise<StygianPlanAgentResult> {
    const firstTurn = await runAuditedAgentTurn({
      runner: this.runner,
      prompt: buildComposePayload(context),
      sdkOptions: context.sdkOptions,
      systemPrompt: STYGIAN_COMPOSER_PROMPT_V1
    });
    const first = validateAgentOutput(firstTurn.text, context, firstTurn.tools);
    if (first.ok) return { ok: true, repaired: false, plan: first.plan, usage: firstTurn.usage };

    const repairTurn = await runAuditedAgentTurn({
      runner: this.runner,
      prompt: JSON.stringify({
        instruction: '只修复以下确定性校验问题，并返回完整方案。',
        issues: first.issues,
        previousOutput: parseJsonOrRaw(firstTurn.text),
        request: publicRequest(context)
      }),
      sdkOptions: context.sdkOptions,
      systemPrompt: `${STYGIAN_COMPOSER_PROMPT_V1}\n\n${STYGIAN_REPAIR_PROMPT_V1}`
    });
    const repaired = validateAgentOutput(repairTurn.text, context, [
      ...firstTurn.tools,
      ...repairTurn.tools
    ]);
    const usage = addAgentUsage(firstTurn.usage, repairTurn.usage);
    if (!repaired.ok) return { ...repaired, usage };
    return { ok: true, repaired: true, plan: repaired.plan, usage };
  }
}

function validateAgentOutput(
  raw: string,
  context: Pick<StygianPlanAgentInput, 'input' | 'scenario' | 'characters' | 'knowledge'>,
  tools: ToolAudit[]
): { ok: true; plan: StygianPlanOutput } | { ok: false; issues: StygianPlanIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidOutput('智能服务没有返回完整 JSON 方案。');
  }
  if (!isRecord(parsed)) return invalidOutput('智能服务返回的内容不是方案对象。');
  const toolIssue = validateRequiredTools(context, tools, parsed);
  if (toolIssue) return { ok: false, issues: [toolIssue] };
  return validateStygianPlan({ ...context, plan: parsed });
}

function validateRequiredTools(
  context: Pick<StygianPlanAgentInput, 'input' | 'scenario'>,
  tools: ToolAudit[],
  plan: Record<string, unknown>
): StygianPlanIssue | undefined {
  const successful = tools.filter(({ succeeded }) => succeeded);
  const has = (name: string, predicate: (input: Record<string, unknown>) => boolean = () => true) =>
    successful.some((use) => use.name === name && predicate(use.input));
  const missing: string[] = [];
  if (!has('mcp__genshin__read_profile_cache', (value) => value['uid'] === context.input.uid)) {
    missing.push('read_profile_cache');
  }
  for (const phase of [1, 2, 3]) {
    if (
      !has(
        'mcp__genshin__query_stygian_phase',
        (value) =>
          value['scenarioId'] === context.scenario.id &&
          value['dataVersion'] === context.scenario.meta.dataVersion &&
          value['difficultyId'] === context.input.difficultyId &&
          value['phase'] === phase
      )
    ) {
      missing.push(`query_stygian_phase:${phase}`);
    }
  }
  const plannedIds = Array.isArray(plan['phases'])
    ? plan['phases'].flatMap((phase) => {
        if (!isRecord(phase) || !isRecord(phase['team'])) return [];
        const ids = phase['team']['characterIds'];
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
      })
    : [];
  const queriedIds = new Set(
    successful
      .filter(({ name }) => name === 'mcp__genshin__query_genshin_db')
      .flatMap(({ input }) =>
        Array.isArray(input['characterIds'])
          ? input['characterIds'].filter((id): id is string => typeof id === 'string')
          : []
      )
  );
  if (plannedIds.length === 0 || plannedIds.some((id) => !queriedIds.has(id))) {
    missing.push('query_genshin_db:selected-characters');
  }
  if (missing.length === 0) return undefined;
  return {
    code: 'AGENT_OUTPUT_INVALID',
    path: ['tools'],
    message: '智能服务没有成功读取生成方案所需的角色与三阶段首领资料。',
    details: { missing }
  };
}

function buildComposePayload(context: StygianPlanAgentInput): string {
  return JSON.stringify({
    task: '联合生成幽境危战三阶段队伍',
    request: publicRequest(context),
    availableCharacterIds: context.characters.map(({ id }) => String(id)),
    toolPolicy: {
      required: ['read_profile_cache', 'query_stygian_phase:1-3', 'query_genshin_db'],
      unknownMeansUnknown: true
    }
  });
}

function publicRequest(context: Pick<StygianPlanAgentInput, 'input' | 'scenario'>) {
  return {
    uid: context.input.uid,
    scenarioId: context.scenario.id,
    dataVersion: context.scenario.meta.dataVersion,
    difficultyId: context.input.difficultyId,
    ...(context.input.phase === undefined ? {} : { phase: context.input.phase }),
    target: context.input.target,
    preferences: context.input.preferences,
    lockedCharacterIds: context.input.lockedCharacterIds,
    excludedCharacterIds: context.input.excludedCharacterIds,
    reuseRule: context.scenario.crossPartyReusePolicy
  };
}

function invalidOutput(message: string): { ok: false; issues: StygianPlanIssue[] } {
  return { ok: false, issues: [{ code: 'AGENT_OUTPUT_INVALID', path: [], message }] };
}

function parseJsonOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { invalidOutput: true };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
