const SENSITIVE_RESEARCH_TEXT =
  /(?:\buid\b|\p{Decimal_Number}{9,}|昵称|cookie|authorization|api[-_ ]?key|bearer\s|ltoken|ltuid|ltmid|sk-[a-z0-9_-]+|crit(?:ical)?[-_ ]?(?:rate|dmg)|暴击(?:率|伤害)?|攻击力|生命值|防御力)/iu;

export function privacySafeResearchText(value: string): string | undefined {
  let normalized = normalizeResearchText(value);
  for (let round = 0; round < 8 && /%[0-9a-f]{2}/iu.test(normalized); round += 1) {
    try {
      normalized = normalizeResearchText(decodeURIComponent(normalized));
    } catch {
      return undefined;
    }
  }
  if (
    /%[0-9a-f]{2}/iu.test(normalized) ||
    hasAsciiControl(normalized) ||
    SENSITIVE_RESEARCH_TEXT.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function normalizeResearchText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .trim();
}
