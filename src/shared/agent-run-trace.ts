import { z } from 'zod';

import {
  MAX_TRACE_CUSTOM_HEADER_AGGREGATE_LENGTH,
  MAX_TRACE_CUSTOM_HEADER_VALUE_LENGTH,
  MAX_TRACE_CUSTOM_HEADER_VALUES,
  buildTraceSensitiveRegistry,
  redactTraceSecrets,
  type TraceSensitiveRegistry
} from './agent-run-trace-redactor.js';

export {
  MAX_TRACE_CUSTOM_HEADER_AGGREGATE_LENGTH,
  MAX_TRACE_CUSTOM_HEADER_VALUE_LENGTH,
  MAX_TRACE_CUSTOM_HEADER_VALUES
} from './agent-run-trace-redactor.js';

export const MAX_TRACE_TEXT_OUTPUT_CODE_UNITS = 32_768;
export const DEFAULT_TRACE_TEXT_MAX_BYTES = 16_384;
export const MAX_TRACE_TEXT_MAX_BYTES = 32_768;
export const MAX_TRACE_TEXT_INPUT_CHARS = 32_768;

const REDACTION_MARKER = '[REDACTED]';
const boundedTextSchema = z.string().max(MAX_TRACE_TEXT_OUTPUT_CODE_UNITS);
const boundedIdSchema = z.string().trim().min(1).max(128);
const nonnegativeIntSchema = z.number().int().nonnegative();
const traceTimestampSchema = z.iso.datetime({ offset: true }).max(40);
const agentFailureDetailsSchema = z
  .record(z.string().trim().min(1).max(80), boundedTextSchema)
  .superRefine((details, context) => {
    if (Object.keys(details).length > 32) {
      context.addIssue({
        code: 'custom',
        message: 'Failure details may contain at most 32 keys'
      });
    }
  });

export const agentFailureCodeSchema = z.enum([
  'AGENT_ABORTED',
  'AGENT_TIMEOUT',
  'SDK_START_FAILED',
  'PROVIDER_ERROR',
  'SEARCH_UNAVAILABLE',
  'SEARCH_BUDGET_EXCEEDED',
  'SEARCH_OUTPUT_INVALID',
  'TOOL_REQUIREMENT_FAILED',
  'AGENT_OUTPUT_INVALID',
  'VALIDATION_FAILED'
]);

export const agentStageSchema = z.enum([
  'knowledge',
  'research',
  'compose',
  'repair-1',
  'repair-2',
  'critique',
  'rotation',
  'explain'
]);

export const agentFailureSchema = z
  .object({
    code: agentFailureCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
    details: agentFailureDetailsSchema.optional()
  })
  .strict();

export const agentUsageSchema = z
  .object({
    inputTokens: nonnegativeIntSchema,
    outputTokens: nonnegativeIntSchema,
    cacheReadTokens: nonnegativeIntSchema.optional(),
    cacheCreationTokens: nonnegativeIntSchema.optional()
  })
  .strict();

export const agentToolTraceSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    status: z.enum(['started', 'completed', 'failed']),
    inputSummary: boundedTextSchema.optional(),
    outputSummary: boundedTextSchema.optional(),
    durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
    failure: agentFailureSchema.optional(),
    truncated: z.boolean().optional()
  })
  .strict()
  .superRefine(({ status, failure }, context) => {
    if ((status === 'failed') !== (failure !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Only failed tool traces must include failure details'
      });
    }
  });

export const agentRawMessagesSummarySchema = z
  .object({
    totalMessages: nonnegativeIntSchema,
    messages: z
      .array(
        z
          .object({
            type: z.string().trim().min(1).max(80),
            subtype: z.string().trim().min(1).max(80).optional(),
            textPreview: boundedTextSchema.optional(),
            textTruncated: z.boolean()
          })
          .strict()
      )
      .max(64),
    truncated: z.boolean()
  })
  .strict();

export const agentWebSearchEvidenceSchema = z
  .object({
    attempts: z
      .array(
        z
          .object({
            toolUseId: boundedIdSchema,
            query: z.string().trim().min(1).max(300).optional(),
            status: z.enum(['resolved', 'error', 'unresolved', 'invalid', 'duplicate']),
            urls: z.array(z.string().trim().min(1).max(2_048)).max(32)
          })
          .strict()
      )
      .max(4),
    truncated: z.boolean()
  })
  .strict();

export const agentStageTraceSchema = z
  .object({
    stage: agentStageSchema,
    status: z.enum(['started', 'completed', 'failed', 'skipped']),
    inputSummary: boundedTextSchema.optional(),
    rawOutput: boundedTextSchema.optional(),
    rawMessagesSummary: agentRawMessagesSummarySchema.optional(),
    webSearchEvidence: agentWebSearchEvidenceSchema.optional(),
    tools: z.array(agentToolTraceSchema).max(64),
    citationIds: z
      .array(boundedIdSchema)
      .max(256)
      .refine((ids) => new Set(ids).size === ids.length, 'Citation IDs must be unique'),
    usage: agentUsageSchema,
    durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
    failure: agentFailureSchema.optional(),
    truncated: z.boolean().optional()
  })
  .strict()
  .superRefine(({ status, failure }, context) => {
    if ((status === 'failed') !== (failure !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Only failed stage traces must include failure details'
      });
    }
  });

export const agentTraceKnowledgeSummarySchema = z
  .object({
    trusted: nonnegativeIntSchema,
    ephemeral: nonnegativeIntSchema,
    unknown: nonnegativeIntSchema,
    searched: z.boolean()
  })
  .strict();

export const agentFinalSourceSchema = z.enum(['smart-service', 'local-rules', 'blocked']);

const agentRunTraceCommonShape = {
  correlationId: boundedIdSchema,
  startedAt: traceTimestampSchema,
  model: z.string().trim().min(1).max(256),
  stages: z.array(agentStageTraceSchema).max(16),
  knowledge: agentTraceKnowledgeSummarySchema,
  usage: agentUsageSchema
};

const runningAgentRunTraceSchema = z
  .object({
    status: z.literal('running'),
    ...agentRunTraceCommonShape,
    finishedAt: z.never().optional(),
    finalSource: agentFinalSourceSchema.optional(),
    failure: z.never().optional()
  })
  .strict();

const completedAgentRunTraceSchema = z
  .object({
    status: z.literal('completed'),
    ...agentRunTraceCommonShape,
    finishedAt: traceTimestampSchema,
    finalSource: agentFinalSourceSchema,
    failure: z.never().optional()
  })
  .strict();

const failedAgentRunTraceSchema = z
  .object({
    status: z.literal('failed'),
    ...agentRunTraceCommonShape,
    finishedAt: traceTimestampSchema,
    finalSource: agentFinalSourceSchema,
    failure: agentFailureSchema
  })
  .strict();

export const agentRunTraceSchema = z.discriminatedUnion('status', [
  runningAgentRunTraceSchema,
  completedAgentRunTraceSchema,
  failedAgentRunTraceSchema
]);

export interface SanitizeTraceTextOptions {
  maxBytes?: number;
  customHeaderValues?: readonly string[];
}

export interface SanitizedTraceText {
  text: string;
  truncated: boolean;
}

export function sanitizeTraceText(
  value: string,
  options: SanitizeTraceTextOptions = {}
): SanitizedTraceText {
  const maxBytes = normalizeByteBudget(options.maxBytes);
  const registry = normalizeCustomHeaderValues(options.customHeaderValues);
  const maximumCustomValueLength = registry.values.reduce(
    (maximum, customValue) => Math.max(maximum, customValue.length),
    0
  );
  // The overlap exposes any custom secret that starts before the output boundary.
  const scanLimit = MAX_TRACE_TEXT_INPUT_CHARS + Math.max(0, maximumCustomValueLength - 1);
  const sourceWasCapped = value.length > MAX_TRACE_TEXT_INPUT_CHARS;
  const scanPrefix = takeCodePointSafePrefix(value, scanLimit);
  if (
    scanPrefix.truncated &&
    maximumCustomValueLength > 0 &&
    hasEncodedBoundaryRisk(scanPrefix.text, maximumCustomValueLength)
  ) {
    return { text: REDACTION_MARKER, truncated: true };
  }
  const trailingCustomSpanLength = scanPrefix.truncated
    ? findTrailingCustomSpanLength(scanPrefix.text, registry.values)
    : 0;
  const completeScanText =
    trailingCustomSpanLength === 0
      ? scanPrefix.text
      : scanPrefix.text.slice(0, -trailingCustomSpanLength);

  let redacted = redactTraceSecrets(completeScanText, registry).text;
  if (trailingCustomSpanLength > 0) redacted += REDACTION_MARKER;

  const output = truncateSanitizedText(redacted, maxBytes);
  return {
    text: output.text,
    truncated: sourceWasCapped || trailingCustomSpanLength > 0 || output.truncated
  };
}

function hasEncodedBoundaryRisk(value: string, maximumSecretLength: number): boolean {
  // Eight canonicalization rounds can grow one original character to at most
  // 17 code units (`%` -> `%25` adds two per round).
  const boundaryWindow = Math.max(64, maximumSecretLength * 17);
  return /%[0-9a-f]{2}/iu.test(value.slice(-boundaryWindow));
}

function normalizeByteBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRACE_TEXT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TRACE_TEXT_MAX_BYTES) {
    throw new RangeError(
      `maxBytes must be a nonnegative safe integer no greater than ${MAX_TRACE_TEXT_MAX_BYTES}`
    );
  }
  return value;
}

function normalizeCustomHeaderValues(
  values: readonly string[] | undefined
): TraceSensitiveRegistry {
  const registry = buildTraceSensitiveRegistry(
    [],
    values?.map((value) => makeWellFormed(value))
  );
  if (registry.failClosed) {
    throw new RangeError(
      `customHeaderValues exceed count ${MAX_TRACE_CUSTOM_HEADER_VALUES}, value length ${MAX_TRACE_CUSTOM_HEADER_VALUE_LENGTH}, or aggregate ${MAX_TRACE_CUSTOM_HEADER_AGGREGATE_LENGTH}`
    );
  }
  return registry;
}

function findTrailingCustomSpanLength(value: string, customValues: readonly string[]): number {
  if (customValues.length === 0) return 0;
  const maximumValueLength = customValues.reduce(
    (maximum, customValue) => Math.max(maximum, customValue.length),
    0
  );
  const tail = value.slice(-maximumValueLength).toLowerCase();
  let longestMatch = 0;

  for (const customValue of customValues) {
    longestMatch = Math.max(
      longestMatch,
      longestPrefixMatchingSuffix(tail, customValue.toLowerCase())
    );
  }
  return longestMatch;
}

function longestPrefixMatchingSuffix(value: string, pattern: string): number {
  if (pattern.length === 0) return 0;
  const prefixLengths = new Uint32Array(pattern.length);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) {
      matched = prefixLengths[matched - 1]!;
    }
    if (pattern[index] === pattern[matched]) matched += 1;
    prefixLengths[index] = matched;
  }

  let matched = 0;
  for (let index = 0; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== pattern[matched]) {
      matched = prefixLengths[matched - 1]!;
    }
    if (value[index] === pattern[matched]) matched += 1;
    if (matched === pattern.length && index < value.length - 1) {
      matched = prefixLengths[matched - 1]!;
    }
  }
  return matched;
}

function takeCodePointSafePrefix(
  value: string,
  maximumCodeUnits: number
): { text: string; truncated: boolean } {
  let end = Math.min(value.length, maximumCodeUnits);
  if (
    end < value.length &&
    end > 0 &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1;
  }
  return {
    text: makeWellFormed(value.slice(0, end)),
    truncated: end < value.length
  };
}

function truncateSanitizedText(
  value: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const characters: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  let codeUnits = 0;

  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (
      bytes + characterBytes > maxBytes ||
      codeUnits + character.length > MAX_TRACE_TEXT_OUTPUT_CODE_UNITS
    ) {
      return { text: characters.join(''), truncated: true };
    }
    characters.push(character);
    bytes += characterBytes;
    codeUnits += character.length;
  }
  return { text: characters.join(''), truncated: false };
}

function makeWellFormed(value: string): string {
  const characters: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      const next = value.charCodeAt(index + 1);
      if (isLowSurrogate(next)) {
        characters.push(value[index]!, value[index + 1]!);
        index += 1;
      } else {
        characters.push('\uFFFD');
      }
    } else if (isLowSurrogate(codeUnit)) {
      characters.push('\uFFFD');
    } else {
      characters.push(value[index]!);
    }
  }
  return characters.join('');
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export type AgentFailureCode = z.infer<typeof agentFailureCodeSchema>;
export type AgentStage = z.infer<typeof agentStageSchema>;
export type AgentFailure = z.infer<typeof agentFailureSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type AgentToolTrace = z.infer<typeof agentToolTraceSchema>;
export type AgentRawMessagesSummary = z.infer<typeof agentRawMessagesSummarySchema>;
export type AgentWebSearchEvidence = z.infer<typeof agentWebSearchEvidenceSchema>;
export type AgentStageTrace = z.infer<typeof agentStageTraceSchema>;
export type AgentTraceKnowledgeSummary = z.infer<typeof agentTraceKnowledgeSummarySchema>;
export type AgentFinalSource = z.infer<typeof agentFinalSourceSchema>;
export type AgentRunTrace = z.infer<typeof agentRunTraceSchema>;
