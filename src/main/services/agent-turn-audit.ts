import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import { privacySafeResearchText } from './research-privacy.js';

export const AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES = 64;
export const AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS = 500;
export const AGENT_TURN_FINAL_TEXT_MAX_CHARS = 100_000;
export const AGENT_TURN_WEB_SEARCH_EVIDENCE_MAX_ATTEMPTS = 4;

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

export type WebSearchEvidenceStatus = 'resolved' | 'error' | 'unresolved' | 'invalid';

export interface WebSearchEvidenceAttempt {
  toolUseId: string;
  query?: string;
  status: WebSearchEvidenceStatus;
}

export interface WebSearchEvidence {
  attempts: WebSearchEvidenceAttempt[];
  truncated: boolean;
}

export type AgentTurnErrorCode =
  | 'AGENT_TURN_CANCELLED'
  | 'AGENT_TURN_INCOMPLETE'
  | 'AGENT_TURN_STREAM_FAILED'
  | 'AGENT_TURN_RESULT_ERROR'
  | 'AGENT_TURN_OUTPUT_TOO_LARGE';

export class AgentTurnError extends Error {
  override readonly name = 'AgentTurnError';
  readonly usage: AgentUsage | undefined;

  constructor(
    readonly code: AgentTurnErrorCode,
    message: string,
    options?: { cause?: unknown; usage?: AgentUsage }
  ) {
    super(message, options);
    this.usage = options?.usage;
  }
}

export interface RawAgentMessageSummary {
  type: string;
  subtype?: string;
  textPreview?: string;
  textTruncated: boolean;
}

export interface RawAgentMessagesSummary {
  totalMessages: number;
  messages: RawAgentMessageSummary[];
  truncated: boolean;
}

export interface AuditedAgentTurn {
  text: string;
  finalRawText: string;
  rawMessagesSummary: RawAgentMessagesSummary;
  tools: ToolAudit[];
  webSearchEvidence: WebSearchEvidence;
  usage: AgentUsage;
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
}): Promise<AuditedAgentTurn> {
  let resultText = '';
  let assistantText = '';
  let sawSuccessResult = false;
  const tools = new Map<string, ToolAudit>();
  const webSearchById = new Map<string, WebSearchEvidenceAttempt>();
  const webSearchAttempts: WebSearchEvidenceAttempt[] = [];
  let webSearchEvidenceTruncated = false;
  let usage: AgentUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const rawMessagesSummary: RawAgentMessagesSummary = {
    totalMessages: 0,
    messages: [],
    truncated: false
  };
  const maxTurns =
    options.sdkOptions.nativeToolPolicy?.purpose === 'research'
      ? 4
      : (options.sdkOptions.allowedBusinessTools?.length ?? 0) > 0
        ? Math.min(Math.max(options.sdkOptions.maxTurns ?? 4, 3), 5)
        : 1;
  if (options.sdkOptions.abortController.signal.aborted) {
    throw new AgentTurnError('AGENT_TURN_CANCELLED', 'Agent turn was cancelled');
  }
  try {
    for await (const message of options.runner.run(options.prompt, {
      ...options.sdkOptions,
      systemPrompt: options.systemPrompt,
      maxTurns
    })) {
      if (options.sdkOptions.abortController.signal.aborted) {
        throw new AgentTurnError('AGENT_TURN_CANCELLED', 'Agent turn was cancelled');
      }
      addRawMessageSummary(rawMessagesSummary, message);
      if (!isRecord(message)) continue;
      if (message['type'] === 'result') {
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
        if (message['subtype'] !== 'success' || typeof message['result'] !== 'string') {
          throw new AgentTurnError(
            'AGENT_TURN_RESULT_ERROR',
            'Agent turn returned an error result',
            { cause: message, usage }
          );
        }
        assertBoundedFinalText(message['result']);
        resultText = message['result'];
        sawSuccessResult = true;
      }
      if (message['type'] === 'assistant' && isRecord(message['message'])) {
        const content = message['message']['content'];
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
            assistantText += block['text'];
            assertBoundedFinalText(assistantText);
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
            if (block['name'] === 'WebSearch') {
              const id = webSearchToolUseId(block['id']);
              const query =
                isRecord(block['input']) && typeof block['input']['query'] === 'string'
                  ? boundedResearchQuery(block['input']['query'])
                  : undefined;
              if (webSearchAttempts.length >= AGENT_TURN_WEB_SEARCH_EVIDENCE_MAX_ATTEMPTS) {
                webSearchEvidenceTruncated = true;
              } else if (id === undefined || query === undefined || webSearchById.has(id)) {
                webSearchAttempts.push({
                  toolUseId: id ?? 'invalid',
                  status: 'invalid'
                });
              } else {
                const evidence: WebSearchEvidenceAttempt = {
                  toolUseId: id,
                  query,
                  status: 'unresolved'
                };
                webSearchById.set(id, evidence);
                webSearchAttempts.push(evidence);
              }
            }
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
            const search = webSearchById.get(block['tool_use_id']);
            if (search) search.status = block['is_error'] === true ? 'error' : 'resolved';
          }
        }
      }
    }
  } catch (error) {
    if (options.sdkOptions.abortController.signal.aborted) {
      if (error instanceof AgentTurnError && error.code === 'AGENT_TURN_CANCELLED') throw error;
      throw new AgentTurnError('AGENT_TURN_CANCELLED', 'Agent turn was cancelled', {
        cause: error,
        usage
      });
    }
    if (error instanceof AgentTurnError) throw error;
    throw new AgentTurnError('AGENT_TURN_STREAM_FAILED', 'Agent turn stream failed', {
      cause: error,
      usage
    });
  }
  if (options.sdkOptions.abortController.signal.aborted) {
    throw new AgentTurnError('AGENT_TURN_CANCELLED', 'Agent turn was cancelled', { usage });
  }
  if (!sawSuccessResult && assistantText.length === 0) {
    throw new AgentTurnError('AGENT_TURN_INCOMPLETE', 'Agent turn ended without a result', {
      usage
    });
  }
  const finalRawText = resultText || assistantText;
  return {
    text: finalRawText,
    finalRawText,
    rawMessagesSummary,
    tools: [...tools.values()],
    webSearchEvidence: {
      attempts: webSearchAttempts.map((attempt) => ({ ...attempt })),
      truncated: webSearchEvidenceTruncated
    },
    usage
  };
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

function addRawMessageSummary(summary: RawAgentMessagesSummary, message: unknown): void {
  summary.totalMessages += 1;
  if (summary.messages.length >= AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES) {
    summary.truncated = true;
    return;
  }
  const type =
    isRecord(message) && typeof message['type'] === 'string' ? message['type'] : 'unknown';
  const subtype =
    isRecord(message) && typeof message['subtype'] === 'string' ? message['subtype'] : undefined;
  const text = rawSummaryText(message);
  summary.messages.push({
    type: boundedLabel(type),
    ...(subtype === undefined ? {} : { subtype: boundedLabel(subtype) }),
    ...(text === undefined
      ? {}
      : { textPreview: text.slice(0, AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS) }),
    textTruncated: text !== undefined && text.length > AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS
  });
}

function rawSummaryText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (message['type'] === 'result' && typeof message['result'] === 'string') {
    return message['result'];
  }
  if (message['type'] !== 'assistant' || !isRecord(message['message'])) return undefined;
  const content = message['message']['content'];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
    )
    .map((block) => block['text'] as string)
    .join('');
  return text.length === 0 ? undefined : text;
}

function boundedLabel(value: string): string {
  return value.slice(0, 80);
}

function assertBoundedFinalText(value: string): void {
  if (value.length > AGENT_TURN_FINAL_TEXT_MAX_CHARS) {
    throw new AgentTurnError(
      'AGENT_TURN_OUTPUT_TOO_LARGE',
      'Agent turn final output exceeded the allowed size'
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function webSearchToolUseId(value: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : undefined;
}

function boundedResearchQuery(value: string): string | undefined {
  if (value.length > 300) return undefined;
  const query = privacySafeResearchText(value);
  return query === undefined || query.length === 0 ? undefined : query;
}
