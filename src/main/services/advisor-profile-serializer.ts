import type {
  ArtifactPiece,
  CharacterStats,
  CharacterProfile,
  FieldSource,
  PersistedProfile
} from '../../shared/domain.js';
import type { ArtifactMainStatKey } from '../../shared/advisor-knowledge.js';
import { MAX_AGENT_PAYLOAD_BYTES, assertAgentPayloadSize } from './agent-payload-budget.js';

export const MAX_ADVISOR_PROFILE_BYTES = MAX_AGENT_PAYLOAD_BYTES;
export const MAX_ADVISOR_PROFILE_CHARACTERS = 100;

interface AdvisorArtifactSummary {
  sets: Array<{ name: string; count: number }>;
  mainStats: Partial<Record<'sands' | 'goblet' | 'circlet', ArtifactMainStatKey | 'unknown'>>;
}

const artifactMainStatAliases: Readonly<Record<string, ArtifactMainStatKey>> = {
  hpPct: 'hpPct',
  atkPct: 'atkPct',
  defPct: 'defPct',
  elementalMastery: 'elementalMastery',
  energyRecharge: 'energyRecharge',
  critRate: 'critRate',
  critDmg: 'critDmg',
  healingBonus: 'healingBonus',
  pyroDmg: 'pyroDmg',
  hydroDmg: 'hydroDmg',
  electroDmg: 'electroDmg',
  cryoDmg: 'cryoDmg',
  anemoDmg: 'anemoDmg',
  geoDmg: 'geoDmg',
  dendroDmg: 'dendroDmg',
  physicalDmg: 'physicalDmg',
  physDmg: 'physicalDmg',
  FIGHT_PROP_HP_PERCENT: 'hpPct',
  FIGHT_PROP_ATTACK_PERCENT: 'atkPct',
  FIGHT_PROP_DEFENSE_PERCENT: 'defPct',
  FIGHT_PROP_ELEMENT_MASTERY: 'elementalMastery',
  FIGHT_PROP_CHARGE_EFFICIENCY: 'energyRecharge',
  FIGHT_PROP_CRITICAL: 'critRate',
  FIGHT_PROP_CRITICAL_HURT: 'critDmg',
  FIGHT_PROP_HEAL_ADD: 'healingBonus',
  FIGHT_PROP_FIRE_ADD_HURT: 'pyroDmg',
  FIGHT_PROP_WATER_ADD_HURT: 'hydroDmg',
  FIGHT_PROP_ELEC_ADD_HURT: 'electroDmg',
  FIGHT_PROP_ICE_ADD_HURT: 'cryoDmg',
  FIGHT_PROP_WIND_ADD_HURT: 'anemoDmg',
  FIGHT_PROP_ROCK_ADD_HURT: 'geoDmg',
  FIGHT_PROP_GRASS_ADD_HURT: 'dendroDmg',
  FIGHT_PROP_PHYSICAL_ADD_HURT: 'physicalDmg'
};

function normalizeArtifactMainStat(key: string): ArtifactMainStatKey | 'unknown' {
  return artifactMainStatAliases[key] ?? 'unknown';
}

export interface AdvisorCharacterInput {
  id: number;
  name: string;
  element: string;
  rarity: number;
  level?: number;
  constellation?: number;
  talents?: {
    normal?: number;
    skill?: number;
    burst?: number;
  };
  weapon?: {
    name: string;
    level: number;
    refinement?: number;
  };
  artifactSummary?: AdvisorArtifactSummary;
  stats?: CharacterStats;
  completeness: CharacterProfile['completeness'];
  missingFields?: CharacterProfile['missingFields'];
  provenanceSummary: {
    ownership: FieldSource;
    build?: FieldSource;
    stats?: FieldSource;
    staleFields?: Array<'ownership' | 'build' | 'stats'>;
  };
}

export interface AdvisorProfileView {
  coverage: PersistedProfile['coverage'];
  omittedCharacterCount: number;
  provenanceSummaries: Array<
    AdvisorCharacterInput['provenanceSummary'] & { characterIndexes: number[] }
  >;
  characters: Array<Omit<AdvisorCharacterInput, 'provenanceSummary'>>;
}

function summarizeArtifacts(
  artifacts: ArtifactPiece[] | undefined
): AdvisorArtifactSummary | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  const setCounts = new Map<string, number>();
  const mainStats: AdvisorArtifactSummary['mainStats'] = {};
  for (const artifact of artifacts) {
    const setName = artifact.setName || `set-${artifact.setId}`;
    setCounts.set(setName, (setCounts.get(setName) ?? 0) + 1);
    if (artifact.slot === 'sands' || artifact.slot === 'goblet' || artifact.slot === 'circlet') {
      mainStats[artifact.slot] = normalizeArtifactMainStat(artifact.mainStat.key);
    }
  }
  return {
    sets: Array.from(setCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    mainStats
  };
}

export function toAdvisorCharacter(character: CharacterProfile): AdvisorCharacterInput {
  const build = character.build;
  const staleFields = (
    [
      ['ownership', character.provenance.ownership],
      ['build', character.provenance.build],
      ['stats', character.provenance.stats]
    ] as const
  ).flatMap(([field, provenance]) => (provenance?.stale ? [field] : []));
  return {
    id: character.id,
    name: character.name,
    element: character.element,
    rarity: character.rarity,
    level: character.level,
    constellation: character.constellation,
    talents: build?.talents
      ? {
          normal: build.talents.normalAttack,
          skill: build.talents.elementalSkill,
          burst: build.talents.elementalBurst
        }
      : undefined,
    weapon: build?.weapon
      ? {
          name: build.weapon.name,
          level: build.weapon.level,
          refinement: build.weapon.refinement
        }
      : undefined,
    artifactSummary: summarizeArtifacts(build?.artifacts),
    stats: build?.stats,
    completeness: character.completeness,
    missingFields: character.missingFields.length > 0 ? character.missingFields : undefined,
    provenanceSummary: {
      ownership: character.provenance.ownership.source,
      ...(character.provenance.build ? { build: character.provenance.build.source } : {}),
      ...(character.provenance.stats ? { stats: character.provenance.stats.source } : {}),
      ...(staleFields.length > 0 ? { staleFields } : {})
    }
  };
}

export function buildAdvisorProfileView(
  profile: PersistedProfile,
  maxCharacters = MAX_ADVISOR_PROFILE_CHARACTERS
): AdvisorProfileView {
  const limit = Math.min(Math.max(Math.trunc(maxCharacters), 1), MAX_ADVISOR_PROFILE_CHARACTERS);
  const compactCharacters = profile.characters.slice(0, limit).map(toAdvisorCharacter);
  const groupedProvenance = new Map<
    string,
    AdvisorCharacterInput['provenanceSummary'] & { characterIndexes: number[] }
  >();
  const characters = compactCharacters.map(({ provenanceSummary, ...character }, index) => {
    const key = JSON.stringify(provenanceSummary);
    const group = groupedProvenance.get(key);
    if (group) group.characterIndexes.push(index);
    else groupedProvenance.set(key, { ...provenanceSummary, characterIndexes: [index] });
    return character;
  });
  const view = {
    coverage: profile.coverage,
    omittedCharacterCount: Math.max(0, profile.characters.length - characters.length),
    provenanceSummaries: [...groupedProvenance.values()],
    characters
  };
  assertAgentPayloadSize(JSON.stringify(view), 'profile-tool-result', MAX_ADVISOR_PROFILE_BYTES);
  return view;
}

export function serializeAdvisorProfile(
  profile: PersistedProfile,
  input: { enemyNames: string[]; preference?: string }
): string {
  const serialized = JSON.stringify({
    profile: buildAdvisorProfileView(profile),
    enemies: input.enemyNames,
    preference: input.preference ?? ''
  });
  assertAgentPayloadSize(serialized, 'profile-tool-result', MAX_ADVISOR_PROFILE_BYTES);
  return serialized;
}
