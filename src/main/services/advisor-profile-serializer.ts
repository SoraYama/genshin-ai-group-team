import type {
  ArtifactPiece,
  CharacterStats,
  CharacterProfile,
  FieldSource,
  PersistedProfile
} from '../../shared/domain.js';
import {
  MAX_AGENT_PAYLOAD_BYTES,
  assertAgentPayloadSize
} from './agent-payload-budget.js';

export const MAX_ADVISOR_PROFILE_BYTES = MAX_AGENT_PAYLOAD_BYTES;
export const MAX_ADVISOR_PROFILE_CHARACTERS = 100;

interface AdvisorArtifactSummary {
  sets: Array<{ name: string; count: number }>;
  mainStats: Partial<Record<'sands' | 'goblet' | 'circlet', string>>;
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
      mainStats[artifact.slot] = artifact.mainStat.key;
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
