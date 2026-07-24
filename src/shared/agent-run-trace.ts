import { z } from 'zod';

const boundedTextSchema = z.string().max(32_768);
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

export const agentStageTraceSchema = z
  .object({
    stage: agentStageSchema,
    status: z.enum(['started', 'completed', 'failed', 'skipped']),
    inputSummary: boundedTextSchema.optional(),
    rawOutput: boundedTextSchema.optional(),
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

export const DEFAULT_TRACE_TEXT_MAX_BYTES = 16_384;

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
  let redacted = value;

  for (const customValue of options.customHeaderValues ?? []) {
    if (customValue.length > 0) {
      redacted = redacted.replace(new RegExp(escapeRegExp(customValue), 'gi'), '[REDACTED]');
    }
  }

  redacted = redacted
    .replace(/("(?:apiKey|ANTHROPIC_AUTH_TOKEN)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/("(?:Authorization|Cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/((?<!")\b(?:Authorization|Cookie)\b\s*[:=]\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(
      /((?<!")\b(?:apiKey|ANTHROPIC_AUTH_TOKEN)\b\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');

  const encoded = new TextEncoder().encode(redacted);
  if (encoded.byteLength <= maxBytes) {
    return { text: redacted, truncated: false };
  }

  let bytes = 0;
  let text = '';
  for (const character of redacted) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    text += character;
    bytes += characterBytes;
  }
  return { text, truncated: true };
}

function normalizeByteBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRACE_TEXT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('maxBytes must be a nonnegative safe integer');
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type AgentFailureCode = z.infer<typeof agentFailureCodeSchema>;
export type AgentStage = z.infer<typeof agentStageSchema>;
export type AgentFailure = z.infer<typeof agentFailureSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type AgentToolTrace = z.infer<typeof agentToolTraceSchema>;
export type AgentStageTrace = z.infer<typeof agentStageTraceSchema>;
export type AgentTraceKnowledgeSummary = z.infer<typeof agentTraceKnowledgeSummarySchema>;
export type AgentFinalSource = z.infer<typeof agentFinalSourceSchema>;
export type AgentRunTrace = z.infer<typeof agentRunTraceSchema>;
