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

  it('falls back to Enka-only when miyoushe is unavailable', () => {
    const { characters, source } = mergeProfile({
      enkaCharacters: [enkaChar()],
      miyousheCharacters: undefined
    });
    expect(source).toBe('enka');
    expect(characters[0]?.source).toBe('enka');
    expect(characters[0]?.build?.weapon).toBeUndefined();
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
