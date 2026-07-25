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
import type {
  V2CritiqueOutput,
  V2ExplainOutput,
  V2PipelineContext,
  V2RotationOutput
} from '../agents/contracts.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import {
  AGENT_TURN_REDACTED_KEY,
  type AgentUsage,
  type AuditedAgentRunner,
  type ToolAudit
} from './agent-turn-audit.js';
import { validateStygianPlan } from './stygian-plan-validator.js';
import { runV2AgentPipeline, type V2AgentStage } from './v2-agent-pipeline.js';

export type StygianPlanAgentRunner = AuditedAgentRunner;

export interface StygianPlanAgentInput {
  input: StygianAdvisorPlanInput;
  scenario: StygianScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  pipelineContext: V2PipelineContext;
  sdkOptions: AgentSdkRunOptions;
  sdkOptionsForStage?: (stage: V2AgentStage) => AgentSdkRunOptions;
  onUsageDelta?: (usage: AgentUsage) => void;
}

export type StygianPlanAgentResult =
  | {
      ok: true;
      repaired: boolean;
      repairs: number;
      plan: StygianPlanOutput;
      critique: V2CritiqueOutput;
      rotation: V2RotationOutput;
      explanation: V2ExplainOutput;
      usage: AgentUsage;
    }
  | { ok: false; issues: StygianPlanIssue[]; usage: AgentUsage };

export class StygianPlanAgent {
  constructor(private readonly runner: StygianPlanAgentRunner) {}

  async compose(context: StygianPlanAgentInput): Promise<StygianPlanAgentResult> {
    const result = await runV2AgentPipeline<StygianPlanOutput, StygianPlanIssue>({
      runner: this.runner,
      context: context.pipelineContext,
      onUsageDelta: context.onUsageDelta,
      sdkOptionsForStage: context.sdkOptionsForStage ?? (() => context.sdkOptions),
      composer: {
        initialPrompt: buildComposePayload(context),
        systemPrompt: STYGIAN_COMPOSER_PROMPT_V1,
        repairPrompt: STYGIAN_REPAIR_PROMPT_V1,
        validate: (text, tools) => validateAgentOutput(text, context, tools)
      },
      invalidIssue: (stage, message) => ({
        code: 'AGENT_OUTPUT_INVALID' as const,
        path: [stage],
        message
      })
    });
    if (!result.ok) return { ok: false, issues: result.issues, usage: result.usage };
    return {
      ok: true,
      repaired: result.repairs > 0,
      repairs: result.repairs,
      plan: result.plan,
      critique: result.critique,
      rotation: result.rotation,
      explanation: result.explanation,
      usage: result.usage
    };
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
  context: Pick<StygianPlanAgentInput, 'input' | 'scenario' | 'characters'>,
  tools: ToolAudit[],
  plan: Record<string, unknown>
): StygianPlanIssue | undefined {
  const successful = tools.filter(({ succeeded }) => succeeded);
  const has = (name: string, predicate: (input: Record<string, unknown>) => boolean = () => true) =>
    successful.some((use) => use.name === name && predicate(use.input));
  const missing: string[] = [];
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
  const ownedIds = new Set(context.characters.map(({ id }) => String(id)));
  const plannedOwnedIds = plannedIds.filter((id) => ownedIds.has(id));
  const detailedProfileIds = new Set(
    successful
      .filter(
        ({ name, input }) =>
          name === 'mcp__genshin__read_profile_cache' &&
          auditedUidMatches(
            input['uid'] ?? input[AGENT_TURN_REDACTED_KEY],
            context.input.uid
          )
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

function auditedUidMatches(value: unknown, expected: string): boolean {
  return value === expected || value === '[REDACTED]';
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
    locale: context.input.locale,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
