import {
  MAX_TRACE_TEXT_MAX_BYTES,
  agentFinalSourceSchema,
  agentRunTraceSchema,
  agentStageSchema,
  type AgentFailure,
  type AgentRunTrace,
  type AgentStage,
  type AgentToolTrace,
  type AgentTraceKnowledgeSummary,
  type AgentUsage
} from '../../shared/agent-run-trace.js';
import {
  TRACE_REDACTION_MARKER,
  buildTraceSensitiveRegistry,
  redactTraceSecrets,
  type TraceSensitiveRegistry
} from '../../shared/agent-run-trace-redactor.js';
import { compactTraceToBudget, headTailUtf8, jsonBytes } from './agent-run-trace-compactor.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
export const MIN_AGENT_RUN_TRACE_BYTES = 16 * 1024;
const REDACTION_MARKER = TRACE_REDACTION_MARKER;
const MAX_TOOL_SUMMARY_BYTES = 2_048;
const MAX_TOOL_INPUT_CHARACTERS = 4_096;
const MAX_TOOL_FAILURE_DETAILS = 4;
const MAX_TOOL_FAILURE_DETAIL_BYTES = 512;
const MAX_TOOL_FAILURE_DETAIL_CHARACTERS = 2_048;
const EMPTY_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0 };
const TRACE_LEASE_GENERATION = Symbol('agent-run-trace-generation');
const EMPTY_SENSITIVE_REGISTRY = buildTraceSensitiveRegistry([], []);

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
  private sensitiveRegistry: TraceSensitiveRegistry = EMPTY_SENSITIVE_REGISTRY;
  private readonly stageStartedAt = new Map<number, number>();

  constructor(options: AgentRunTraceStoreOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_AGENT_RUN_TRACE_BYTES) {
      throw new RangeError(
        `maxBytes must be a safe integer of at least ${MIN_AGENT_RUN_TRACE_BYTES}`
      );
    }
    this.maxBytes = maxBytes;
    this.now = options.now ?? Date.now;
  }

  start(input: StartTraceInput): AgentRunTraceLease {
    const registry = buildTraceSensitiveRegistry([], input.sensitiveValues);
    const correlationId =
      this.sanitize(input.correlationId, 128, undefined, registry).text || REDACTION_MARKER;
    const model = this.sanitize(input.model, 256, undefined, registry).text || REDACTION_MARKER;
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
      throw new TypeError('Trace start input is invalid');
    }
    const lease = Object.freeze({
      correlationId: input.correlationId,
      [TRACE_LEASE_GENERATION]: Symbol('agent-run')
    });
    this.trace = committed;
    this.activeLease = lease;
    this.sensitiveRegistry = registry;
    this.stageStartedAt.clear();
    return lease;
  }

  startStage(lease: AgentRunTraceLease, input: StartStageInput): void {
    if (
      this.trace?.status !== 'running' ||
      this.activeLease !== lease ||
      !agentStageSchema.safeParse(input.stage).success ||
      this.trace.stages.some(({ status }) => status === 'started')
    ) {
      return;
    }
    const candidate = structuredClone(this.trace);
    const registry = this.sensitiveRegistry.failClosed
      ? this.sensitiveRegistry
      : buildTraceSensitiveRegistry(this.sensitiveRegistry.values, input.sensitiveValues);
    const registryChanged =
      registry.failClosed !== this.sensitiveRegistry.failClosed ||
      registry.values.some((value, index) => value !== this.sensitiveRegistry.values[index]);
    if (registryChanged) this.resanitizeTrace(candidate, registry);
    const summary =
      input.inputSummary === undefined
        ? undefined
        : this.sanitize(input.inputSummary, undefined, undefined, registry).text;
    candidate.stages.push({
      stage: input.stage,
      status: 'started',
      ...(summary === undefined ? {} : { inputSummary: summary }),
      tools: [],
      citationIds: this.sanitizeIds(input.citationIds, registry),
      usage: { ...EMPTY_USAGE }
    });
    const committed = this.prepare(candidate);
    if (committed === null) return;
    this.trace = committed;
    this.sensitiveRegistry = registry;
    this.stageStartedAt.set(candidate.stages.length - 1, this.now());
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
    this.sensitiveRegistry = EMPTY_SENSITIVE_REGISTRY;
  }

  latest(): AgentRunTrace | null {
    return this.trace === null ? null : structuredClone(this.trace);
  }

  private terminalStage(
    lease: AgentRunTraceLease,
    input: CompleteStageInput,
    failure: AgentFailure | undefined
  ): void {
    const committed = this.updateRunning(lease, (candidate) => {
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
      return true;
    });
    if (committed) {
      const trace = this.trace;
      if (trace !== null) {
        const index = findTerminalStage(trace, input.stage);
        if (index >= 0) this.stageStartedAt.delete(index);
      }
    }
  }

  private updateRunning(
    lease: AgentRunTraceLease,
    update: (candidate: Extract<AgentRunTrace, { status: 'running' }>) => boolean
  ): boolean {
    if (this.trace?.status !== 'running' || this.activeLease !== lease) return false;
    const candidate = structuredClone(this.trace);
    if (!update(candidate)) return false;
    const committed = this.prepare(candidate);
    if (committed === null) return false;
    this.trace = committed;
    return true;
  }

  private sanitize(
    value: string,
    maxBytes = MAX_TRACE_TEXT_MAX_BYTES,
    maxInputCharacters = MAX_TRACE_TEXT_MAX_BYTES,
    registry: TraceSensitiveRegistry = this.sensitiveRegistry
  ): SanitizedText {
    const prebounded = boundInputCharacters(value, maxInputCharacters);
    const redacted = redactTraceSecrets(prebounded.text, registry);
    const bounded = headTailUtf8(
      redacted.text,
      Math.min(maxBytes, MAX_TRACE_TEXT_MAX_BYTES)
    );
    return {
      text: bounded.text,
      changed: prebounded.truncated || redacted.redacted || bounded.truncated
    };
  }

  private sanitizeIds(
    values: readonly string[] | undefined,
    registry: TraceSensitiveRegistry = this.sensitiveRegistry
  ): string[] {
    const unique = new Set<string>();
    for (const value of values ?? []) {
      const sanitized = this.sanitize(value, 128, 512, registry).text;
      if (sanitized.length > 0) unique.add(sanitized);
      if (unique.size >= 256) break;
    }
    return [...unique];
  }

  private sanitizeTool(
    tool: AgentToolTrace,
    registry: TraceSensitiveRegistry = this.sensitiveRegistry
  ): AgentToolTrace {
    const input =
      tool.inputSummary === undefined
        ? undefined
        : this.sanitize(
            tool.inputSummary,
            MAX_TOOL_SUMMARY_BYTES,
            MAX_TOOL_INPUT_CHARACTERS,
            registry
          );
    const output =
      tool.outputSummary === undefined
        ? undefined
        : this.sanitize(
            tool.outputSummary,
            MAX_TOOL_SUMMARY_BYTES,
            MAX_TOOL_INPUT_CHARACTERS,
            registry
          );
    const failure =
      tool.failure === undefined ? undefined : this.sanitizeFailure(tool.failure, true, registry);
    const name = this.sanitize(tool.name, 128, 512, registry);
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

  private sanitizeFailure(
    failure: AgentFailure,
    toolFailure = false,
    registry: TraceSensitiveRegistry = this.sensitiveRegistry
  ): AgentFailure {
    const message = this.sanitize(
      failure.message,
      toolFailure ? MAX_TOOL_FAILURE_DETAIL_BYTES : 1_000,
      toolFailure ? MAX_TOOL_FAILURE_DETAIL_CHARACTERS : MAX_TRACE_TEXT_MAX_BYTES,
      registry
    );
    let redacted = message.changed;
    const details =
      failure.details === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(failure.details)
              .slice(0, toolFailure ? MAX_TOOL_FAILURE_DETAILS : 31)
              .map(([key, value]) => {
                const sanitizedKey = this.sanitize(key, 80, 512, registry);
                const sanitizedValue = this.sanitize(
                  value,
                  toolFailure ? MAX_TOOL_FAILURE_DETAIL_BYTES : MAX_TRACE_TEXT_MAX_BYTES,
                  toolFailure
                    ? MAX_TOOL_FAILURE_DETAIL_CHARACTERS
                    : MAX_TRACE_TEXT_MAX_BYTES,
                  registry
                );
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

  private resanitizeTrace(
    trace: Extract<AgentRunTrace, { status: 'running' }>,
    registry: TraceSensitiveRegistry
  ): void {
    trace.correlationId =
      this.sanitize(trace.correlationId, 128, undefined, registry).text || REDACTION_MARKER;
    trace.model = this.sanitize(trace.model, 256, undefined, registry).text || REDACTION_MARKER;
    for (const stage of trace.stages) {
      let changed = false;
      if (stage.truncated === true) {
        if (stage.inputSummary !== undefined) stage.inputSummary = REDACTION_MARKER;
        if (stage.rawOutput !== undefined) stage.rawOutput = REDACTION_MARKER;
        stage.tools = stage.tools.map((tool) => ({
          ...tool,
          ...(tool.truncated === true ? { name: REDACTION_MARKER } : {}),
          ...(tool.inputSummary === undefined ? {} : { inputSummary: REDACTION_MARKER }),
          ...(tool.outputSummary === undefined ? {} : { outputSummary: REDACTION_MARKER }),
          ...(tool.failure === undefined
            ? {}
            : {
                failure: {
                  ...tool.failure,
                  message: REDACTION_MARKER,
                  ...(tool.failure.details === undefined
                    ? {}
                    : { details: { redacted: REDACTION_MARKER } })
                }
              }),
          truncated: true
        }));
        if (stage.failure !== undefined) {
          stage.failure.message = REDACTION_MARKER;
          if (stage.failure.details !== undefined) {
            stage.failure.details = { redacted: REDACTION_MARKER };
          }
        }
        changed = true;
      }
      if (stage.inputSummary !== undefined) {
        const sanitized = this.sanitize(stage.inputSummary, undefined, undefined, registry);
        stage.inputSummary = sanitized.text;
        changed ||= sanitized.changed;
      }
      if (stage.rawOutput !== undefined) {
        const sanitized = this.sanitize(stage.rawOutput, undefined, undefined, registry);
        stage.rawOutput = sanitized.text;
        changed ||= sanitized.changed;
      }
      const citationIds = this.sanitizeIds(stage.citationIds, registry);
      changed ||= citationIds.some((id, index) => id !== stage.citationIds[index]);
      stage.citationIds = citationIds;
      stage.tools = stage.tools.map((tool) => {
        const sanitized = this.sanitizeTool(tool, registry);
        changed ||= JSON.stringify(sanitized) !== JSON.stringify(tool);
        return sanitized;
      });
      if (stage.failure !== undefined) {
        const sanitized = this.sanitizeFailure(stage.failure, false, registry);
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

function findTerminalStage(trace: AgentRunTrace, stage: AgentStage): number {
  for (let index = trace.stages.length - 1; index >= 0; index -= 1) {
    const candidate = trace.stages[index]!;
    if (candidate.stage === stage && candidate.status !== 'started') return index;
  }
  return -1;
}

function boundInputCharacters(
  value: string,
  maxCharacters: number
): { text: string; truncated: boolean } {
  if (value.length <= maxCharacters) return { text: value, truncated: false };
  // Do not join independently sampled head/tail fragments before redaction:
  // a credential label may fall in the omitted middle while its value survives
  // in the tail. Oversized untrusted fields therefore fail closed.
  return { text: REDACTION_MARKER, truncated: true };
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
