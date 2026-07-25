import type { WebSearchOutput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { z } from 'zod';

import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import { privacySafeResearchText, privacySafeResearchUrl } from './research-privacy.js';

export const AGENT_TURN_RAW_SUMMARY_MAX_MESSAGES = 64;
export const AGENT_TURN_RAW_SUMMARY_PREVIEW_MAX_CHARS = 500;
export const AGENT_TURN_FINAL_TEXT_MAX_CHARS = 100_000;
export const AGENT_TURN_WEB_SEARCH_EVIDENCE_MAX_ATTEMPTS = 4;
export const AGENT_TURN_WEB_SEARCH_MAX_RESULTS = 32;
export const AGENT_TURN_WEB_SEARCH_MAX_URLS = 32;

const webSearchOutputSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    results: z
      .array(
        z.union([
          z.string().max(2_000),
          z
            .object({
              tool_use_id: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
              content: z
                .array(
                  z
                    .object({
                      title: z.string().max(500),
                      url: z.string().trim().min(1).max(2_048)
                    })
                    .strict()
                )
                .max(20)
            })
            .strict()
        ])
      )
      .max(AGENT_TURN_WEB_SEARCH_MAX_RESULTS),
    durationSeconds: z.number().finite().nonnegative().max(3_600),
    searchCount: z.number().int().min(1).max(3).optional()
  })
  .strict();

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

export type WebSearchEvidenceStatus = 'resolved' | 'error' | 'unresolved' | 'invalid' | 'duplicate';

export interface WebSearchEvidenceAttempt {
  toolUseId: string;
  query?: string;
  status: WebSearchEvidenceStatus;
  urls: string[];
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

export function safeAgentTurnFailureDetails(
  error: unknown
): { sdkCode?: AgentTurnErrorCode; httpStatus?: number } {
  const sdkCode = error instanceof AgentTurnError ? error.code : undefined;
  const httpStatus = safeHttpStatus(
    error instanceof AgentTurnError ? error.cause : error
  );
  return {
    ...(sdkCode === undefined ? {} : { sdkCode }),
    ...(httpStatus === undefined ? {} : { httpStatus })
  };
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
  normalizeResearchUrl?: (url: string) => string | undefined;
}): Promise<AuditedAgentTurn> {
  let resultText = '';
  let assistantText = '';
  let sawSuccessResult = false;
  const tools: ToolAudit[] = [];
  const toolsById = new Map<string, ToolAudit[]>();
  const webSearchById = new Map<string, WebSearchEvidenceAttempt>();
  const webSearchAttempts: WebSearchEvidenceAttempt[] = [];
  const toolResultIds = new Set<string>();
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
            const audit: ToolAudit = {
              id: block['id'],
              name: block['name'],
              input: isRecord(block['input']) ? { ...block['input'] } : {},
              succeeded: false,
              correlationId: options.auditContext?.correlationId ?? 'unscoped',
              round: options.auditContext?.round ?? 'single'
            };
            tools.push(audit);
            const matchingAudits = toolsById.get(block['id']) ?? [];
            matchingAudits.push(audit);
            toolsById.set(block['id'], matchingAudits);
            if (block['name'] === 'WebSearch') {
              const id = webSearchToolUseId(block['id']);
              const query =
                isRecord(block['input']) && typeof block['input']['query'] === 'string'
                  ? boundedResearchQuery(block['input']['query'])
                  : undefined;
              if (webSearchAttempts.length >= AGENT_TURN_WEB_SEARCH_EVIDENCE_MAX_ATTEMPTS) {
                webSearchEvidenceTruncated = true;
              } else if (
                id === undefined ||
                query === undefined ||
                webSearchById.has(id) ||
                toolResultIds.has(id)
              ) {
                const evidence: WebSearchEvidenceAttempt = {
                  toolUseId: id ?? 'invalid',
                  ...(query === undefined ? {} : { query }),
                  status: id !== undefined && toolResultIds.has(id) ? 'duplicate' : 'invalid',
                  urls: []
                };
                webSearchAttempts.push(evidence);
                if (id !== undefined && !webSearchById.has(id)) {
                  webSearchById.set(id, evidence);
                }
              } else {
                const evidence: WebSearchEvidenceAttempt = {
                  toolUseId: id,
                  query,
                  status: 'unresolved',
                  urls: []
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
            const toolUseId = block['tool_use_id'];
            const duplicate = toolResultIds.has(toolUseId);
            toolResultIds.add(toolUseId);
            toolsById
              .get(toolUseId)
              ?.forEach((use) => (use.succeeded = !duplicate && block['is_error'] !== true));
            const search = webSearchById.get(toolUseId);
            if (search) {
              if (duplicate) {
                search.status = 'duplicate';
                search.urls = [];
              } else if (block['is_error'] === true) {
                search.status = 'error';
                search.urls = [];
              } else {
                const urls = parseWebSearchUrls(
                  message['tool_use_result'],
                  search,
                  options.normalizeResearchUrl
                );
                search.status = urls === undefined ? 'invalid' : 'resolved';
                search.urls = urls ?? [];
              }
            }
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
    tools: tools.map((tool) => ({ ...tool, input: { ...tool.input } })),
    webSearchEvidence: {
      attempts: webSearchAttempts.map((attempt) => ({ ...attempt, urls: [...attempt.urls] })),
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

function safeHttpStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['httpStatus', 'statusCode', 'status']) {
    const candidate = record[key];
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  for (const key of ['cause', 'response', 'error']) {
    const nested = safeHttpStatus(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function webSearchToolUseId(value: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : undefined;
}

function boundedResearchQuery(value: string): string | undefined {
  if (value.length > 300) return undefined;
  const query = privacySafeResearchText(value);
  return query === undefined || query.length === 0 ? undefined : query;
}

function parseWebSearchUrls(
  value: unknown,
  expected: Pick<WebSearchEvidenceAttempt, 'toolUseId' | 'query'>,
  normalizeResearchUrl: ((url: string) => string | undefined) | undefined
): string[] | undefined {
  if (expected.query === undefined || normalizeResearchUrl === undefined) return undefined;
  const parsed = webSearchOutputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const output = parsed.data as WebSearchOutput;
  if (privacySafeResearchText(output.query) !== expected.query) return undefined;
  const urls: string[] = [];
  for (const result of output.results) {
    if (typeof result === 'string') continue;
    if (result.tool_use_id !== expected.toolUseId) return undefined;
    for (const content of result.content) {
      if (privacySafeResearchUrl(content.url) === undefined) return undefined;
      const normalizedUrl = normalizeResearchUrl(content.url);
      if (normalizedUrl === undefined) return undefined;
      urls.push(normalizedUrl);
      if (urls.length > AGENT_TURN_WEB_SEARCH_MAX_URLS) return undefined;
    }
  }
  return urls.length === 0 ? undefined : Array.from(new Set(urls));
}
