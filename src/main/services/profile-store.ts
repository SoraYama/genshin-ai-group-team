import { copyFileSync, existsSync } from 'node:fs';
import Store from 'electron-store';
import { z } from 'zod';
import type {
  CharacterProfile,
  CharacterStats,
  PersistedProfile,
  ProfileCoverage,
  ProfileCredentialSource,
  ProfileListItem,
  ProfileSource,
  ProfileStateView
} from '../../shared/domain.js';
import { rewriteIconToProxyUrl } from './icon-proxy.js';
import { describeBuild } from './profile-merger.js';

interface ProfileStoreSchema {
  schemaVersion: 2;
  activeUid?: string;
  profilesByUid: Record<string, PersistedProfile>;
}

const DEFAULTS: ProfileStoreSchema = {
  schemaVersion: 2,
  profilesByUid: {}
};

const statPairSchema = z.object({ key: z.string(), value: z.number() });
const weaponSchema = z.object({
  id: z.number(),
  name: z.string(),
  iconUrl: z.string(),
  level: z.number(),
  refinement: z.number().optional(),
  rarity: z.number(),
  mainStat: statPairSchema.optional(),
  subStat: statPairSchema.optional()
});
const artifactSchema = z.object({
  slot: z.enum(['flower', 'plume', 'sands', 'goblet', 'circlet']),
  setId: z.number(),
  setName: z.string(),
  level: z.number(),
  rarity: z.number(),
  mainStat: statPairSchema,
  subStats: z.array(statPairSchema),
  iconUrl: z.string().optional()
});
const talentsSchema = z.object({
  normalAttack: z.number(),
  elementalSkill: z.number(),
  elementalBurst: z.number()
});
const legacyStatsSchema = z.object({
  level: z.number().optional(),
  hp: z.number().optional(),
  atk: z.number().optional(),
  def: z.number().optional(),
  critRate: z.number().optional(),
  critDmg: z.number().optional(),
  energyRecharge: z.number().optional(),
  elementalMastery: z.number().optional()
});
const legacyCharacterSchema = z.object({
  id: z.number(),
  name: z.string(),
  element: z.string(),
  rarity: z.number(),
  imageUrl: z.string(),
  stats: legacyStatsSchema.optional(),
  weapon: weaponSchema.optional(),
  artifacts: z.array(artifactSchema).optional(),
  constellation: z.number().optional(),
  talents: talentsSchema.optional(),
  friendship: z.number().optional(),
  source: z.enum(['enka', 'miyoushe', 'merged']).optional()
});
const legacyProfileSchema = z.object({
  uid: z.string(),
  region: z.string().optional(),
  nickname: z.string().optional(),
  level: z.number().optional(),
  source: z.enum(['miyoushe', 'miyoushe+enka', 'enka', 'merged', 'miyoushe-stale']).optional(),
  fetchedAt: z.string(),
  characters: z.array(legacyCharacterSchema)
});

function toListItem(profile: PersistedProfile): ProfileListItem {
  return {
    uid: profile.uid,
    nickname: profile.nickname,
    level: profile.level,
    source: profile.source,
    fetchedAt: profile.fetchedAt,
    characterCount: profile.characters.length,
    coverage: profile.coverage
  };
}

function isV2Profile(value: unknown): value is PersistedProfile {
  if (typeof value !== 'object' || value === null) return false;
  return 'schemaVersion' in value && value.schemaVersion === 2 && 'coverage' in value;
}

function knownStats(
  stats: z.infer<typeof legacyStatsSchema> | undefined
): CharacterStats | undefined {
  if (!stats) return undefined;
  const result: CharacterStats = {};
  const keys: Array<keyof CharacterStats> = [
    'hp',
    'atk',
    'def',
    'critRate',
    'critDmg',
    'energyRecharge',
    'elementalMastery'
  ];
  for (const key of keys) {
    const value = stats[key];
    // v1 used zero for every missing stat. Dropping zero here is deliberately
    // conservative: migration must never turn unknown into a measured value.
    if (typeof value === 'number' && value > 0) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function coverageFromCharacters(characters: CharacterProfile[]): ProfileCoverage {
  const detailedCount = characters.filter(
    (character) => character.completeness === 'detailed'
  ).length;
  return {
    ownedCount: characters.length,
    detailedCount,
    buildCount: characters.filter((character) => character.completeness !== 'basic').length,
    statsCount: characters.filter((character) => character.build?.stats !== undefined).length,
    enkaShowcaseCount: characters.filter(
      (character) => character.provenance.stats?.source === 'enka'
    ).length,
    missingDetailCount: characters.length - detailedCount,
    partial: detailedCount !== characters.length
  };
}

function migrateLegacyProfile(value: unknown): PersistedProfile {
  const legacy = legacyProfileSchema.parse(value);
  const characters = legacy.characters.map((character): CharacterProfile => {
    const stats = knownStats(character.stats);
    const artifacts =
      character.artifacts && character.artifacts.length > 0 ? character.artifacts : undefined;
    const build =
      stats || character.weapon || artifacts || character.talents
        ? { stats, weapon: character.weapon, artifacts, talents: character.talents }
        : undefined;
    const shape = describeBuild(build);
    const isEnka = character.source === 'enka';
    return {
      id: character.id,
      name: character.name,
      element: character.element,
      rarity: character.rarity,
      imageUrl: rewriteIconToProxyUrl(character.imageUrl),
      level:
        typeof character.stats?.level === 'number' && character.stats.level > 0
          ? character.stats.level
          : undefined,
      build,
      constellation: character.constellation,
      friendship: character.friendship,
      source: character.source,
      ...shape,
      provenance: {
        ownership: {
          source: isEnka ? 'enka' : 'miyoushe-list',
          fetchedAt: legacy.fetchedAt,
          stale: true
        },
        build: build
          ? {
              source: isEnka ? 'enka' : 'miyoushe-detail',
              fetchedAt: legacy.fetchedAt,
              stale: true
            }
          : undefined,
        stats: stats
          ? {
              source: isEnka ? 'enka' : 'miyoushe-detail',
              fetchedAt: legacy.fetchedAt,
              stale: true
            }
          : undefined
      }
    };
  });
  return {
    schemaVersion: 2,
    uid: legacy.uid,
    region: legacy.region,
    nickname: legacy.nickname,
    level: legacy.level,
    source: (legacy.source ?? 'miyoushe-stale') as ProfileSource,
    fetchedAt: legacy.fetchedAt,
    characters,
    coverage: coverageFromCharacters(characters)
  };
}

export class ProfileStore {
  private readonly store: Store<ProfileStoreSchema>;

  constructor() {
    this.store = new Store<ProfileStoreSchema>({ name: 'profiles', defaults: DEFAULTS });
    this.migrateProfiles();
  }

  private migrateProfiles(): void {
    const all = this.store.get('profilesByUid');
    let dirty = false;
    const migrated: Record<string, PersistedProfile> = {};
    try {
      for (const [uid, value] of Object.entries(all)) {
        if (isV2Profile(value)) {
          const characters = value.characters.map((character) => ({
            ...character,
            imageUrl: rewriteIconToProxyUrl(character.imageUrl)
          }));
          const imageChanged = characters.some(
            (character, index) => character.imageUrl !== value.characters[index]?.imageUrl
          );
          const enkaOnly =
            characters.length > 0 &&
            characters.every((character) => character.provenance.ownership.source === 'enka');
          const coverageChanged =
            enkaOnly &&
            (value.source !== 'enka' ||
              !value.coverage.partial ||
              value.coverage.expectedOwnedCount !== undefined);
          const changed = imageChanged || coverageChanged;
          migrated[uid] = changed
            ? {
                ...value,
                source: enkaOnly ? 'enka' : value.source,
                characters,
                coverage: enkaOnly
                  ? {
                      ...value.coverage,
                      expectedOwnedCount: undefined,
                      ownedCount: characters.length,
                      enkaShowcaseCount: characters.length,
                      partial: true
                    }
                  : value.coverage
              }
            : value;
          dirty ||= changed;
        } else {
          migrated[uid] = migrateLegacyProfile(value);
          dirty = true;
        }
      }
    } catch {
      // Leave the source file untouched. The next successful refresh can
      // replace it, while users retain the original bytes for recovery.
      return;
    }

    if (!dirty) return;
    const storePath = this.store.path;
    const backupPath = typeof storePath === 'string' ? `${storePath}.v1.backup` : undefined;
    if (storePath && backupPath && existsSync(storePath) && !existsSync(backupPath)) {
      copyFileSync(storePath, backupPath);
    }
    this.store.set('profilesByUid', migrated);
    this.store.set('schemaVersion', 2);
  }

  upsert(profile: PersistedProfile): void {
    const all = this.getAll();
    all[profile.uid] = profile;
    this.store.set('profilesByUid', all);
    if (!this.store.get('activeUid')) this.store.set('activeUid', profile.uid);
  }

  get(uid: string): PersistedProfile | undefined {
    return this.getAll()[uid];
  }

  setCredentialSource(uid: string, credentialSource: ProfileCredentialSource): boolean {
    const all = this.getAll();
    const profile = all[uid];
    if (!profile) return false;
    if (profile.credentialSource === credentialSource) return true;
    all[uid] = { ...profile, credentialSource };
    this.store.set('profilesByUid', all);
    return true;
  }

  remove(uid: string): boolean {
    const all = this.getAll();
    if (!(uid in all)) return false;
    delete all[uid];
    this.store.set('profilesByUid', all);
    if (this.store.get('activeUid') === uid) {
      const remaining = Object.keys(all);
      if (remaining.length === 0) this.store.delete('activeUid');
      else this.store.set('activeUid', remaining[0]);
    }
    return true;
  }

  setActive(uid: string): void {
    if (!(uid in this.getAll())) throw new Error(`Profile not found: ${uid}`);
    this.store.set('activeUid', uid);
  }

  getActiveUid(): string | undefined {
    return this.store.get('activeUid');
  }

  getStateView(): ProfileStateView {
    const all = this.getAll();
    return {
      activeUid: this.store.get('activeUid'),
      profiles: Object.values(all)
        .map(toListItem)
        .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
    };
  }

  private getAll(): Record<string, PersistedProfile> {
    return { ...this.store.get('profilesByUid') };
  }
}
