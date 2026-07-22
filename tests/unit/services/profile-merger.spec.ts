import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../../src/shared/domain.js';
import { mergeProfile } from '../../../src/main/services/profile-merger.js';
import type { MiyousheCharacterDetail } from '../../../src/main/services/miyoushe-game-record.js';

const FETCHED_AT = '2026-01-01T00:00:00.000Z';

function enkaChar(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    id: 10000046,
    name: 'Hu Tao',
    element: 'Pyro',
    rarity: 5,
    imageUrl: 'UI_AvatarIcon_Hutao.png',
    level: 90,
    build: {
      stats: {
        hp: 35000,
        atk: 2200,
        def: 800,
        critRate: 75,
        critDmg: 230,
        energyRecharge: 120,
        elementalMastery: 120
      }
    },
    completeness: 'build',
    missingFields: ['weapon', 'artifacts', 'talents'],
    provenance: {
      ownership: { source: 'enka', fetchedAt: FETCHED_AT },
      stats: { source: 'enka', fetchedAt: FETCHED_AT }
    },
    ...overrides
  };
}

function miyousheChar(
  overrides: Partial<MiyousheCharacterDetail> = {}
): MiyousheCharacterDetail {
  return {
    id: 10000046,
    name: 'Hu Tao',
    element: 'Pyro',
    level: 90,
    rarity: 5,
    iconUrl: 'miyoushe-icon-hutao.png',
    constellation: 1,
    friendship: 10,
    weapon: {
      id: 13501,
      name: 'Staff of Homa',
      iconUrl: 'icon-homa.png',
      level: 90,
      refinement: 1,
      rarity: 5
    },
    artifacts: [
      {
        slot: 'flower',
        setId: 15009,
        setName: 'Crimson Witch of Flames',
        level: 20,
        rarity: 5,
        mainStat: { key: 'baseHp', value: 4780 },
        subStats: []
      }
    ],
    talents: { normalAttack: 9, elementalSkill: 10, elementalBurst: 10 },
    ...overrides
  };
}

function cachedCharacter(id: number, hp: number): CharacterProfile {
  return enkaChar({
    id,
    name: `Cached-${id}`,
    build: { stats: { hp } },
    source: 'miyoushe',
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt: FETCHED_AT },
      stats: { source: 'miyoushe-detail', fetchedAt: FETCHED_AT }
    }
  });
}

describe('mergeProfile', () => {
  it('merges field-by-field with explicit provenance and detailed completeness', () => {
    const { characters, source, coverage } = mergeProfile({
      enkaCharacters: [enkaChar()],
      miyousheCharacters: [miyousheChar()],
      fetchedAt: FETCHED_AT
    });
    expect(source).toBe('merged');
    const character = characters[0]!;
    expect(character.source).toBe('merged');
    expect(character.build?.stats?.hp).toBe(35000);
    expect(character.constellation).toBe(1);
    expect(character.friendship).toBe(10);
    expect(character.build?.weapon?.name).toBe('Staff of Homa');
    expect(character.build?.artifacts?.[0]?.setName).toBe('Crimson Witch of Flames');
    expect(character.completeness).toBe('detailed');
    expect(character.missingFields).toEqual([]);
    expect(character.provenance.stats?.source).toBe('enka');
    expect(character.provenance.build?.source).toBe('miyoushe-detail');
    expect(coverage).toMatchObject({ ownedCount: 1, detailedCount: 1, partial: false });
  });

  it('keeps missing stats unknown instead of manufacturing zero values', () => {
    const { characters, source } = mergeProfile({
      enkaCharacters: [],
      miyousheCharacters: [miyousheChar()],
      fetchedAt: FETCHED_AT
    });
    expect(source).toBe('miyoushe');
    const character = characters[0]!;
    expect(character.level).toBe(90);
    expect(character.build?.stats).toBeUndefined();
    expect(character.build?.weapon?.id).toBe(13501);
    expect(character.completeness).toBe('build');
    expect(character.missingFields).toContain('stats');
  });

  it('does not treat secondary-only stats as a complete character panel', () => {
    const { characters, coverage } = mergeProfile({
      enkaCharacters: [],
      miyousheCharacters: [
        miyousheChar({
          stats: {
            critRate: 61.2,
            critDmg: 184,
            energyRecharge: 135,
            elementalMastery: 80
          }
        })
      ],
      fetchedAt: FETCHED_AT
    });

    expect(characters[0]?.completeness).toBe('build');
    expect(characters[0]?.missingFields).toContain('stats');
    expect(coverage).toMatchObject({ statsCount: 0, detailedCount: 0 });
  });

  it('marks Enka-only showcase data as partial ownership', () => {
    const { characters, source, coverage } = mergeProfile({
      enkaCharacters: [enkaChar()],
      miyousheCharacters: undefined
    });
    expect(source).toBe('enka');
    expect(characters).toHaveLength(1);
    expect(coverage).toMatchObject({
      ownedCount: 1,
      enkaShowcaseCount: 1,
      partial: true
    });
    expect(coverage.expectedOwnedCount).toBeUndefined();
  });

  it('keeps Enka characters not present in the miyoushe list', () => {
    const enkaOnly = enkaChar({ id: 99, name: 'Visitor' });
    const { characters } = mergeProfile({
      enkaCharacters: [enkaChar(), enkaOnly],
      miyousheCharacters: [miyousheChar()]
    });
    expect(characters).toHaveLength(2);
    expect(characters.find((character) => character.id === 99)?.source).toBe('enka');
  });

  it('preserves cached MiHoYo ownership when refresh only returns an Enka subset', () => {
    const cachedCharacters = [cachedCharacter(1, 10000), cachedCharacter(2, 20000)];
    const freshEnka = enkaChar({ id: 1, build: { stats: { hp: 35000 } } });

    const result = mergeProfile({
      enkaCharacters: [freshEnka],
      cachedProfile: {
        characters: cachedCharacters,
        coverage: {
          expectedOwnedCount: 2,
          ownedCount: 2,
          detailedCount: 0,
          buildCount: 2,
          statsCount: 2,
          enkaShowcaseCount: 0,
          missingDetailCount: 2,
          partial: false
        }
      }
    });

    expect(result.source).toBe('miyoushe-stale');
    expect(result.characters.map((character) => character.id)).toEqual([1, 2]);
    expect(result.characters[0]?.build?.stats?.hp).toBe(35000);
    expect(result.characters[0]?.provenance.stats).toMatchObject({ source: 'enka' });
    expect(result.characters[1]?.build?.stats?.hp).toBe(20000);
    expect(result.characters[1]?.provenance.stats).toMatchObject({ stale: true });
    expect(result.coverage).toMatchObject({ ownedCount: 2, partial: true });
  });

  it('replaces stale cached ownership when a fresh MiHoYo roster succeeds', () => {
    const result = mergeProfile({
      enkaCharacters: [],
      miyousheCharacters: [miyousheChar({ id: 3, name: 'Fresh-3' })],
      miyousheCoverage: {
        expectedOwnedCount: 1,
        listedCount: 1,
        detailedCount: 1,
        missingCharacterIds: [],
        duplicateCharacterIds: [],
        unexpectedCharacterIds: [],
        failedBatches: [],
        partial: false,
        fields: { weapon: 1, artifacts: 1, talents: 1, stats: 0 }
      },
      cachedProfile: {
        characters: [cachedCharacter(1, 10000), cachedCharacter(2, 20000)],
        coverage: {
          expectedOwnedCount: 2,
          ownedCount: 2,
          detailedCount: 0,
          buildCount: 2,
          statsCount: 2,
          enkaShowcaseCount: 0,
          missingDetailCount: 2,
          partial: true
        }
      }
    });

    expect(result.source).toBe('miyoushe');
    expect(result.characters.map((character) => character.id)).toEqual([3]);
    expect(result.characters[0]?.provenance.ownership).toMatchObject({
      source: 'miyoushe-list'
    });
    expect(result.characters[0]?.provenance.ownership.stale).toBeUndefined();
    expect(result.coverage.partial).toBe(false);
  });

  it('returns miyoushe-stale with empty coverage when both feeds are empty', () => {
    const { source, characters, coverage } = mergeProfile({
      enkaCharacters: [],
      miyousheCharacters: []
    });
    expect(source).toBe('miyoushe-stale');
    expect(characters).toEqual([]);
    expect(coverage.ownedCount).toBe(0);
  });
});
