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
  | { ok: true; repaired: boolean; plan: AbyssPlanOutput }
  | { ok: false; issues: AbyssPlanIssue[] };

export class AbyssPlanAgent {
  constructor(private readonly runner: AbyssPlanAgentRunner) {}

  async compose(context: AbyssPlanAgentInput): Promise<AbyssPlanAgentResult> {
    const firstRaw = await this.runTurn(buildComposePayload(context), context.sdkOptions, false);
    const first = validateAgentOutput(firstRaw, context);
    if (first.ok) return { ok: true, repaired: false, plan: first.plan };

    const repairRaw = await this.runTurn(
      JSON.stringify({
        instruction: '只修复以下确定性校验问题，并返回完整方案。',
        issues: first.issues,
        previousOutput: parseJsonOrRaw(firstRaw),
        request: publicRequest(context)
      }),
      context.sdkOptions,
      true
    );
    const repaired = validateAgentOutput(repairRaw, context);
    if (!repaired.ok) return repaired;
    return { ok: true, repaired: true, plan: repaired.plan };
  }

  private async runTurn(
    prompt: string,
    options: AgentSdkRunOptions,
    repair: boolean
  ): Promise<string> {
    let resultText = '';
    let assistantText = '';
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
      }
      if (message['type'] === 'assistant' && isRecord(message['message'])) {
        const content = message['message']['content'];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
              assistantText += block['text'];
            }
          }
        }
      }
    }
    return resultText || assistantText;
  }
}

function validateAgentOutput(
  raw: string,
  context: Pick<AbyssPlanAgentInput, 'input' | 'scenario' | 'characters'>
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
  return validateAbyssPlan({ ...context, plan: parsed });
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
