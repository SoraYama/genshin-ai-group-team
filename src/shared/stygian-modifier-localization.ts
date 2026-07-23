export const UNKNOWN_STYGIAN_MODIFIER_LABEL = '挑战修正暂无中文说明' as const;

const KNOWN_MODIFIER_LABELS: Readonly<Record<string, string>> = {
  'time-window': '限时窗口更紧。',
  'energy-pressure': '能量回复压力上升。',
  'phase-energy': '本阶段能量压力显著。',
  'boss-energy': '首领要求快速充能循环。'
};

export interface StygianModifierText {
  id?: string;
  description: string;
}

export function localizeStygianModifier(modifier: StygianModifierText | string): string {
  const value = typeof modifier === 'string' ? { description: modifier } : modifier;
  const known = value.id ? KNOWN_MODIFIER_LABELS[value.id.trim().toLowerCase()] : undefined;
  if (known) return known;
  const description = value.description.trim();
  if (!isNaturalChineseModifier(description)) return UNKNOWN_STYGIAN_MODIFIER_LABEL;
  return description;
}

function isNaturalChineseModifier(value: string): boolean {
  if (!/[\u3400-\u9fff]/u.test(value)) return false;
  if (/(?:mcp__|query_|scenarioId|dataVersion|difficultyId|characterIds)/iu.test(value)) {
    return false;
  }
  return !/[A-Za-z]{2,}|\b[a-z0-9]+(?:[-_.][a-z0-9]+)+\b/iu.test(value);
}
