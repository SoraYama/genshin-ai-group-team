import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';

export interface AuditedAgentRunner {
  run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown>;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ToolAudit {
  id: string;
  name: string;
  input: Record<string, unknown>;
  succeeded: boolean;
  correlationId: string;
  round: 'compose' | 'repair' | 'single';
}

export async function runAuditedAgentTurn(options: {
  runner: AuditedAgentRunner;
  prompt: string;
  sdkOptions: AgentSdkRunOptions;
  systemPrompt: string;
  auditContext?: {
    correlationId: string;
    round: ToolAudit['round'];
  };
  onUsageDelta?: (usage: AgentUsage) => void;
}): Promise<{ text: string; tools: ToolAudit[]; usage: AgentUsage }> {
  let resultText = '';
  let assistantText = '';
  const tools = new Map<string, ToolAudit>();
  let usage: AgentUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const maxTurns =
    (options.sdkOptions.allowedBusinessTools?.length ?? 0) > 0
      ? Math.min(Math.max(options.sdkOptions.maxTurns ?? 4, 3), 5)
      : 1;
  for await (const message of options.runner.run(options.prompt, {
    ...options.sdkOptions,
    systemPrompt: options.systemPrompt,
    maxTurns
  })) {
    if (options.sdkOptions.abortController.signal.aborted) throw new Error('cancelled');
    if (!isRecord(message)) continue;
    if (message['type'] === 'result' && typeof message['result'] === 'string') {
      resultText = message['result'];
      const sdkUsage = isRecord(message['usage']) ? message['usage'] : {};
      const delta = {
        inputTokens: numberValue(sdkUsage['input_tokens']),
        outputTokens: numberValue(sdkUsage['output_tokens']),
        estimatedCostUsd: numberValue(message['total_cost_usd'])
      };
      usage = addAgentUsage(usage, delta);
      if (
        typeof sdkUsage['input_tokens'] === 'number' ||
        typeof sdkUsage['output_tokens'] === 'number' ||
        typeof message['total_cost_usd'] === 'number'
      ) {
        options.onUsageDelta?.(delta);
      }
    }
    if (message['type'] === 'assistant' && isRecord(message['message'])) {
      const content = message['message']['content'];
      if (!Array.isArray(content)) continue;
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
            succeeded: false,
            correlationId: options.auditContext?.correlationId ?? 'unscoped',
            round: options.auditContext?.round ?? 'single'
          });
        }
      }
    }
    if (message['type'] === 'user' && isRecord(message['message'])) {
      const content = message['message']['content'];
      if (!Array.isArray(content)) continue;
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
  return { text: resultText || assistantText, tools: [...tools.values()], usage };
}

export function addAgentUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd
  };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
