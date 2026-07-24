export const CANONICAL_SCENARIO_MECHANIC_TAGS = [
  'elemental-shield',
  'elemental-armor',
  'shield-absent',
  'high-resistance',
  'elemental-immunity',
  'multi-wave',
  'single-wave-only',
  'groupable',
  'multi-target',
  'ungroupable',
  'heavy-target',
  'single-target',
  'boss',
  'dense-multi-target',
  'survival-pressure',
  'interrupt-pressure',
  'high-incoming-damage',
  'mobile-enemy',
  'burrow',
  'short-damage-window',
  'stationary-target',
  'elemental-aura',
  'reaction-restricted',
  'freeze-immune'
] as const;

const canonicalTags = new Set<string>(CANONICAL_SCENARIO_MECHANIC_TAGS);
const aliases: Readonly<Record<string, string>> = {
  shield: 'elemental-shield',
  resistance: 'high-resistance',
  immunity: 'elemental-immunity',
  waves: 'multi-wave',
  grouping: 'groupable',
  boss: 'single-target',
  sustain: 'survival-pressure',
  mobile: 'mobile-enemy',
  'short-window': 'short-damage-window',
  'reaction-limit': 'reaction-restricted'
};

export interface ScenarioMechanicTarget {
  tags: readonly string[];
  shields: ReadonlyArray<unknown>;
  resistances: ReadonlyArray<{ percent: number }>;
  immunities: readonly string[];
  waveCount?: number;
  enemyCount?: number;
}

export function normalizeScenarioMechanicTag(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  return aliases[normalized] ?? normalized;
}

export function scenarioMechanicTagsForTarget(target: ScenarioMechanicTarget): string[] {
  const tags = new Set(target.tags.map(normalizeScenarioMechanicTag));
  if (target.shields.length > 0) tags.add('elemental-shield');
  if (target.resistances.some(({ percent }) => percent >= 40)) tags.add('high-resistance');
  if (target.immunities.length > 0) {
    tags.add('elemental-immunity');
    tags.add('reaction-restricted');
  }
  if ((target.waveCount ?? 1) > 1) tags.add('multi-wave');
  if (target.enemyCount === 1) tags.add('single-target');
  return Array.from(tags);
}

export function safeScenarioMechanicTags(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map(normalizeScenarioMechanicTag)
        .filter((tag) => canonicalTags.has(tag))
    )
  ).sort();
}
