import type { CharacterProfile, DataCompleteness } from '../../../shared/domain';
import { elements, normalizeElement, type Element } from '../../design/tokens';

export type RosterSortMode = 'default' | 'level-desc' | 'name' | 'element' | 'completeness-desc';

export function sortCharacters(
  characters: readonly CharacterProfile[],
  mode: RosterSortMode,
  locale: string
): CharacterProfile[] {
  if (mode === 'default') return [...characters];

  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const completenessRank: Record<DataCompleteness, number> = {
    basic: 0,
    build: 1,
    detailed: 2
  };
  const compare = (left: CharacterProfile, right: CharacterProfile): number => {
    switch (mode) {
      case 'level-desc':
        return (right.level ?? Number.NEGATIVE_INFINITY) - (left.level ?? Number.NEGATIVE_INFINITY);
      case 'name':
        return collator.compare(left.name, right.name);
      case 'element': {
        const leftElement = normalizeElement(left.element);
        const rightElement = normalizeElement(right.element);
        const leftIndex = leftElement ? elements.indexOf(leftElement) : elements.length;
        const rightIndex = rightElement ? elements.indexOf(rightElement) : elements.length;
        return leftIndex - rightIndex;
      }
      case 'completeness-desc':
        return completenessRank[right.completeness] - completenessRank[left.completeness];
    }
  };

  return characters
    .map((character, index) => ({ character, index }))
    .sort((left, right) => compare(left.character, right.character) || left.index - right.index)
    .map(({ character }) => character);
}

export interface CharacterTilePresentation {
  name: string;
  level: number | '—';
  element: string;
  completeness: DataCompleteness;
}

export function renderTile(character: CharacterProfile): CharacterTilePresentation {
  return {
    name: character.name,
    level: character.level ?? '—',
    element: character.element,
    completeness: character.completeness
  };
}

export function isRenderableCharacterPortrait(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'gtai-img:' && (url.host === 'avatar' || url.host === 'remote');
  } catch {
    return false;
  }
}

export type PresentedEnergyRecharge = { kind: 'known'; value: number } | { kind: 'unknown' };

export function presentEnergyRecharge(value: number | undefined): PresentedEnergyRecharge {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { kind: 'known', value }
    : { kind: 'unknown' };
}

export type ReactionTag =
  | 'vaporize'
  | 'melt'
  | 'overloaded'
  | 'burning'
  | 'freeze'
  | 'electroCharged'
  | 'bloom'
  | 'superconduct'
  | 'quicken'
  | 'swirl'
  | 'crystallize';

const reactionsByElement: Record<Element, ReactionTag[]> = {
  pyro: ['vaporize', 'melt', 'overloaded', 'burning'],
  hydro: ['vaporize', 'freeze', 'electroCharged', 'bloom'],
  electro: ['overloaded', 'electroCharged', 'superconduct', 'quicken'],
  anemo: ['swirl'],
  geo: ['crystallize'],
  cryo: ['melt', 'freeze', 'superconduct'],
  dendro: ['bloom', 'quicken', 'burning']
};

export function reactionTagsForElement(element: Element | undefined): ReactionTag[] {
  return element ? reactionsByElement[element] : [];
}

export type ArtifactStatKey =
  | 'hp'
  | 'hpPercent'
  | 'atk'
  | 'atkPercent'
  | 'def'
  | 'defPercent'
  | 'critRate'
  | 'critDmg'
  | 'energyRecharge'
  | 'elementalMastery'
  | 'healingBonus'
  | 'physicalDmg'
  | 'pyroDmg'
  | 'hydroDmg'
  | 'electroDmg'
  | 'anemoDmg'
  | 'geoDmg'
  | 'cryoDmg'
  | 'dendroDmg';

export type PresentedArtifactStatKey =
  | { kind: 'known'; key: ArtifactStatKey }
  | { kind: 'raw'; label: string }
  | { kind: 'unavailable' };

const artifactStatAliases: Record<string, ArtifactStatKey> = {
  HP: 'hp',
  BASEHP: 'hp',
  FIGHT_PROP_HP: 'hp',
  HPPCT: 'hpPercent',
  HPPERCENT: 'hpPercent',
  FIGHT_PROP_HP_PERCENT: 'hpPercent',
  ATK: 'atk',
  BASEATK: 'atk',
  FIGHT_PROP_ATTACK: 'atk',
  ATKPCT: 'atkPercent',
  ATKPERCENT: 'atkPercent',
  FIGHT_PROP_ATTACK_PERCENT: 'atkPercent',
  DEF: 'def',
  BASEDEF: 'def',
  FIGHT_PROP_DEFENSE: 'def',
  DEFPCT: 'defPercent',
  DEFPERCENT: 'defPercent',
  FIGHT_PROP_DEFENSE_PERCENT: 'defPercent',
  CRITRATE: 'critRate',
  CRIT_RATE: 'critRate',
  FIGHT_PROP_CRITICAL: 'critRate',
  CRITDMG: 'critDmg',
  CRIT_DMG: 'critDmg',
  FIGHT_PROP_CRITICAL_HURT: 'critDmg',
  ENERGYRECHARGE: 'energyRecharge',
  ENERGY_RECHARGE: 'energyRecharge',
  FIGHT_PROP_CHARGE_EFFICIENCY: 'energyRecharge',
  ELEMENTALMASTERY: 'elementalMastery',
  ELEMENTAL_MASTERY: 'elementalMastery',
  FIGHT_PROP_ELEMENT_MASTERY: 'elementalMastery',
  HEALINGBONUS: 'healingBonus',
  HEALING_BONUS: 'healingBonus',
  FIGHT_PROP_HEAL_ADD: 'healingBonus',
  PHYSDMG: 'physicalDmg',
  PHYSICALDMG: 'physicalDmg',
  FIGHT_PROP_PHYSICAL_ADD_HURT: 'physicalDmg',
  PYRODMG: 'pyroDmg',
  FIGHT_PROP_FIRE_ADD_HURT: 'pyroDmg',
  HYDRODMG: 'hydroDmg',
  FIGHT_PROP_WATER_ADD_HURT: 'hydroDmg',
  ELECTRODMG: 'electroDmg',
  FIGHT_PROP_ELEC_ADD_HURT: 'electroDmg',
  ANEMODMG: 'anemoDmg',
  FIGHT_PROP_WIND_ADD_HURT: 'anemoDmg',
  GEODMG: 'geoDmg',
  FIGHT_PROP_ROCK_ADD_HURT: 'geoDmg',
  CRYODMG: 'cryoDmg',
  FIGHT_PROP_ICE_ADD_HURT: 'cryoDmg',
  DENDRODMG: 'dendroDmg',
  FIGHT_PROP_GRASS_ADD_HURT: 'dendroDmg'
};

const percentArtifactStats = new Set<ArtifactStatKey>([
  'hpPercent',
  'atkPercent',
  'defPercent',
  'critRate',
  'critDmg',
  'energyRecharge',
  'healingBonus',
  'physicalDmg',
  'pyroDmg',
  'hydroDmg',
  'electroDmg',
  'anemoDmg',
  'geoDmg',
  'cryoDmg',
  'dendroDmg'
]);

export function presentArtifactStatKey(raw: string): PresentedArtifactStatKey {
  const compact = raw
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
  const known = artifactStatAliases[compact];
  if (known) return { kind: 'known', key: known };
  const label = [...raw]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 || character === '<' || character === '>'
        ? ' '
        : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return label ? { kind: 'raw', label } : { kind: 'unavailable' };
}

export function artifactStatUsesPercent(key: PresentedArtifactStatKey): boolean {
  return key.kind === 'known' && percentArtifactStats.has(key.key);
}
