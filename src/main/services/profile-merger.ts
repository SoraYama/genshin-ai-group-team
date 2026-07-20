import type {
  BuildField,
  CharacterBuildSnapshot,
  CharacterProfile,
  DataCompleteness,
  FieldProvenance,
  FieldSource,
  ProfileCoverage,
  ProfileSource
} from '../../shared/domain.js';
import type {
  MiyousheCharacterDetail,
  MiyousheRosterCoverage
} from './miyoushe-game-record.js';

export interface ProfileMergeInput {
  enkaCharacters: CharacterProfile[];
  miyousheCharacters?: MiyousheCharacterDetail[];
  miyousheCoverage?: MiyousheRosterCoverage;
  cachedProfile?: CachedProfileFallback;
  ownershipSource?: Extract<FieldSource, 'miyoushe-index' | 'miyoushe-list'>;
  fetchedAt?: string;
}

export interface CachedProfileFallback {
  characters: CharacterProfile[];
  coverage: ProfileCoverage;
}

export interface ProfileMergeOutput {
  characters: CharacterProfile[];
  source: ProfileSource;
  coverage: ProfileCoverage;
}

export function describeBuild(build: CharacterBuildSnapshot | undefined): {
  completeness: DataCompleteness;
  missingFields: BuildField[];
} {
  const missingFields: BuildField[] = [];
  if (!build?.stats || Object.keys(build.stats).length === 0) missingFields.push('stats');
  if (!build?.weapon) missingFields.push('weapon');
  if (!build?.artifacts || build.artifacts.length === 0) missingFields.push('artifacts');
  if (!build?.talents) missingFields.push('talents');
  return {
    completeness:
      missingFields.length === 0
        ? 'detailed'
        : missingFields.length === 4
          ? 'basic'
          : 'build',
    missingFields
  };
}

export function mergeProfile(input: ProfileMergeInput): ProfileMergeOutput {
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const enkaById = new Map(input.enkaCharacters.map((character) => [character.id, character]));
  const miyousheList = input.miyousheCharacters ?? [];
  const merged: CharacterProfile[] = [];
  const seen = new Set<number>();
  const cachedProfile = hasAuthoritativeCachedRoster(input.cachedProfile)
    ? input.cachedProfile
    : undefined;
  let source: ProfileSource;

  if (miyousheList.length > 0) {
    for (const miyoushe of miyousheList) {
      merged.push(
        buildFromMiyoushe(
          miyoushe,
          enkaById.get(miyoushe.id),
          fetchedAt,
          input.ownershipSource ?? 'miyoushe-list'
        )
      );
      seen.add(miyoushe.id);
    }
    for (const enka of input.enkaCharacters) {
      if (seen.has(enka.id)) continue;
      merged.push({ ...enka, source: 'enka' });
    }
    source = input.enkaCharacters.length > 0 ? 'merged' : 'miyoushe';
  } else if (cachedProfile) {
    for (const cached of cachedProfile.characters) {
      merged.push(mergeCachedCharacter(cached, enkaById.get(cached.id)));
      seen.add(cached.id);
    }
    for (const enka of input.enkaCharacters) {
      if (seen.has(enka.id)) continue;
      merged.push({ ...enka, source: 'enka' });
    }
    source = 'miyoushe-stale';
  } else {
    merged.push(...input.enkaCharacters.map((enka) => ({ ...enka, source: 'enka' as const })));
    source = merged.length > 0 ? 'enka' : 'miyoushe-stale';
  }

  const detailedCount = merged.filter((character) => character.completeness === 'detailed').length;
  const buildCount = merged.filter((character) => character.completeness !== 'basic').length;
  const statsCount = merged.filter(
    (character) => character.build?.stats && Object.keys(character.build.stats).length > 0
  ).length;
  const expectedOwnedCount =
    input.miyousheCoverage?.expectedOwnedCount ?? cachedProfile?.coverage.expectedOwnedCount;
  const ownedCount = miyousheList.length > 0 ? miyousheList.length : merged.length;
  const missingDetailCount = input.miyousheCoverage
    ? input.miyousheCoverage.missingCharacterIds.length
    : merged.filter((character) => character.completeness !== 'detailed').length;
  const coverage: ProfileCoverage = {
    expectedOwnedCount,
    ownedCount,
    detailedCount,
    buildCount,
    statsCount,
    enkaShowcaseCount: input.enkaCharacters.length,
    missingDetailCount,
    partial:
      source === 'enka' ||
      source === 'miyoushe-stale' ||
      input.miyousheCoverage?.partial === true ||
      ((expectedOwnedCount !== undefined && expectedOwnedCount !== ownedCount) ||
        missingDetailCount > 0)
  };
  return { characters: merged, source, coverage };
}

function hasAuthoritativeCachedRoster(
  cachedProfile: CachedProfileFallback | undefined
): cachedProfile is CachedProfileFallback {
  return Boolean(
    cachedProfile?.characters.some(
      (character) =>
        character.provenance.ownership.source === 'miyoushe-list' ||
        character.provenance.ownership.source === 'miyoushe-index'
    )
  );
}

function stale(provenanceValue: FieldProvenance | undefined): FieldProvenance | undefined {
  return provenanceValue ? { ...provenanceValue, stale: true } : undefined;
}

function mergeCachedCharacter(
  cached: CharacterProfile,
  freshEnka: CharacterProfile | undefined
): CharacterProfile {
  const stats = freshEnka?.build?.stats ?? cached.build?.stats;
  const weapon = freshEnka?.build?.weapon ?? cached.build?.weapon;
  const artifacts = freshEnka?.build?.artifacts?.length
    ? freshEnka.build.artifacts
    : cached.build?.artifacts;
  const talents = freshEnka?.build?.talents ?? cached.build?.talents;
  const build = compactBuild({ stats, weapon, artifacts, talents });
  const shape = describeBuild(build);
  const reusedCachedBuild = Boolean(
    (!freshEnka?.build?.weapon && cached.build?.weapon) ||
      (!freshEnka?.build?.artifacts?.length && cached.build?.artifacts?.length) ||
      (!freshEnka?.build?.talents && cached.build?.talents)
  );
  const buildProvenance = freshEnka?.provenance.build
    ? { ...freshEnka.provenance.build, ...(reusedCachedBuild ? { stale: true } : {}) }
    : stale(cached.provenance.build);

  return {
    ...cached,
    name: freshEnka?.name ?? cached.name,
    element: freshEnka?.element ?? cached.element,
    rarity: freshEnka?.rarity ?? cached.rarity,
    imageUrl: freshEnka?.imageUrl || cached.imageUrl,
    level: freshEnka?.level ?? cached.level,
    constellation: freshEnka?.constellation ?? cached.constellation,
    build,
    source: freshEnka ? 'merged' : cached.source,
    ...shape,
    provenance: {
      ownership: stale(cached.provenance.ownership)!,
      build: buildProvenance,
      stats: freshEnka?.provenance.stats ?? stale(cached.provenance.stats)
    }
  };
}

function buildFromMiyoushe(
  miyoushe: MiyousheCharacterDetail,
  enka: CharacterProfile | undefined,
  fetchedAt: string,
  ownershipSource: Extract<FieldSource, 'miyoushe-index' | 'miyoushe-list'>
): CharacterProfile {
  const stats = enka?.build?.stats ?? miyoushe.stats;
  const weapon = miyoushe.weapon ?? enka?.build?.weapon;
  const artifacts =
    miyoushe.artifacts.length > 0 ? miyoushe.artifacts : enka?.build?.artifacts;
  const talents = miyoushe.talents ?? enka?.build?.talents;
  const build = compactBuild({ stats, weapon, artifacts, talents });
  const shape = describeBuild(build);
  const miyousheProvenance = provenance('miyoushe-detail', fetchedAt);
  const enkaBuildProvenance = enka?.provenance.build;
  return {
    id: miyoushe.id,
    name: enka?.name ?? miyoushe.name,
    element: enka?.element ?? miyoushe.element,
    rarity: enka?.rarity ?? miyoushe.rarity,
    imageUrl:
      enka?.imageUrl && enka.imageUrl.length > 0 ? enka.imageUrl : miyoushe.iconUrl,
    level: miyoushe.level || enka?.level,
    build,
    constellation: miyoushe.constellation,
    friendship: miyoushe.friendship,
    source: enka ? 'merged' : 'miyoushe',
    ...shape,
    provenance: {
      ownership: provenance(ownershipSource, fetchedAt),
      build:
        weapon || artifacts || talents
          ? miyousheProvenance
          : enkaBuildProvenance,
      stats: enka?.build?.stats ? enka.provenance.stats : stats ? miyousheProvenance : undefined
    }
  };
}

function compactBuild(build: CharacterBuildSnapshot): CharacterBuildSnapshot | undefined {
  return build.stats || build.weapon || build.artifacts || build.talents ? build : undefined;
}

function provenance(source: FieldSource, fetchedAt: string): FieldProvenance {
  return { source, fetchedAt };
}
