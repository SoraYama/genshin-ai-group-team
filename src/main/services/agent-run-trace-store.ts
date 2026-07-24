import {
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

const DEFAULT_MAX_BYTES = 256 * 1024;
const MIN_MAX_BYTES = 4 * 1024;
const TRUNCATION_MARKER = '\n…[TRUNCATED]…\n';
const REDACTION_MARKER = '[REDACTED]';
const EMPTY_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0 };

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

export interface AgentRunTraceWriter {
  start(input: StartTraceInput): void;
  startStage(correlationId: string, input: StartStageInput): void;
  completeStage(correlationId: string, input: CompleteStageInput): void;
  failStage(correlationId: string, input: FailStageInput): void;
  skipStage(correlationId: string, input: SkipStageInput): void;
  finish(correlationId: string, input: FinishTraceInput): void;
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
  private activeCorrelationId: string | null = null;
  private sensitiveValues: readonly string[] = [];
  private readonly stageStartedAt = new Map<number, number>();

  constructor(options: AgentRunTraceStoreOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_MAX_BYTES) {
      throw new RangeError(`maxBytes must be a safe integer of at least ${MIN_MAX_BYTES}`);
    }
    this.maxBytes = maxBytes;
    this.now = options.now ?? Date.now;
  }

  start(input: StartTraceInput): void {
    this.sensitiveValues = normalizeSensitiveValues(input.sensitiveValues);
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
      this.activeCorrelationId = null;
      this.sensitiveValues = [];
      this.stageStartedAt.clear();
      return;
    }
    this.trace = committed;
    this.activeCorrelationId = input.correlationId;
    this.stageStartedAt.clear();
  }

  startStage(correlationId: string, input: StartStageInput): void {
    this.updateRunning(correlationId, (candidate) => {
      if (
        !agentStageSchema.safeParse(input.stage).success ||
        candidate.stages.some(({ status }) => status === 'started')
      ) {
        return false;
      }
      this.sensitiveValues = normalizeSensitiveValues([
        ...(input.sensitiveValues ?? []),
        ...this.sensitiveValues
      ]);
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

  completeStage(correlationId: string, input: CompleteStageInput): void {
    this.terminalStage(correlationId, input, undefined);
  }

  failStage(correlationId: string, input: FailStageInput): void {
    this.terminalStage(correlationId, input, input.failure);
  }

  skipStage(correlationId: string, input: SkipStageInput): void {
    this.updateRunning(correlationId, (candidate) => {
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

  finish(correlationId: string, input: FinishTraceInput): void {
    if (
      this.trace?.status !== 'running' ||
      this.activeCorrelationId !== correlationId ||
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
  }

  latest(): AgentRunTrace | null {
    return this.trace === null ? null : structuredClone(this.trace);
  }

  private terminalStage(
    correlationId: string,
    input: CompleteStageInput,
    failure: AgentFailure | undefined
  ): void {
    this.updateRunning(correlationId, (candidate) => {
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
    correlationId: string,
    update: (candidate: Extract<AgentRunTrace, { status: 'running' }>) => boolean
  ): void {
    if (this.trace?.status !== 'running' || this.activeCorrelationId !== correlationId) return;
    const candidate = structuredClone(this.trace);
    if (!update(candidate)) return;
    const committed = this.prepare(candidate);
    if (committed !== null) this.trace = committed;
  }

  private sanitize(value: string, maxBytes = MAX_TRACE_TEXT_MAX_BYTES): SanitizedText {
    const privateRedacted = redactPrivateTraceText(value, this.sensitiveValues);
    const bounded = headTailUtf8(privateRedacted, Math.min(maxBytes, MAX_TRACE_TEXT_MAX_BYTES));
    const shared = sanitizeTraceText(bounded.text, {
      maxBytes: Math.min(maxBytes, MAX_TRACE_TEXT_MAX_BYTES),
      customHeaderValues: this.sensitiveValues
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
    if (!final.success || jsonBytes(final.data) > this.maxBytes) return null;
    return final.data;
  }
}

function findStartedStage(trace: AgentRunTrace, stage: AgentStage): number {
  for (let index = trace.stages.length - 1; index >= 0; index -= 1) {
    const candidate = trace.stages[index]!;
    if (candidate.stage === stage && candidate.status === 'started') return index;
  }
  return -1;
}

function normalizeSensitiveValues(values: readonly string[] | undefined): readonly string[] {
  const unique = new Set<string>();
  for (const value of values ?? []) {
    if (value.length > 0 && value.length <= MAX_TRACE_CUSTOM_HEADER_VALUE_LENGTH) {
      unique.add(value);
    }
    if (unique.size >= MAX_TRACE_CUSTOM_HEADER_VALUES) break;
  }
  return [...unique];
}

function redactPrivateTraceText(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value
    .replace(
      /("(?:uid|game_uid|nickname|privateProfile|private_profile)"\s*:\s*)"(?:\\.|[^"\\])*(?:"|$)/giu,
      '$1"[REDACTED]"'
    )
    .replace(
      /((?:^|[\s,{;])(?:uid|game_uid|nickname|private[-_ ]?profile)\s*[:=：]\s*)[^\r\n,;}]+/gimu,
      '$1[REDACTED]'
    )
    .replace(/\p{Decimal_Number}{9,}/gu, REDACTION_MARKER);
  for (const secret of sensitiveValues) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'giu'), REDACTION_MARKER);
  }
  return redacted;
}

function headTailUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(value) <= maxBytes) return { text: value, truncated: false };
  const markerBytes = utf8Bytes(TRUNCATION_MARKER);
  if (maxBytes <= markerBytes) {
    return { text: utf8Prefix(TRUNCATION_MARKER, maxBytes), truncated: true };
  }
  const available = maxBytes - markerBytes;
  const headBudget = Math.ceil(available / 2);
  const tailBudget = Math.floor(available / 2);
  return {
    text: `${utf8Prefix(value, headBudget)}${TRUNCATION_MARKER}${utf8Suffix(value, tailBudget)}`,
    truncated: true
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > maxBytes) break;
    characters.push(character);
    bytes += size;
  }
  return characters.join('');
}

function utf8Suffix(value: string, maxBytes: number): string {
  const characters = Array.from(value);
  const result: string[] = [];
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const size = utf8Bytes(character);
    if (bytes + size > maxBytes) break;
    result.push(character);
    bytes += size;
  }
  return result.reverse().join('');
}

function compactTraceToBudget(trace: AgentRunTrace, maxBytes: number): void {
  let guard = 0;
  while (jsonBytes(trace) > maxBytes && guard < 256) {
    guard += 1;
    const fields = compactableTextFields(trace).sort(
      (left, right) => utf8Bytes(right.get()) - utf8Bytes(left.get())
    );
    const field = fields.find(({ get }) => utf8Bytes(get()) > utf8Bytes(TRUNCATION_MARKER));
    if (field === undefined) break;
    const current = field.get();
    const over = jsonBytes(trace) - maxBytes;
    const nextBudget = Math.max(
      utf8Bytes(TRUNCATION_MARKER),
      utf8Bytes(current) - Math.max(over, Math.ceil(utf8Bytes(current) / 3))
    );
    const next = headTailUtf8(current, nextBudget).text;
    if (next === current) break;
    field.set(next);
    field.mark();
  }
  if (jsonBytes(trace) <= maxBytes) return;
  for (const stage of trace.stages) {
    while (stage.citationIds.length > 0 && jsonBytes(trace) > maxBytes) {
      stage.citationIds.pop();
      stage.truncated = true;
    }
  }
}

function compactableTextFields(trace: AgentRunTrace): Array<{
  get: () => string;
  set: (value: string) => void;
  mark: () => void;
}> {
  const fields: Array<{
    get: () => string;
    set: (value: string) => void;
    mark: () => void;
  }> = [];
  const add = (
    owner: { truncated?: boolean } | (() => void),
    get: () => string | undefined,
    set: (value: string) => void
  ) => {
    if (get() === undefined) return;
    fields.push({
      get: () => get() ?? '',
      set,
      mark: () => {
        if (typeof owner === 'function') owner();
        else owner.truncated = true;
      }
    });
  };
  for (const stage of trace.stages) {
    add(
      stage,
      () => stage.inputSummary,
      (value) => (stage.inputSummary = value)
    );
    add(
      stage,
      () => stage.rawOutput,
      (value) => (stage.rawOutput = value)
    );
    if (stage.failure !== undefined) {
      add(
        stage,
        () => stage.failure?.message,
        (value) => (stage.failure!.message = value)
      );
      Object.keys(stage.failure.details ?? {}).forEach((key) =>
        add(
          stage,
          () => stage.failure?.details?.[key],
          (value) => (stage.failure!.details![key] = value)
        )
      );
    }
    for (const tool of stage.tools) {
      add(
        tool,
        () => tool.inputSummary,
        (value) => (tool.inputSummary = value)
      );
      add(
        tool,
        () => tool.outputSummary,
        (value) => (tool.outputSummary = value)
      );
      if (tool.failure !== undefined) {
        add(
          tool,
          () => tool.failure?.message,
          (value) => (tool.failure!.message = value)
        );
        Object.keys(tool.failure.details ?? {}).forEach((key) =>
          add(
            tool,
            () => tool.failure?.details?.[key],
            (value) => (tool.failure!.details![key] = value)
          )
        );
      }
    }
  }
  if (trace.status === 'failed') {
    const markTerminalFailure = () => {
      trace.failure.details = {
        ...Object.fromEntries(Object.entries(trace.failure.details ?? {}).slice(0, 31)),
        truncated: TRUNCATION_MARKER
      };
    };
    add(
      markTerminalFailure,
      () => trace.failure.message,
      (value) => (trace.failure.message = value)
    );
    Object.keys(trace.failure.details ?? {}).forEach((key) =>
      add(
        markTerminalFailure,
        () => trace.failure.details?.[key],
        (value) => (trace.failure.details![key] = value)
      )
    );
  }
  return fields;
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

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
