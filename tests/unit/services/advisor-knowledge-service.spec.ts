import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  AdvisorKnowledgeService,
  advisorScenarioTargetSchema
} from '../../../src/main/services/advisor-knowledge-service.js';
import { KnowledgeBundleStore } from '../../../src/main/services/knowledge-bundle-store.js';
import type {
  ArtifactMainStatKey,
  KnowledgeContextPacket
} from '../../../src/shared/advisor-knowledge.js';
import type {
  ArtifactPiece,
  CharacterProfile,
  PersistedProfile
} from '../../../src/shared/domain.js';

const knowledgeDirectory = resolve(process.cwd(), 'resources/knowledge');
const preferences = {
  comfort: 'medium' as const,
  survival: 'medium' as const,
  lowInvestment: 'low' as const,
  noBuildChange: true
};

let store: KnowledgeBundleStore;

beforeAll(async () => {
  store = await KnowledgeBundleStore.load(knowledgeDirectory);
});

function artifact(
  slot: 'sands' | 'goblet' | 'circlet',
  mainStat: ArtifactMainStatKey
): ArtifactPiece {
  return {
    slot,
    setId: 1,
    setName: 'Informational set',
    level: 20,
    rarity: 5,
    mainStat: { key: mainStat, value: 1 },
    subStats: []
  };
}

function character(
  id: number,
  mains: [ArtifactMainStatKey, ArtifactMainStatKey, ArtifactMainStatKey],
  overrides: Partial<CharacterProfile> = {}
): CharacterProfile {
  return {
    id,
    name: `Character-${id}`,
    element: 'Electro',
    rarity: 5,
    imageUrl: 'https://private.example/avatar.png',
    level: 90,
    build: {
      artifacts: [
        artifact('sands', mains[0]),
        artifact('goblet', mains[1]),
        artifact('circlet', mains[2])
      ],
      stats: {
        hp: 30_000,
        atk: 1_800,
        def: 800,
        critRate: 70,
        critDmg: 160,
        energyRecharge: 130,
        elementalMastery: 100
      }
    },
    completeness: 'detailed',
    missingFields: [],
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt: '2026-07-24T00:00:00.000Z' },
      build: { source: 'miyoushe-detail', fetchedAt: '2026-07-24T00:00:00.000Z' },
      stats: { source: 'enka', fetchedAt: '2026-07-24T00:00:00.000Z' }
    },
    ...overrides
  };
}

function profile(characters: CharacterProfile[]): PersistedProfile {
  return {
    schemaVersion: 2,
    uid: '123456789',
    nickname: 'PRIVATE-NICKNAME',
    source: 'merged',
    fetchedAt: '2026-07-24T00:00:00.000Z',
    characters,
    coverage: {
      ownedCount: characters.length,
      detailedCount: characters.length,
      buildCount: characters.length,
      statsCount: characters.length,
      enkaShowcaseCount: characters.length,
      missingDetailCount: 0,
      partial: false
    }
  };
}

function build(
  input: Parameters<AdvisorKnowledgeService['buildPacket']>[0],
  now = new Date('2026-07-25T12:00:00+08:00')
): KnowledgeContextPacket {
  return new AdvisorKnowledgeService(store, () => now).buildPacket(input);
}

describe('AdvisorKnowledgeService', () => {
  it('combines build interpretation and all six required scenario mappings into one trusted packet', () => {
    const packet = build({
      profile: profile([
        character(10000052, ['elementalMastery', 'elementalMastery', 'elementalMastery'])
      ]),
      scenarioTarget: {
        id: 'abyss-12-1-first',
        tags: [
          'elemental-shield',
          'high-resistance',
          'multi-wave',
          'groupable',
          'single-target',
          'survival-pressure'
        ]
      },
      candidateIds: ['10000052'],
      preferences
    });

    expect(packet.buildInterpretations).toEqual([
      expect.objectContaining({
        characterId: '10000052',
        archetypeId: 'raiden-em-hyperbloom',
        currentBuildUsable: true
      })
    ]);
    expect(
      packet.trustedMatches.flatMap(({ mechanicId }) =>
        mechanicId === undefined ? [] : [mechanicId]
      )
    ).toEqual([
      'shield-breaking',
      'resistance-avoidance',
      'wave-efficient-rotation',
      'grouping-value',
      'single-target-pressure',
      'sustain-required'
    ]);
    expect(packet.coverage).toEqual({
      requested: 7,
      trusted: 7,
      ephemeral: 0,
      unknown: 0
    });
    expect(packet.ephemeralMatches).toEqual([]);
    expect(new Set(packet.citations.map(({ id }) => id)).size).toBe(packet.citations.length);
    expect(JSON.stringify(packet)).not.toMatch(
      /123456789|PRIVATE-NICKNAME|private\.example|cookie|Authorization/
    );
  });

  it('derives conservative tags from structured target fields and validates the target strictly', () => {
    const parsed = advisorScenarioTargetSchema.parse({
      id: 'structured-target',
      tags: ['burrow'],
      shields: [{ element: 'hydro' }],
      resistances: [{ damageType: 'geo', percent: 60 }],
      immunities: ['freeze'],
      waveCount: 2,
      enemyCount: 1
    });
    const packet = build({
      profile: profile([]),
      scenarioTarget: parsed,
      candidateIds: [],
      preferences
    });

    expect(packet.trustedMatches.map(({ mechanicId }) => mechanicId)).toEqual([
      'shield-breaking',
      'resistance-avoidance',
      'wave-efficient-rotation',
      'single-target-pressure',
      'mobile-window-alignment',
      'reaction-constraint'
    ]);
    expect(
      advisorScenarioTargetSchema.safeParse({
        ...parsed,
        uid: '123456789',
        cookie: 'ltoken_v2=secret'
      }).success
    ).toBe(false);
  });

  it.each([
    {
      name: 'missing',
      candidate: character(10000002, ['atkPct', 'pyroDmg', 'critRate']),
      expected: 'missing'
    },
    {
      name: 'conflict',
      candidate: character(10000073, ['elementalMastery', 'dendroDmg', 'critRate'], {
        build: {
          artifacts: [
            artifact('sands', 'elementalMastery'),
            artifact('goblet', 'dendroDmg'),
            artifact('circlet', 'critRate')
          ],
          stats: {
            hp: 30_000,
            atk: 1_800,
            def: 800,
            critRate: 70,
            critDmg: 160,
            energyRecharge: 130,
            elementalMastery: 900
          }
        }
      }),
      expected: 'conflict'
    },
    {
      name: 'build-unmatched',
      candidate: character(10000052, ['hpPct', 'pyroDmg', 'healingBonus'], {
        build: {
          artifacts: [
            artifact('sands', 'hpPct'),
            artifact('goblet', 'pyroDmg'),
            artifact('circlet', 'healingBonus')
          ],
          stats: {
            hp: 30_000,
            atk: 1_800,
            def: 800,
            critRate: 70,
            critDmg: 160,
            energyRecharge: 100,
            elementalMastery: 100
          }
        }
      }),
      expected: 'build-unmatched'
    }
  ])('emits an explicit $name gap without inventing a match', ({ candidate, expected }) => {
    const packet = build({
      profile: profile([candidate]),
      scenarioTarget: { id: 'neutral-target', tags: [] },
      candidateIds: [String(candidate.id)],
      preferences
    });

    expect(packet.trustedMatches).toEqual([]);
    expect(packet.unknowns).toEqual([
      expect.objectContaining({
        subjectId: String(candidate.id),
        kind: expected
      })
    ]);
    expect(packet.coverage).toEqual({
      requested: 1,
      trusted: 0,
      ephemeral: 0,
      unknown: 1
    });
  });

  it('turns otherwise reviewed character and mechanic facts into stale gaps after cadence expiry', () => {
    const packet = build(
      {
        profile: profile([
          character(10000052, ['elementalMastery', 'elementalMastery', 'elementalMastery'])
        ]),
        scenarioTarget: { id: 'stale-target', tags: ['elemental-shield'] },
        candidateIds: ['10000052'],
        preferences
      },
      new Date('2027-02-01T00:00:00+08:00')
    );

    expect(packet.trustedMatches).toEqual([]);
    expect(packet.unknowns.map(({ subjectId, kind }) => ({ subjectId, kind }))).toEqual([
      { subjectId: '10000052', kind: 'stale' },
      { subjectId: 'mechanic:shield-breaking', kind: 'stale' }
    ]);
  });

  it('marks unknown target tags as missing instead of silently dropping them', () => {
    const packet = build({
      profile: profile([]),
      scenarioTarget: { id: 'new-mechanic', tags: ['future-unknown-mechanic'] },
      candidateIds: [],
      preferences
    });

    expect(packet.unknowns).toEqual([
      expect.objectContaining({
        subjectId: 'scenario:future-unknown-mechanic',
        kind: 'missing'
      })
    ]);
  });
});
