import { describe, expect, it } from 'vitest';
import type { CharacterProfile, PersistedProfile } from '../../../src/shared/domain.js';
import {
  MAX_ADVISOR_PROFILE_BYTES,
  serializeAdvisorProfile,
  toAdvisorCharacter
} from '../../../src/main/services/advisor-profile-serializer.js';

function character(index: number): CharacterProfile {
  return {
    id: 10000000 + index,
    name: `Character-${index}`,
    element: index % 2 === 0 ? 'Pyro' : 'Hydro',
    rarity: index % 3 === 0 ? 5 : 4,
    imageUrl: `https://private.example.test/avatar-${index}.png`,
    level: 90,
    constellation: index % 7,
    build: {
      stats: {
        hp: 30000 + index,
        atk: 1800 + index,
        def: 800,
        critRate: 70,
        critDmg: 200,
        energyRecharge: 140,
        elementalMastery: 80
      },
      weapon: {
        id: 13000 + index,
        name: `Weapon-${index}`,
        iconUrl: `https://private.example.test/weapon-${index}.png`,
        level: 90,
        refinement: 1,
        rarity: 5,
        mainStat: { key: 'baseAtk', value: 608 }
      },
      artifacts: [
        {
          slot: 'goblet',
          setId: 2,
          setName: 'Beta Set',
          level: 20,
          rarity: 5,
          mainStat: { key: 'pyroDmg', value: 46.6 },
          subStats: [{ key: 'critRate', value: 12.4 }],
          iconUrl: 'https://private.example.test/relic.png'
        },
        {
          slot: 'sands',
          setId: 1,
          setName: 'Alpha Set',
          level: 20,
          rarity: 5,
          mainStat: { key: 'atkPct', value: 46.6 },
          subStats: [{ key: 'critDmg', value: 20.2 }]
        }
      ],
      talents: { normalAttack: 6, elementalSkill: 9, elementalBurst: 10 }
    },
    completeness: 'detailed',
    missingFields: [],
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt: '2026-01-01T00:00:00.000Z' },
      build: { source: 'miyoushe-detail', fetchedAt: '2026-01-01T00:00:00.000Z' },
      stats: { source: 'enka', fetchedAt: '2026-01-01T00:00:00.000Z' }
    }
  };
}

function profile(count: number): PersistedProfile {
  const characters = Array.from({ length: count }, (_, index) => character(index));
  return {
    schemaVersion: 2,
    uid: '123456789',
    source: 'merged',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    characters,
    coverage: {
      expectedOwnedCount: count,
      ownedCount: count,
      detailedCount: count,
      buildCount: count,
      statsCount: count,
      enkaShowcaseCount: Math.min(8, count),
      missingDetailCount: 0,
      partial: false
    }
  };
}

describe('advisor profile serializer', () => {
  it('keeps only compact decision fields and deterministically summarizes artifacts', () => {
    const compact = toAdvisorCharacter(character(1));
    expect(compact).toMatchObject({
      id: 10000001,
      level: 90,
      talents: { normal: 6, skill: 9, burst: 10 },
      weapon: { name: 'Weapon-1', level: 90, refinement: 1 },
      artifactSummary: {
        sets: [
          { name: 'Alpha Set', count: 1 },
          { name: 'Beta Set', count: 1 }
        ],
        mainStats: { goblet: 'pyroDmg', sands: 'atkPct' }
      },
      completeness: 'detailed',
      provenanceSummary: {
        ownership: 'miyoushe-list',
        build: 'miyoushe-detail',
        stats: 'enka'
      }
    });
    expect(compact.missingFields).toBeUndefined();
    const serialized = JSON.stringify(compact);
    expect(serialized).not.toContain('private.example.test');
    expect(serialized).not.toContain('subStats');
    expect(serialized).not.toContain('fetchedAt');
  });

  it('is stable and remains below 48 KiB for 100 characters', () => {
    const input = profile(100);
    const first = serializeAdvisorProfile(input, {
      enemyNames: ['Enemy A', 'Enemy B'],
      preference: 'stable rotation'
    });
    const second = serializeAdvisorProfile(input, {
      enemyNames: ['Enemy A', 'Enemy B'],
      preference: 'stable rotation'
    });
    expect(second).toBe(first);
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(MAX_ADVISOR_PROFILE_BYTES);
    expect(first).not.toContain('private.example.test');
    expect(first).not.toContain('subStats');
  });

  it('preserves unknown semantics for a basic character', () => {
    const basic = character(0);
    basic.build = undefined;
    basic.completeness = 'basic';
    basic.missingFields = ['stats', 'weapon', 'artifacts', 'talents'];
    const compact = toAdvisorCharacter(basic);
    expect(compact.stats).toBeUndefined();
    expect(compact.weapon).toBeUndefined();
    expect(compact.missingFields).toEqual(['stats', 'weapon', 'artifacts', 'talents']);
  });

  it('normalizes Enka and Miyoushe artifact main-stat keys to the same canonical value', () => {
    const enka = character(1);
    const miyoushe = character(2);
    enka.build!.artifacts![0]!.mainStat.key = 'FIGHT_PROP_FIRE_ADD_HURT';
    miyoushe.build!.artifacts![0]!.mainStat.key = 'pyroDmg';

    expect(toAdvisorCharacter(enka).artifactSummary?.mainStats.goblet).toBe('pyroDmg');
    expect(toAdvisorCharacter(miyoushe).artifactSummary?.mainStats.goblet).toBe('pyroDmg');
  });

  it('serializes unknown artifact main-stat keys as explicit unknown values', () => {
    const input = character(3);
    input.build!.artifacts![0]!.mainStat.key = 'new_stat\n<script>';

    expect(toAdvisorCharacter(input).artifactSummary?.mainStats.goblet).toBe('unknown');
  });
});
