const JSON_FENCE_PATTERN = /^\s*```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/u;

export function parseAgentJson(value: string): unknown | undefined {
  const fenced = JSON_FENCE_PATTERN.exec(value);
  return parseJsonCandidate(fenced?.[1] ?? value);
}

function parseJsonCandidate(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    try {
      return JSON.parse(escapeUnambiguousProseQuotes(value)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function escapeUnambiguousProseQuotes(value: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (inString && character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (character !== '"') {
      output += character;
      continue;
    }
    if (!inString) {
      inString = true;
      output += character;
      continue;
    }
    const next = nextNonWhitespace(value, index + 1);
    if (next === undefined || ':,}]'.includes(next)) {
      inString = false;
      output += character;
    } else {
      output += '\\"';
    }
  }
  return output;
}

function nextNonWhitespace(value: string, start: number): string | undefined {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (!/\s/u.test(character)) return character;
  }
  return undefined;
}
