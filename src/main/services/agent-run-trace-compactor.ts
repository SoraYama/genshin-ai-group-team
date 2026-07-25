import type {
  AgentFailure,
  AgentRunTrace,
  AgentStageTrace,
  AgentToolTrace
} from '../../shared/agent-run-trace.js';

const TRUNCATION_MARKER = '\n…[TRUNCATED]…\n';

export interface TraceCompactionStats {
  measurements: number;
  pass: 'none' | 'quota' | 'summary' | 'skeleton';
}

export function headTailUtf8(
  value: string,
  maxBytes: number
): { text: string; truncated: boolean } {
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

/**
 * Compaction deliberately has a constant number of whole-trace measurements.
 * No pass sorts fields or repeatedly stringifies after individual mutations.
 */
export function compactTraceToBudget(
  trace: AgentRunTrace,
  maxBytes: number
): TraceCompactionStats {
  if (jsonBytes(trace) <= maxBytes) return { measurements: 1, pass: 'none' };

  applyTextQuotas(trace);
  if (jsonBytes(trace) <= maxBytes) return { measurements: 2, pass: 'quota' };

  summarizeOptionalPayload(trace);
  if (jsonBytes(trace) <= maxBytes) return { measurements: 3, pass: 'summary' };

  applyCanonicalSkeleton(trace);
  return { measurements: 4, pass: 'skeleton' };
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function applyTextQuotas(trace: AgentRunTrace): void {
  trace.correlationId = compactText(trace.correlationId, 128).text || 'trace';
  trace.model = compactText(trace.model, 128).text || 'model';
  for (const stage of trace.stages) {
    compactStageText(stage);
  }
  if (trace.status === 'failed') compactFailure(trace.failure, 256, 4, 128);
}

function compactStageText(stage: AgentStageTrace): void {
  let changed = false;
  if (stage.inputSummary !== undefined) {
    const compacted = compactText(stage.inputSummary, 512);
    stage.inputSummary = compacted.text;
    changed ||= compacted.truncated;
  }
  if (stage.rawOutput !== undefined) {
    const compacted = compactText(stage.rawOutput, 1_024);
    stage.rawOutput = compacted.text;
    changed ||= compacted.truncated;
  }
  if (stage.failure !== undefined) changed ||= compactFailure(stage.failure, 256, 4, 128);
  if (stage.citationIds.length > 16) {
    stage.citationIds = stage.citationIds.slice(0, 16);
    changed = true;
  }
  for (const tool of stage.tools) {
    changed ||= compactToolText(tool);
  }
  if (changed) stage.truncated = true;
}

function compactToolText(tool: AgentToolTrace): boolean {
  let changed = false;
  const name = compactText(tool.name, 96);
  tool.name = name.text || 'tool';
  changed ||= name.truncated;
  if (tool.inputSummary !== undefined) {
    const input = compactText(tool.inputSummary, 384);
    tool.inputSummary = input.text;
    changed ||= input.truncated;
  }
  if (tool.outputSummary !== undefined) {
    const output = compactText(tool.outputSummary, 384);
    tool.outputSummary = output.text;
    changed ||= output.truncated;
  }
  if (tool.failure !== undefined) changed ||= compactFailure(tool.failure, 192, 4, 96);
  if (changed) tool.truncated = true;
  return changed;
}

function compactFailure(
  failure: AgentFailure,
  messageBytes: number,
  detailCount: number,
  detailBytes: number
): boolean {
  let changed = false;
  const message = compactText(failure.message, messageBytes);
  failure.message = message.text || '!';
  changed ||= message.truncated;
  if (failure.details !== undefined) {
    const entries = Object.entries(failure.details);
    const bounded = entries.slice(0, detailCount).map(([key, value]) => {
      const compacted = compactText(value, detailBytes);
      changed ||= compacted.truncated;
      return [key, compacted.text] as const;
    });
    changed ||= entries.length > bounded.length;
    failure.details = Object.fromEntries(bounded);
  }
  return changed;
}

function summarizeOptionalPayload(trace: AgentRunTrace): void {
  for (const stage of trace.stages) {
    delete stage.inputSummary;
    delete stage.rawOutput;
    delete stage.durationMs;
    stage.citationIds = [];
    if (stage.failure !== undefined) {
      stage.failure.message = compactText(stage.failure.message, 96).text || '!';
      delete stage.failure.details;
    }
    if (stage.tools.length > 0) {
      const representative =
        stage.tools.find(({ status }) => status === 'failed') ?? stage.tools[0]!;
      stage.tools = [minimizeTool(representative)];
    }
    stage.truncated = true;
  }
  if (trace.status === 'failed') {
    trace.failure.message = compactText(trace.failure.message, 96).text || '!';
    delete trace.failure.details;
  }
}

function applyCanonicalSkeleton(trace: AgentRunTrace): void {
  trace.correlationId = compactText(trace.correlationId, 32).text || 'trace';
  trace.model = compactText(trace.model, 32).text || 'model';
  trace.stages = trace.stages.map((stage) => {
    const tool =
      stage.tools.find(({ status }) => status === 'failed') ?? stage.tools[0];
    return {
      stage: stage.stage,
      status: stage.status,
      tools: tool === undefined ? [] : [minimizeTool(tool)],
      citationIds: [],
      usage: stage.usage,
      ...(stage.failure === undefined ? {} : { failure: minimizeFailure(stage.failure) }),
      truncated: true
    };
  });
  if (trace.status === 'failed') trace.failure = minimizeFailure(trace.failure);
}

function minimizeTool(tool: AgentToolTrace): AgentToolTrace {
  return {
    name: compactText(tool.name, 48).text || 'tool',
    status: tool.status,
    ...(tool.failure === undefined ? {} : { failure: minimizeFailure(tool.failure) }),
    truncated: true
  };
}

function minimizeFailure(failure: AgentFailure): AgentFailure {
  return {
    code: failure.code,
    message: '!',
    retryable: failure.retryable
  };
}

function compactText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  return headTailUtf8(value, maxBytes);
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
