import type {
  ArtifactPiece,
  CharacterStats,
  CharacterProfile,
  PersistedProfile
} from '../../shared/domain.js';

export const MAX_ADVISOR_PROFILE_BYTES = 48 * 1024;

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
    rarity: number;
  };
  artifactSummary?: AdvisorArtifactSummary;
  stats?: CharacterStats;
  completeness: CharacterProfile['completeness'];
  missingFields?: CharacterProfile['missingFields'];
}

function summarizeArtifacts(artifacts: ArtifactPiece[] | undefined): AdvisorArtifactSummary | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  const setCounts = new Map<string, number>();
  const mainStats: AdvisorArtifactSummary['mainStats'] = {};
  for (const artifact of artifacts) {
    const setName = artifact.setName || `set-${artifact.setId}`;
    setCounts.set(setName, (setCounts.get(setName) ?? 0) + 1);
    if (
      artifact.slot === 'sands' ||
      artifact.slot === 'goblet' ||
      artifact.slot === 'circlet'
    ) {
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
          refinement: build.weapon.refinement,
          rarity: build.weapon.rarity
        }
      : undefined,
    artifactSummary: summarizeArtifacts(build?.artifacts),
    stats: build?.stats,
    completeness: character.completeness,
    missingFields: character.missingFields.length > 0 ? character.missingFields : undefined
  };
}

export function serializeAdvisorProfile(
  profile: PersistedProfile,
  input: { enemyNames: string[]; preference?: string }
): string {
  const serialized = JSON.stringify({
    profile: {
      coverage: profile.coverage,
      characters: profile.characters.map(toAdvisorCharacter)
    },
    enemies: input.enemyNames,
    preference: input.preference ?? ''
  });
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > MAX_ADVISOR_PROFILE_BYTES) {
    throw new Error(`Advisor profile exceeds ${MAX_ADVISOR_PROFILE_BYTES} bytes: ${size}`);
  }
  return serialized;
}
