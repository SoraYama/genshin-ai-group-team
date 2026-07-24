import type { AgentRunTrace, AgentToolTrace } from '../../shared/agent-run-trace.js';

const TRUNCATION_MARKER = '\n…[TRUNCATED]…\n';

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

export function compactTraceToBudget(trace: AgentRunTrace, maxBytes: number): void {
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
  if (jsonBytes(trace) <= maxBytes) return;
  dropOptionalTraceText(trace, maxBytes);
  if (jsonBytes(trace) <= maxBytes) return;
  summarizeTraceTools(trace, maxBytes);
  if (jsonBytes(trace) <= maxBytes) return;
  minimizeFailureText(trace, maxBytes);
  if (jsonBytes(trace) <= maxBytes) return;
  minimizeTraceIdentifiers(trace, maxBytes);
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
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

function dropOptionalTraceText(trace: AgentRunTrace, maxBytes: number): void {
  for (const stage of trace.stages) {
    if (jsonBytes(trace) <= maxBytes) return;
    if (stage.inputSummary !== undefined) {
      delete stage.inputSummary;
      stage.truncated = true;
    }
    if (jsonBytes(trace) <= maxBytes) return;
    if (stage.rawOutput !== undefined) {
      delete stage.rawOutput;
      stage.truncated = true;
    }
    for (const tool of stage.tools) {
      if (jsonBytes(trace) <= maxBytes) return;
      if (tool.inputSummary !== undefined) {
        delete tool.inputSummary;
        tool.truncated = true;
        stage.truncated = true;
      }
      if (jsonBytes(trace) <= maxBytes) return;
      if (tool.outputSummary !== undefined) {
        delete tool.outputSummary;
        tool.truncated = true;
        stage.truncated = true;
      }
      if (jsonBytes(trace) <= maxBytes) return;
      if (tool.durationMs !== undefined) {
        delete tool.durationMs;
        tool.truncated = true;
        stage.truncated = true;
      }
    }
    if (jsonBytes(trace) <= maxBytes) return;
    if (stage.durationMs !== undefined) {
      delete stage.durationMs;
      stage.truncated = true;
    }
  }
}

function summarizeTraceTools(trace: AgentRunTrace, maxBytes: number): void {
  for (const stage of trace.stages) {
    if (jsonBytes(trace) <= maxBytes) return;
    if (stage.tools.length > 3) {
      const first = minimizeTool(stage.tools[0]!);
      const last = minimizeTool(stage.tools[stage.tools.length - 1]!);
      const omitted = stage.tools.slice(1, -1);
      stage.tools = [first, summarizedTool(omitted), last];
      stage.truncated = true;
    }
  }
  for (const stage of trace.stages) {
    if (jsonBytes(trace) <= maxBytes) return;
    if (stage.tools.length > 0) {
      stage.tools = [summarizedTool(stage.tools)];
      stage.truncated = true;
    }
  }
}

function minimizeTool(tool: AgentToolTrace): AgentToolTrace {
  return tool.status === 'failed'
    ? {
        name: headTailUtf8(tool.name, 64).text || 'tool',
        status: 'failed',
        failure: {
          code: tool.failure?.code ?? 'TOOL_REQUIREMENT_FAILED',
          message: '!',
          retryable: tool.failure?.retryable ?? false
        },
        truncated: true
      }
    : {
        name: headTailUtf8(tool.name, 64).text || 'tool',
        status: tool.status,
        truncated: true
      };
}

function summarizedTool(tools: readonly AgentToolTrace[]): AgentToolTrace {
  const failed = tools.find(({ status }) => status === 'failed');
  return failed === undefined
    ? {
        name: `[${tools.length} tools summarized]`,
        status: 'completed',
        truncated: true
      }
    : {
        name: `[${tools.length} tools summarized]`,
        status: 'failed',
        failure: {
          code: failed.failure?.code ?? 'TOOL_REQUIREMENT_FAILED',
          message: '!',
          retryable: failed.failure?.retryable ?? false
        },
        truncated: true
      };
}

function minimizeFailureText(trace: AgentRunTrace, maxBytes: number): void {
  for (const stage of trace.stages) {
    if (jsonBytes(trace) <= maxBytes) return;
    if (stage.failure !== undefined) {
      stage.failure.message = '!';
      delete stage.failure.details;
      stage.truncated = true;
    }
    for (const tool of stage.tools) {
      if (jsonBytes(trace) <= maxBytes) return;
      if (tool.failure !== undefined) {
        tool.failure.message = '!';
        delete tool.failure.details;
        tool.truncated = true;
        stage.truncated = true;
      }
    }
  }
  if (jsonBytes(trace) <= maxBytes || trace.status !== 'failed') return;
  trace.failure.message = '!';
  delete trace.failure.details;
}

function minimizeTraceIdentifiers(trace: AgentRunTrace, maxBytes: number): void {
  if (jsonBytes(trace) <= maxBytes) return;
  trace.correlationId = headTailUtf8(trace.correlationId, 32).text || 'trace';
  if (jsonBytes(trace) <= maxBytes) return;
  trace.model = headTailUtf8(trace.model, 32).text || 'model';
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
