import {
  MAX_TRACE_CUSTOM_HEADER_AGGREGATE_LENGTH,
  MAX_TRACE_CUSTOM_HEADER_VALUE_LENGTH,
  MAX_TRACE_CUSTOM_HEADER_VALUES,
  MAX_TRACE_TEXT_MAX_BYTES,
  agentFinalSourceSchema,
  agentRunTraceSchema,
  agentStageSchema,
  sanitizeTraceText,
  type AgentFailure,
  type AgentRunTrace,
  type AgentStage,
  type AgentToolTrace,
  type AgentTraceKnowledgeSummary,
  type AgentUsage
} from '../../shared/agent-run-trace.js';
import { compactTraceToBudget, headTailUtf8, jsonBytes } from './agent-run-trace-compactor.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const MIN_MAX_BYTES = 4 * 1024;
const REDACTION_MARKER = '[REDACTED]';
const EMPTY_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0 };
const TRACE_LEASE_GENERATION = Symbol('agent-run-trace-generation');

export interface AgentRunTraceStoreOptions {
  maxBytes?: number;
  now?: () => number;
}

export interface StartTraceInput {
  correlationId: string;
  model: string;
  knowledge: AgentTraceKnowledgeSummary;
  startedAt?: string;
  sensitiveValues?: readonly string[];
}

export interface StartStageInput {
  stage: AgentStage;
  inputSummary?: string;
  citationIds?: readonly string[];
  sensitiveValues?: readonly string[];
}

export interface CompleteStageInput {
  stage: AgentStage;
  rawOutput?: string;
  tools?: readonly AgentToolTrace[];
  citationIds?: readonly string[];
  usage?: AgentUsage;
  durationMs?: number;
}

export interface FailStageInput extends CompleteStageInput {
  failure: AgentFailure;
}

export interface SkipStageInput {
  stage: AgentStage;
  inputSummary?: string;
  citationIds?: readonly string[];
}

export interface FinishTraceInput {
  finalSource: 'smart-service' | 'local-rules' | 'blocked';
  failure?: AgentFailure;
  finishedAt?: string;
}

export interface AgentRunTraceLease {
  readonly correlationId: string;
  readonly [TRACE_LEASE_GENERATION]: symbol;
}

export interface AgentRunTraceWriter {
  start(input: StartTraceInput): AgentRunTraceLease;
  startStage(lease: AgentRunTraceLease, input: StartStageInput): void;
  completeStage(lease: AgentRunTraceLease, input: CompleteStageInput): void;
  failStage(lease: AgentRunTraceLease, input: FailStageInput): void;
  skipStage(lease: AgentRunTraceLease, input: SkipStageInput): void;
  finish(lease: AgentRunTraceLease, input: FinishTraceInput): void;
  latest(): AgentRunTrace | null;
}

interface SanitizedText {
  text: string;
  changed: boolean;
}

export class AgentRunTraceStore implements AgentRunTraceWriter {
  private readonly maxBytes: number;
  private readonly now: () => number;
  private trace: AgentRunTrace | null = null;
  private activeLease: AgentRunTraceLease | null = null;
  private sensitiveValues: readonly string[] = [];
  private failClosedRedaction = false;
  private readonly stageStartedAt = new Map<number, number>();

  constructor(options: AgentRunTraceStoreOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_MAX_BYTES) {
      throw new RangeError(`maxBytes must be a safe integer of at least ${MIN_MAX_BYTES}`);
    }
    this.maxBytes = maxBytes;
    this.now = options.now ?? Date.now;
  }

  start(input: StartTraceInput): AgentRunTraceLease {
    const registry = buildSensitiveRegistry([], input.sensitiveValues);
    this.sensitiveValues = registry.values;
    this.failClosedRedaction = registry.failClosed;
    const correlationId = this.sanitize(input.correlationId, 128).text || REDACTION_MARKER;
    const model = this.sanitize(input.model, 256).text || REDACTION_MARKER;
    const candidate = {
      correlationId,
      startedAt: input.startedAt ?? new Date(this.now()).toISOString(),
      status: 'running' as const,
      model,
      stages: [],
      knowledge: structuredClone(input.knowledge),
      usage: { ...EMPTY_USAGE }
    };
    const committed = this.prepare(candidate);
    if (committed === null) {
      this.trace = null;
      this.activeLease = null;
      this.sensitiveValues = [];
      this.failClosedRedaction = false;
      this.stageStartedAt.clear();
      throw new TypeError('Trace start input is invalid');
    }
    const lease = Object.freeze({
      correlationId: input.correlationId,
      [TRACE_LEASE_GENERATION]: Symbol('agent-run')
    });
    this.trace = committed;
    this.activeLease = lease;
    this.stageStartedAt.clear();
    return lease;
  }

  startStage(lease: AgentRunTraceLease, input: StartStageInput): void {
    this.updateRunning(lease, (candidate) => {
      if (
        !agentStageSchema.safeParse(input.stage).success ||
        candidate.stages.some(({ status }) => status === 'started')
      ) {
        return false;
      }
      const registry = buildSensitiveRegistry(this.sensitiveValues, input.sensitiveValues);
      const registryChanged =
        registry.failClosed !== this.failClosedRedaction ||
        registry.values.some((value, index) => value !== this.sensitiveValues[index]);
      this.sensitiveValues = registry.values;
      this.failClosedRedaction ||= registry.failClosed;
      if (registryChanged) this.resanitizeTrace(candidate);
      const summary =
        input.inputSummary === undefined ? undefined : this.sanitize(input.inputSummary).text;
      candidate.stages.push({
        stage: input.stage,
        status: 'started',
        ...(summary === undefined ? {} : { inputSummary: summary }),
        tools: [],
        citationIds: this.sanitizeIds(input.citationIds),
        usage: { ...EMPTY_USAGE }
      });
      this.stageStartedAt.set(candidate.stages.length - 1, this.now());
      return true;
    });
  }

  completeStage(lease: AgentRunTraceLease, input: CompleteStageInput): void {
    this.terminalStage(lease, input, undefined);
  }

  failStage(lease: AgentRunTraceLease, input: FailStageInput): void {
    this.terminalStage(lease, input, input.failure);
  }

  skipStage(lease: AgentRunTraceLease, input: SkipStageInput): void {
    this.updateRunning(lease, (candidate) => {
      if (
        !agentStageSchema.safeParse(input.stage).success ||
        candidate.stages.some(({ status }) => status === 'started')
      ) {
        return false;
      }
      const summary =
        input.inputSummary === undefined ? undefined : this.sanitize(input.inputSummary).text;
      candidate.stages.push({
        stage: input.stage,
        status: 'skipped',
        ...(summary === undefined ? {} : { inputSummary: summary }),
        tools: [],
        citationIds: this.sanitizeIds(input.citationIds),
        usage: { ...EMPTY_USAGE }
      });
      return true;
    });
  }

  finish(lease: AgentRunTraceLease, input: FinishTraceInput): void {
    if (
      this.trace?.status !== 'running' ||
      this.activeLease !== lease ||
      this.trace.stages.some(({ status }) => status === 'started') ||
      !agentFinalSourceSchema.safeParse(input.finalSource).success
    ) {
      return;
    }
    const candidate = structuredClone(this.trace);
    const finishedAt = input.finishedAt ?? new Date(this.now()).toISOString();
    const terminal =
      input.failure === undefined
        ? {
            ...candidate,
            status: 'completed' as const,
            finishedAt,
            finalSource: input.finalSource
          }
        : {
            ...candidate,
            status: 'failed' as const,
            finishedAt,
            finalSource: input.finalSource,
            failure: this.sanitizeFailure(input.failure)
          };
    const committed = this.prepare(terminal);
    if (committed === null) return;
    this.trace = committed;
    this.stageStartedAt.clear();
    this.sensitiveValues = [];
    this.failClosedRedaction = false;
  }

  latest(): AgentRunTrace | null {
    return this.trace === null ? null : structuredClone(this.trace);
  }

  private terminalStage(
    lease: AgentRunTraceLease,
    input: CompleteStageInput,
    failure: AgentFailure | undefined
  ): void {
    this.updateRunning(lease, (candidate) => {
      if (!agentStageSchema.safeParse(input.stage).success) return false;
      const index = findStartedStage(candidate, input.stage);
      if (index < 0) return false;
      const stage = candidate.stages[index]!;
      const raw = input.rawOutput === undefined ? undefined : this.sanitize(input.rawOutput);
      const tools = (input.tools ?? []).slice(0, 64).map((tool) => this.sanitizeTool(tool));
      const sanitizedFailure = failure === undefined ? undefined : this.sanitizeFailure(failure);
      const durationMs =
        input.durationMs === undefined
          ? Math.max(0, this.now() - (this.stageStartedAt.get(index) ?? this.now()))
          : finiteDuration(input.durationMs);
      candidate.stages[index] = {
        ...stage,
        status: failure === undefined ? 'completed' : 'failed',
        ...(raw === undefined ? {} : { rawOutput: raw.text }),
        tools,
        citationIds: this.sanitizeIds(input.citationIds),
        usage: sanitizeUsage(input.usage),
        durationMs,
        ...(sanitizedFailure === undefined ? {} : { failure: sanitizedFailure }),
        ...(raw?.changed === true ||
        tools.some(({ truncated }) => truncated === true) ||
        sanitizedFailure?.details?.['redacted'] === REDACTION_MARKER
          ? { truncated: true }
          : {})
      };
      candidate.usage = addUsage(candidate.usage, candidate.stages[index]!.usage);
      this.stageStartedAt.delete(index);
      return true;
    });
  }

  private updateRunning(
    lease: AgentRunTraceLease,
    update: (candidate: Extract<AgentRunTrace, { status: 'running' }>) => boolean
  ): void {
    if (this.trace?.status !== 'running' || this.activeLease !== lease) return;
    const candidate = structuredClone(this.trace);
    if (!update(candidate)) return;
    const committed = this.prepare(candidate);
    if (committed !== null) this.trace = committed;
  }

  private sanitize(value: string, maxBytes = MAX_TRACE_TEXT_MAX_BYTES): SanitizedText {
    if (this.failClosedRedaction) {
      return { text: REDACTION_MARKER, changed: value !== REDACTION_MARKER };
    }
    const privateRedacted = redactPrivateTraceText(value, this.sensitiveValues);
    const bounded = headTailUtf8(privateRedacted, Math.min(maxBytes, MAX_TRACE_TEXT_MAX_BYTES));
    const shared = sanitizeTraceText(bounded.text, {
      maxBytes: Math.min(maxBytes, MAX_TRACE_TEXT_MAX_BYTES),
      customHeaderValues: this.sensitiveValues.filter((value) => !/^[0-9]+$/u.test(value))
    });
    return {
      text: shared.text,
      changed:
        privateRedacted !== value ||
        bounded.truncated ||
        shared.truncated ||
        shared.text !== bounded.text
    };
  }

  private sanitizeIds(values: readonly string[] | undefined): string[] {
    const unique = new Set<string>();
    for (const value of values ?? []) {
      const sanitized = this.sanitize(value, 128).text;
      if (sanitized.length > 0) unique.add(sanitized);
      if (unique.size >= 256) break;
    }
    return [...unique];
  }

  private sanitizeTool(tool: AgentToolTrace): AgentToolTrace {
    const input = tool.inputSummary === undefined ? undefined : this.sanitize(tool.inputSummary);
    const output = tool.outputSummary === undefined ? undefined : this.sanitize(tool.outputSummary);
    const failure = tool.failure === undefined ? undefined : this.sanitizeFailure(tool.failure);
    const name = this.sanitize(tool.name, 128);
    const changed =
      name.changed ||
      input?.changed === true ||
      output?.changed === true ||
      failure?.details?.['redacted'] === REDACTION_MARKER;
    return {
      name: name.text || REDACTION_MARKER,
      status: tool.status,
      ...(input === undefined ? {} : { inputSummary: input.text }),
      ...(output === undefined ? {} : { outputSummary: output.text }),
      ...(tool.durationMs === undefined ? {} : { durationMs: finiteDuration(tool.durationMs) }),
      ...(failure === undefined ? {} : { failure }),
      ...(tool.truncated === true || changed ? { truncated: true } : {})
    };
  }

  private sanitizeFailure(failure: AgentFailure): AgentFailure {
    const message = this.sanitize(failure.message, 1_000);
    let redacted = message.changed;
    const details =
      failure.details === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(failure.details)
              .slice(0, 31)
              .map(([key, value]) => {
                const sanitizedKey = this.sanitize(key, 80);
                const sanitizedValue = this.sanitize(value);
                redacted ||= sanitizedKey.changed || sanitizedValue.changed;
                return [sanitizedKey.text || REDACTION_MARKER, sanitizedValue.text];
              })
          );
    return {
      code: failure.code,
      message: message.text || REDACTION_MARKER,
      retryable: failure.retryable,
      ...(details === undefined
        ? redacted
          ? { details: { redacted: REDACTION_MARKER } }
          : {}
        : {
            details: {
              ...details,
              ...(redacted ? { redacted: REDACTION_MARKER } : {})
            }
          })
    };
  }

  private prepare(value: unknown): AgentRunTrace | null {
    const parsed = agentRunTraceSchema.safeParse(value);
    if (!parsed.success) return null;
    const compacted = structuredClone(parsed.data);
    compactTraceToBudget(compacted, this.maxBytes);
    const final = agentRunTraceSchema.safeParse(compacted);
    if (!final.success) {
      throw new Error('Trace compaction produced an invalid trace');
    }
    if (jsonBytes(final.data) > this.maxBytes) {
      throw new RangeError('Trace compaction could not satisfy the configured byte budget');
    }
    return final.data;
  }

  private resanitizeTrace(trace: Extract<AgentRunTrace, { status: 'running' }>): void {
    trace.correlationId = this.sanitize(trace.correlationId, 128).text || REDACTION_MARKER;
    trace.model = this.sanitize(trace.model, 256).text || REDACTION_MARKER;
    for (const stage of trace.stages) {
      let changed = false;
      if (stage.inputSummary !== undefined) {
        const sanitized = this.sanitize(stage.inputSummary);
        stage.inputSummary = sanitized.text;
        changed ||= sanitized.changed;
      }
      if (stage.rawOutput !== undefined) {
        const sanitized = this.sanitize(stage.rawOutput);
        stage.rawOutput = sanitized.text;
        changed ||= sanitized.changed;
      }
      const citationIds = this.sanitizeIds(stage.citationIds);
      changed ||= citationIds.some((id, index) => id !== stage.citationIds[index]);
      stage.citationIds = citationIds;
      stage.tools = stage.tools.map((tool) => {
        const sanitized = this.sanitizeTool(tool);
        changed ||= JSON.stringify(sanitized) !== JSON.stringify(tool);
        return sanitized;
      });
      if (stage.failure !== undefined) {
        const sanitized = this.sanitizeFailure(stage.failure);
        changed ||= JSON.stringify(sanitized) !== JSON.stringify(stage.failure);
        stage.failure = sanitized;
      }
      if (changed) stage.truncated = true;
    }
  }
}

function findStartedStage(trace: AgentRunTrace, stage: AgentStage): number {
  for (let index = trace.stages.length - 1; index >= 0; index -= 1) {
    const candidate = trace.stages[index]!;
    if (candidate.stage === stage && candidate.status === 'started') return index;
  }
  return -1;
}

function buildSensitiveRegistry(
  existing: readonly string[],
  incoming: readonly string[] | undefined
): { values: readonly string[]; failClosed: boolean } {
  const unique = new Set(existing);
  let failClosed = false;
  for (const value of incoming ?? []) {
    if (value.length === 0) continue;
    if (value.length > MAX_TRACE_CUSTOM_HEADER_VALUE_LENGTH) {
      failClosed = true;
      continue;
    }
    unique.add(value);
  }
  const values = [...unique].sort(
    (left, right) => right.length - left.length || left.localeCompare(right)
  );
  if (
    values.length > MAX_TRACE_CUSTOM_HEADER_VALUES ||
    values.reduce((total, value) => total + value.length, 0) >
      MAX_TRACE_CUSTOM_HEADER_AGGREGATE_LENGTH
  ) {
    return { values: [], failClosed: true };
  }
  return { values, failClosed };
}

function redactPrivateTraceText(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value
    .replace(
      /("(?:uid|game_uid|nickname|privateProfile|private_profile)"\s*:\s*)"(?:\\.|[^"\\])*(?:"|$)/giu,
      '$1"[REDACTED]"'
    )
    .replace(
      /((?:^|[\s,{;；，])(?:(?:uid|game_uid)\s*(?:[:=：]|-)|(?:nickname|private[-_ ]?profile)\s*[:=：])\s*)[^\r\n,;}；，]+/gimu,
      '$1[REDACTED]'
    )
    .replace(
      /("(?:apiKey|ANTHROPIC_AUTH_TOKEN|Authorization|Cookie)"\s*:\s*)"(?:\\.|[^"\\])*(?:"|$)/giu,
      '$1"[REDACTED]"'
    )
    .replace(/((?<!")\b(?:Authorization|Cookie)\b\s*[:=：]\s*)[^\r\n]*/giu, '$1[REDACTED]')
    .replace(
      /((?<!")\b(?:apiKey|ANTHROPIC_AUTH_TOKEN)\b\s*[:=：]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\r\n,;}；，]+)/giu,
      '$1[REDACTED]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]');
  for (const secret of sensitiveValues) {
    redacted = redacted.replace(sensitiveValuePattern(secret), REDACTION_MARKER);
  }
  return containsCanonicalPrivacyLeak(canonicalTracePrivacyText(redacted))
    ? REDACTION_MARKER
    : redacted;
}

function sensitiveValuePattern(value: string): RegExp {
  if (/^[0-9]+$/u.test(value)) {
    const digits = Array.from(value)
      .map((digit) => {
        const fullwidth = String.fromCodePoint(0xff10 + Number(digit));
        return `[${digit}${fullwidth}]\\p{Default_Ignorable_Code_Point}*`;
      })
      .join('');
    return new RegExp(`(?<!\\p{Decimal_Number})${digits}(?!\\p{Decimal_Number})`, 'giu');
  }
  return new RegExp(escapeRegExp(value), 'giu');
}

function canonicalTracePrivacyText(value: string): string {
  let canonical = value.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  for (let round = 0; round < 8 && /%[0-9a-f]{2}/iu.test(canonical); round += 1) {
    const decoded = decodePercentRuns(canonical);
    if (decoded === canonical) break;
    canonical = decoded.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  }
  return canonical;
}

function decodePercentRuns(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded.replace(/%([0-7][0-9a-f])/giu, (_, byte: string) =>
        String.fromCodePoint(Number.parseInt(byte, 16))
      );
    }
  });
}

function containsCanonicalPrivacyLeak(value: string): boolean {
  const label =
    '(?:uid|game_uid|nickname|private[-_ ]?profile|apiKey|ANTHROPIC_AUTH_TOKEN|Authorization|Cookie)';
  const valuePattern = '([^\\r\\n,;}；，]+)';
  const labeledValues = [
    ...value.matchAll(new RegExp(`["']${label}["']\\s*[:=：]\\s*${valuePattern}`, 'gimu')),
    ...value.matchAll(
      new RegExp(`(?:^|[^\\p{L}\\p{N}_])${label}\\s*(?:[:=：]|-)\\s*${valuePattern}`, 'gimu')
    ),
    ...value.matchAll(new RegExp(`\\bBearer\\s+${valuePattern}`, 'gimu'))
  ];
  return labeledValues.some((match) => !isExactRedactionMarker(match[1] ?? ''));
}

function isExactRedactionMarker(value: string): boolean {
  let normalized = value.trim();
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized === REDACTION_MARKER;
}

function sanitizeUsage(usage: AgentUsage | undefined): AgentUsage {
  return {
    inputTokens: nonnegativeInteger(usage?.inputTokens),
    outputTokens: nonnegativeInteger(usage?.outputTokens),
    ...(usage?.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: nonnegativeInteger(usage.cacheReadTokens) }),
    ...(usage?.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: nonnegativeInteger(usage.cacheCreationTokens) })
  };
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...((left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0) === 0
      ? {}
      : { cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0) }),
    ...((left.cacheCreationTokens ?? 0) + (right.cacheCreationTokens ?? 0) === 0
      ? {}
      : {
          cacheCreationTokens: (left.cacheCreationTokens ?? 0) + (right.cacheCreationTokens ?? 0)
        })
  };
}

function nonnegativeInteger(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) ? Math.min(86_400_000, Math.max(0, value)) : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
