const RESEARCH_PRIVACY_TEXT_MAX_LENGTH = 16_384;
const RESEARCH_PRIVACY_DECODE_MAX_ROUNDS = 8;
const ENCODED_OCTET_PATTERN = /%[0-9a-f]{2}/iu;
const LONG_IDENTITY_NUMBER_PATTERN = /\p{Decimal_Number}{9,}/u;
const PUBLIC_ARTICLE_NUMBER_CONTEXT =
  /(?:公开\s*)?(?:攻略|文章)|(?:^|[^\p{L}\p{N}_])(?:guide|article|articles|post|posts)(?:[^\p{L}\p{N}_]|$)/iu;

const SENSITIVE_CANONICAL_PATTERNS = [
  /private[-_ ]nickname/iu,
  /(?:玩家|用户)\s*uid/iu,
  /(?:^|[^\p{L}\p{N}_])uid(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])nickname(?:[^\p{L}\p{N}_]|$)/iu,
  /昵称|玩家名/iu,
  /(?:^|[^\p{L}\p{N}_])cookie(?:[^\p{L}\p{N}_]|$)|ltoken(?:_v\d+)?|ltuid(?:_v\d+)?|ltmid(?:_v\d+)?/iu,
  /(?:^|[^\p{L}\p{N}_])authorization(?:[^\p{L}\p{N}_]|$)|(?:^|[^\p{L}\p{N}_])bearer(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])api[-_ ]?key(?:[^\p{L}\p{N}_]|$)|(?:^|[^\p{L}\p{N}_])token(?:[^\p{L}\p{N}_]|$)|(?:^|[^\p{L}\p{N}_])sk-[a-z0-9_-]+/iu,
  /(?:^|[^\p{L}\p{N}_])credentials?(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])prompt(?:[^\p{L}\p{N}_]|$)|system[-_ ]prompt/iu,
  /(?:sdk[-_ ]+)?raw[-_ ]+(?:sdk[-_ ]+)?message|原始消息/iu,
  /tool[-_ ]+(?:call[-_ ]+)?payload|tool[-_ ]+载荷|工具载荷/iu,
  /(?:tool_use|function_call|tool_result|arguments|input)\s*[:=：]/iu,
  /full[-_ ]?stats|full[-_ ]?panel|完整面板|完整属性/iu,
  /(?:账号|账户|account|player|profile)\s*[:=：#-]?\s*\p{Decimal_Number}{9,}/iu
] as const;

export function privacySafeResearchText(value: string): string | undefined {
  const canonical = canonicalizeResearchPrivacyText(value);
  return canonical === undefined ||
    hasAsciiControl(canonical) ||
    hasUnlabeledIdentityNumber(canonical) ||
    isSensitiveResearchCanonicalText(canonical)
    ? undefined
    : canonical;
}

export function canonicalizeResearchPrivacyText(value: string): string | undefined {
  if (value.length > RESEARCH_PRIVACY_TEXT_MAX_LENGTH) return undefined;
  let decoded = normalizeResearchUnicode(value);
  for (let attempt = 0; attempt < RESEARCH_PRIVACY_DECODE_MAX_ROUNDS; attempt += 1) {
    if (!ENCODED_OCTET_PATTERN.test(decoded)) {
      return decoded.trim();
    }
    try {
      const next = normalizeResearchUnicode(decodeURIComponent(decoded));
      if (next === decoded) return decoded.trim();
      decoded = next;
    } catch {
      return undefined;
    }
  }
  return ENCODED_OCTET_PATTERN.test(decoded) ? undefined : decoded.trim();
}

export function isSensitiveResearchFreeText(value: string): boolean {
  const canonical = canonicalizeResearchPrivacyText(value);
  return canonical === undefined || isSensitiveResearchCanonicalText(canonical);
}

export function isSensitiveResearchCanonicalText(value: string): boolean {
  if (SENSITIVE_CANONICAL_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return hasFullPanelStatShape(value);
}

function hasUnlabeledIdentityNumber(value: string): boolean {
  return LONG_IDENTITY_NUMBER_PATTERN.test(value) && !PUBLIC_ARTICLE_NUMBER_CONTEXT.test(value);
}

function hasFullPanelStatShape(value: string): boolean {
  const labels = new Set<string>();
  const statPattern =
    /(?:^|[^\p{L}\p{N}_])(?<label>hp|atk|def|crit(?:ical)?[\s_-]*rate|crit(?:ical)?[\s_-]*(?:dmg|damage)|er|em|生命(?:值)?|攻击(?:力)?|防御(?:力)?|暴击率|暴击伤害|元素充能效率|元素精通)\s*[:：=]\s*[+-]?\d+(?:\.\d+)?%?/giu;
  for (const match of value.matchAll(statPattern)) {
    const label = match.groups?.label;
    if (label !== undefined) labels.add(canonicalStatLabel(label));
  }
  return labels.size >= 3;
}

function canonicalStatLabel(label: string): string {
  const normalized = label.toLocaleLowerCase('en').replace(/[\s_-]/gu, '');
  if (/^(?:生命|生命值)$/u.test(normalized)) return 'hp';
  if (/^(?:攻击|攻击力)$/u.test(normalized)) return 'atk';
  if (/^(?:防御|防御力)$/u.test(normalized)) return 'def';
  if (normalized === '暴击率') return 'critrate';
  if (normalized === '暴击伤害') return 'critdmg';
  if (normalized === '元素充能效率') return 'er';
  if (normalized === '元素精通') return 'em';
  return normalized.replace(/^critical/u, 'crit').replace(/damage$/u, 'dmg');
}

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function normalizeResearchUnicode(value: string): string {
  return value.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
}
