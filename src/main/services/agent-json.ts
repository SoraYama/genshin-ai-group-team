const JSON_FENCE_PATTERN = /^\s*```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/u;

export function parseAgentJson(value: string): unknown | undefined {
  const fenced = JSON_FENCE_PATTERN.exec(value);
  return parseJsonCandidate(fenced?.[1] ?? value);
}

export function parseStructurallyIncompleteAgentJson(
  value: string
): unknown | undefined {
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    !['{', '['].includes(candidate[0]!) ||
    parseJsonCandidate(candidate) !== undefined
  ) {
    return undefined;
  }
  const repaired = repairMissingStructuralClosers(candidate);
  return repaired === undefined ? undefined : parseJsonCandidate(repaired);
}

export function parseAgentJsonWithKnownStringArrays(
  value: string,
  fieldNames: readonly string[]
): unknown | undefined {
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    !['{', '['].includes(candidate[0]!) ||
    fieldNames.length === 0 ||
    fieldNames.length > 16
  ) {
    return undefined;
  }
  let repaired = candidate;
  let repairs = 0;
  for (const fieldName of new Set(fieldNames)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(fieldName)) return undefined;
    const pattern = new RegExp(
      `("${escapeRegExp(fieldName)}"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*")\\s*\\]`,
      'gu'
    );
    repaired = repaired.replace(pattern, (match, prefix: string, quoted: string) => {
      if (repairs >= 8) return match;
      repairs += 1;
      return `${prefix}[${quoted}]`;
    });
  }
  if (repairs === 0 || repairs > 8) return undefined;
  return (
    parseJsonCandidate(repaired) ??
    parseStructurallyIncompleteAgentJson(repaired)
  );
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

function repairMissingStructuralClosers(value: string): string | undefined {
  const stack: Array<'}' | ']'> = [];
  let output = '';
  let inString = false;
  let escaped = false;
  let insertions = 0;
  for (const character of value) {
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (inString) {
      output += character;
      if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (!stack.includes(character)) return undefined;
      while (stack.at(-1) !== character) {
        output += stack.pop();
        insertions += 1;
        if (insertions > 8) return undefined;
      }
      stack.pop();
    }
    output += character;
  }
  if (inString || escaped) return undefined;
  while (stack.length > 0) {
    output += stack.pop();
    insertions += 1;
    if (insertions > 8) return undefined;
  }
  return insertions === 0 ? undefined : output;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
