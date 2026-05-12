import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../../src/shared/domain.js';
import { mergeProfile } from '../../../src/main/services/profile-merger.js';
import type { MiyousheCharacterDetail } from '../../../src/main/services/miyoushe-game-record.js';

function enkaChar(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    id: 10000046,
    name: 'Hu Tao',
    element: 'Pyro',
    rarity: 5,
    imageUrl: 'UI_AvatarIcon_Hutao.png',
    stats: {
      level: 90,
      hp: 35000,
      atk: 2200,
      def: 800,
      critRate: 75,
      critDmg: 230,
      energyRecharge: 120,
      elementalMastery: 120
    },
    ...overrides
  };
}

function miyousheChar(overrides: Partial<MiyousheCharacterDetail> = {}): MiyousheCharacterDetail {
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
  it('produces source=merged when both feeds carry the character and overlays stats from Enka', () => {
    const { characters, source } = mergeProfile({
      enkaCharacters: [enkaChar()],
      miyousheCharacters: [miyousheChar()]
    });
    expect(source).toBe('merged');
    expect(characters).toHaveLength(1);
    const c = characters[0]!;
    expect(c.source).toBe('merged');
    expect(c.stats.hp).toBe(35000);              // Enka wins
    expect(c.constellation).toBe(1);             // miyoushe wins
    expect(c.friendship).toBe(10);               // miyoushe wins
    expect(c.weapon?.name).toBe('Staff of Homa');
    expect(c.artifacts?.[0]?.setName).toBe('Crimson Witch of Flames');
    expect(c.imageUrl).toBe('UI_AvatarIcon_Hutao.png'); // Enka CDN preferred
  });

  it('emits miyoushe-only character with stats zeroed and source=miyoushe', () => {
    const { characters, source } = mergeProfile({
      enkaCharacters: [],
      miyousheCharacters: [miyousheChar()]
    });
    expect(source).toBe('miyoushe');
    expect(characters).toHaveLength(1);
    const c = characters[0]!;
    expect(c.source).toBe('miyoushe');
    expect(c.stats.level).toBe(90);
    expect(c.stats.hp).toBe(0);                  // No Enka, so 0 placeholder
    expect(c.weapon?.id).toBe(13501);
    expect(c.imageUrl).toBe('miyoushe-icon-hutao.png');
  });

  it('falls back to Enka-only when miyoushe call fails', () => {
    const { characters, source } = mergeProfile({
      enkaCharacters: [enkaChar()],
      miyousheCharacters: undefined
    });
    expect(source).toBe('enka');
    expect(characters[0]?.source).toBe('enka');
    expect(characters[0]?.weapon).toBeUndefined();
  });

  it('keeps Enka characters that are not (yet) in the miyoushe list', () => {
    const enkaOnly = enkaChar({ id: 99, name: 'Visitor' });
    const { characters } = mergeProfile({
      enkaCharacters: [enkaChar(), enkaOnly],
      miyousheCharacters: [miyousheChar()]
    });
    expect(characters).toHaveLength(2);
    const visitor = characters.find((c) => c.id === 99);
    expect(visitor?.source).toBe('enka');
  });

  it('returns miyoushe-stale source when both feeds are empty', () => {
    const { source, characters } = mergeProfile({
      enkaCharacters: [],
      miyousheCharacters: []
    });
    expect(source).toBe('miyoushe-stale');
    expect(characters).toEqual([]);
  });
});
