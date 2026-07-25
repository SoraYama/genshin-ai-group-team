export const TRACE_REDACTION_MARKER = '[REDACTED]';
export const MAX_TRACE_CUSTOM_HEADER_VALUES = 64;
export const MAX_TRACE_CUSTOM_HEADER_VALUE_LENGTH = 4_096;
export const MAX_TRACE_CUSTOM_HEADER_AGGREGATE_LENGTH = 64 * 1_024;

export interface TraceSensitiveRegistry {
  values: readonly string[];
  canonicalValues: readonly string[];
  failClosed: boolean;
}

export interface RedactedTraceText {
  text: string;
  redacted: boolean;
}

export function buildTraceSensitiveRegistry(
  existing: readonly string[],
  incoming: readonly string[] | undefined
): TraceSensitiveRegistry {
  const unique = new Map<string, string>();
  let failClosed = false;
  for (const value of [...existing, ...(incoming ?? [])]) {
    if (value.length === 0) continue;
    if (value.length > MAX_TRACE_CUSTOM_HEADER_VALUE_LENGTH) {
      failClosed = true;
      continue;
    }
    const key = value.toLowerCase();
    if (!unique.has(key)) unique.set(key, value);
  }
  const values = [...unique.values()].sort(
    (left, right) => right.length - left.length || left.localeCompare(right)
  );
  if (
    values.length > MAX_TRACE_CUSTOM_HEADER_VALUES ||
    values.reduce((total, value) => total + value.length, 0) >
      MAX_TRACE_CUSTOM_HEADER_AGGREGATE_LENGTH
  ) {
    return { values: [], canonicalValues: [], failClosed: true };
  }
  return {
    values,
    canonicalValues: values.map(canonicalizeTraceText),
    failClosed
  };
}

export function redactTraceSecrets(
  value: string,
  registry: TraceSensitiveRegistry
): RedactedTraceText {
  if (registry.failClosed) {
    return {
      text: TRACE_REDACTION_MARKER,
      redacted: value !== TRACE_REDACTION_MARKER
    };
  }
  let redacted = redactRecognizedTraceSecrets(value);
  const numericSecrets = registry.values.filter((secret) => /^[0-9]+$/u.test(secret));
  const textSecrets = registry.values.filter((secret) => !/^[0-9]+$/u.test(secret));
  if (textSecrets.length > 0) {
    redacted = redacted.replace(
      new RegExp(textSecrets.map(escapeRegExp).join('|'), 'giu'),
      TRACE_REDACTION_MARKER
    );
  }
  for (const secret of numericSecrets) {
    redacted = redacted.replace(sensitiveValuePattern(secret), TRACE_REDACTION_MARKER);
  }
  const canonical = canonicalizeTraceText(redacted);
  const canonicalLeak =
    containsCanonicalPrivacyLeak(canonical) ||
    containsCanonicalRegisteredSecret(canonical, registry.canonicalValues);
  return canonicalLeak
    ? { text: TRACE_REDACTION_MARKER, redacted: true }
    : { text: redacted, redacted: redacted !== value };
}

export function canonicalizeTraceText(value: string): string {
  let canonical = value.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  for (let round = 0; round < 8 && /%[0-9a-f]{2}/iu.test(canonical); round += 1) {
    const decoded = decodePercentRuns(canonical);
    if (decoded === canonical) break;
    canonical = decoded.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  }
  return canonical;
}

function redactRecognizedTraceSecrets(value: string): string {
  return value
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
    .replace(
      /((?<!")\b(?:Authorization|Cookie)\b\s*[:=：]\s*)[^\r\n,}，]*/giu,
      '$1[REDACTED]'
    )
    .replace(
      /((?<!")\b(?:apiKey|ANTHROPIC_AUTH_TOKEN)\b\s*[:=：]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\r\n,;}；，]+)/giu,
      '$1[REDACTED]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]');
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

function containsCanonicalRegisteredSecret(
  value: string,
  canonicalValues: readonly string[]
): boolean {
  const withoutMarkers = value.replaceAll(TRACE_REDACTION_MARKER, '');
  return canonicalValues.some((secret) => {
    if (/^[0-9]+$/u.test(secret)) {
      return new RegExp(
        `(?<!\\p{Decimal_Number})${escapeRegExp(secret)}(?!\\p{Decimal_Number})`,
        'iu'
      ).test(withoutMarkers);
    }
    return withoutMarkers.toLowerCase().includes(secret.toLowerCase());
  });
}

function isExactRedactionMarker(value: string): boolean {
  let normalized = value.trim();
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized === TRACE_REDACTION_MARKER;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
