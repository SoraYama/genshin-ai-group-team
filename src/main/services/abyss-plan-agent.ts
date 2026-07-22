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
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import { validateAbyssPlan } from './abyss-plan-validator.js';

export interface AbyssPlanAgentRunner {
  run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown>;
}

export interface AbyssPlanAgentInput {
  input: AbyssAdvisorPlanInput;
  scenario: AbyssScenario;
  characters: CharacterProfile[];
  sdkOptions: AgentSdkRunOptions;
}

export type AbyssPlanAgentResult =
  | { ok: true; repaired: boolean; plan: AbyssPlanOutput; usage: AgentUsage }
  | { ok: false; issues: AbyssPlanIssue[]; usage: AgentUsage };

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export class AbyssPlanAgent {
  constructor(private readonly runner: AbyssPlanAgentRunner) {}

  async compose(context: AbyssPlanAgentInput): Promise<AbyssPlanAgentResult> {
    const firstTurn = await this.runTurn(buildComposePayload(context), context.sdkOptions, false);
    const first = validateAgentOutput(firstTurn.text, context, firstTurn.tools);
    if (first.ok) return { ok: true, repaired: false, plan: first.plan, usage: firstTurn.usage };

    const repairRaw = await this.runTurn(
      JSON.stringify({
        instruction: '只修复以下确定性校验问题，并返回完整方案。',
        issues: first.issues,
        previousOutput: parseJsonOrRaw(firstTurn.text),
        request: publicRequest(context)
      }),
      context.sdkOptions,
      true
    );
    const repaired = validateAgentOutput(repairRaw.text, context, [
      ...firstTurn.tools,
      ...repairRaw.tools
    ]);
    const usage = addUsage(firstTurn.usage, repairRaw.usage);
    if (!repaired.ok) return { ...repaired, usage };
    return { ok: true, repaired: true, plan: repaired.plan, usage };
  }

  private async runTurn(
    prompt: string,
    options: AgentSdkRunOptions,
    repair: boolean
  ): Promise<{ text: string; tools: ToolAudit[]; usage: AgentUsage }> {
    let resultText = '';
    let assistantText = '';
    const tools = new Map<string, ToolAudit>();
    let usage: AgentUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    const maxTurns = Math.min(Math.max(options.maxTurns ?? 4, 3), 5);
    for await (const message of this.runner.run(prompt, {
      ...options,
      systemPrompt: repair
        ? `${ABYSS_COMPOSER_PROMPT_V1}\n\n${ABYSS_REPAIR_PROMPT_V1}`
        : ABYSS_COMPOSER_PROMPT_V1,
      maxTurns
    })) {
      if (options.abortController.signal.aborted) throw new Error('cancelled');
      if (!isRecord(message)) continue;
      if (message['type'] === 'result' && typeof message['result'] === 'string') {
        resultText = message['result'];
        const sdkUsage = isRecord(message['usage']) ? message['usage'] : {};
        usage = addUsage(usage, {
          inputTokens: numberValue(sdkUsage['input_tokens']),
          outputTokens: numberValue(sdkUsage['output_tokens']),
          estimatedCostUsd: numberValue(message['total_cost_usd'])
        });
      }
      if (message['type'] === 'assistant' && isRecord(message['message'])) {
        const content = message['message']['content'];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
              assistantText += block['text'];
            }
            if (
              isRecord(block) &&
              block['type'] === 'tool_use' &&
              typeof block['id'] === 'string' &&
              typeof block['name'] === 'string'
            ) {
              tools.set(block['id'], {
                id: block['id'],
                name: block['name'],
                input: isRecord(block['input']) ? block['input'] : {},
                succeeded: false
              });
            }
          }
        }
      }
      if (message['type'] === 'user' && isRecord(message['message'])) {
        const content = message['message']['content'];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              isRecord(block) &&
              block['type'] === 'tool_result' &&
              typeof block['tool_use_id'] === 'string'
            ) {
              const use = tools.get(block['tool_use_id']);
              if (use) use.succeeded = block['is_error'] !== true;
            }
          }
        }
      }
    }
    return { text: resultText || assistantText, tools: [...tools.values()], usage };
  }
}

interface ToolAudit {
  id: string;
  name: string;
  input: Record<string, unknown>;
  succeeded: boolean;
}

function validateAgentOutput(
  raw: string,
  context: Pick<AbyssPlanAgentInput, 'input' | 'scenario' | 'characters'>,
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
  context: Pick<AbyssPlanAgentInput, 'input' | 'scenario'>,
  tools: ToolAudit[],
  plan: Record<string, unknown>
): AbyssPlanIssue | undefined {
  const successful = tools.filter(({ succeeded }) => succeeded);
  const has = (name: string, predicate: (input: Record<string, unknown>) => boolean = () => true) =>
    successful.some((use) => use.name === name && predicate(use.input));
  const missing: string[] = [];
  if (!has('mcp__genshin__read_profile_cache', (input) => input['uid'] === context.input.uid)) {
    missing.push('read_profile_cache');
  }
  const plannedIds = ['firstHalfTeam', 'secondHalfTeam'].flatMap((key) => {
    const team = isRecord(plan[key]) ? plan[key] : {};
    return Array.isArray(team['characterIds'])
      ? team['characterIds'].filter((id): id is string => typeof id === 'string')
      : [];
  });
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
    floor: context.input.floor,
    chamber: context.input.chamber,
    preferences: context.input.preferences,
    lockedCharacterIds: context.input.lockedCharacterIds,
    excludedCharacterIds: context.input.excludedCharacterIds
  };
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

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd
  };
}
