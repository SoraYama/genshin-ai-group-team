import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateReviewedArchetypes } from '../../../src/shared/advisor-build-policy.js';
import {
  committedCharacterStrategyBundleV2Schema,
  type CommittedBuildArchetypeV2
} from '../../../src/shared/advisor-knowledge.js';

const strategies = committedCharacterStrategyBundleV2Schema.parse(
  JSON.parse(
    readFileSync(resolve(process.cwd(), 'resources/knowledge/character-strategies.v2.json'), 'utf8')
  )
);

function reviewedCharacter(characterId: string) {
  const character = strategies.characters.find(({ id }) => id === characterId);
  if (character?.reviewState !== 'reviewed') throw new Error(`Missing reviewed ${characterId}`);
  return character;
}

function isReviewedArchetype(
  archetype: CommittedBuildArchetypeV2
): archetype is Extract<CommittedBuildArchetypeV2, { coverage: 'reviewed' }> {
  return archetype.coverage === 'reviewed';
}

describe('reviewed build signal policy', () => {
  it('keeps all ten archetypes conservative by using equipment clues only as support', () => {
    const reviewedArchetypes = strategies.characters
      .filter(({ reviewState }) => reviewState === 'reviewed')
      .flatMap(({ archetypes }) => archetypes)
      .filter(isReviewedArchetype);

    expect(reviewedArchetypes).toHaveLength(10);
    expect(
      reviewedArchetypes.every(({ signals }) => signals.every(({ required }) => !required))
    ).toBe(true);
    expect(
      reviewedArchetypes.every(
        ({ minimumSupportingWeight, signals }) =>
          minimumSupportingWeight > Math.max(...signals.map(({ weight }) => weight))
      )
    ).toBe(true);
  });

  it.each([
    {
      characterId: '10000052',
      archetypeId: 'raiden-em-hyperbloom',
      oneClue: { mainStats: { sands: 'elementalMastery' as const } },
      twoClues: {
        mainStats: { sands: 'elementalMastery' as const, goblet: 'elementalMastery' as const }
      }
    },
    {
      characterId: '10000052',
      archetypeId: 'raiden-emblem-on-field',
      oneClue: { stats: { energyRecharge: 130 } },
      twoClues: {
        mainStats: { sands: 'atkPct' as const },
        stats: { energyRecharge: 130 }
      }
    },
    {
      characterId: '10000065',
      archetypeId: 'shinobu-em-hyperbloom',
      oneClue: { mainStats: { sands: 'elementalMastery' as const } },
      twoClues: {
        mainStats: { sands: 'elementalMastery' as const, goblet: 'elementalMastery' as const }
      }
    },
    {
      characterId: '10000065',
      archetypeId: 'shinobu-healer-quicken',
      oneClue: { mainStats: { sands: 'hpPct' as const } },
      twoClues: {
        mainStats: { sands: 'hpPct' as const, circlet: 'healingBonus' as const }
      }
    },
    {
      characterId: '10000073',
      archetypeId: 'nahida-on-field-driver',
      oneClue: { mainStats: { goblet: 'dendroDmg' as const } },
      twoClues: {
        mainStats: { goblet: 'dendroDmg' as const, circlet: 'critRate' as const }
      }
    },
    {
      characterId: '10000073',
      archetypeId: 'nahida-off-field-dendro',
      oneClue: { stats: { elementalMastery: 900 } },
      twoClues: {
        mainStats: { sands: 'elementalMastery' as const },
        stats: { elementalMastery: 900 }
      }
    },
    {
      characterId: '10000054',
      archetypeId: 'kokomi-bloom-trigger',
      oneClue: { mainStats: { sands: 'elementalMastery' as const } },
      twoClues: {
        mainStats: { sands: 'elementalMastery' as const, goblet: 'elementalMastery' as const }
      }
    },
    {
      characterId: '10000054',
      archetypeId: 'kokomi-off-field-healer',
      oneClue: { mainStats: { sands: 'hpPct' as const } },
      twoClues: {
        mainStats: { sands: 'hpPct' as const, circlet: 'healingBonus' as const }
      }
    },
    {
      characterId: '10000054',
      archetypeId: 'kokomi-on-field-driver',
      oneClue: { mainStats: { goblet: 'hydroDmg' as const } },
      twoClues: {
        mainStats: { goblet: 'hydroDmg' as const, circlet: 'healingBonus' as const }
      }
    },
    {
      characterId: '10000089',
      archetypeId: 'furina-off-field-fanfare',
      oneClue: { mainStats: { goblet: 'hpPct' as const } },
      twoClues: {
        mainStats: { sands: 'energyRecharge' as const, goblet: 'hpPct' as const }
      }
    }
  ])(
    'requires corroborating clues for $archetypeId',
    ({ characterId, archetypeId, oneClue, twoClues }) => {
      const archetype = reviewedCharacter(characterId).archetypes.find(
        ({ id }) => id === archetypeId
      );
      if (archetype === undefined) throw new Error(`Missing archetype ${archetypeId}`);

      expect(evaluateReviewedArchetypes([archetype], oneClue).matches).toEqual([]);
      expect(
        evaluateReviewedArchetypes([archetype], twoClues).matches.map(
          ({ archetypeId: matchedId }) => matchedId
        )
      ).toEqual([archetypeId]);
    }
  );

  it('keeps an ATK-sands Raiden build compatible with on-field play when ER meets the floor', () => {
    const result = evaluateReviewedArchetypes(reviewedCharacter('10000052').archetypes, {
      mainStats: { sands: 'atkPct', goblet: 'electroDmg', circlet: 'critRate' },
      stats: { energyRecharge: 130 }
    });

    expect(result.matches.map(({ archetypeId }) => archetypeId)).toContain(
      'raiden-emblem-on-field'
    );
    expect(
      result.matches.find(({ archetypeId }) => archetypeId === 'raiden-emblem-on-field')
        ?.matchedSignalIds
    ).toEqual(['raiden-onfield-er', 'raiden-onfield-atk-sands']);
  });

  it('marks a high-EM Nahida build ambiguous when on-field and off-field clues overlap', () => {
    const result = evaluateReviewedArchetypes(reviewedCharacter('10000073').archetypes, {
      mainStats: { sands: 'elementalMastery', goblet: 'dendroDmg', circlet: 'critRate' },
      stats: { elementalMastery: 900 }
    });

    expect(result.matches.map(({ archetypeId }) => archetypeId).sort()).toEqual(
      ['nahida-off-field-dendro', 'nahida-on-field-driver'].sort()
    );
    expect(result.overlappingCandidates).toBe(true);
  });

  it('retains missing and conflicting signal diagnostics for a rejected real candidate', () => {
    const archetype = reviewedCharacter('10000052').archetypes.find(
      ({ id }) => id === 'raiden-emblem-on-field'
    );
    if (archetype === undefined) throw new Error('Raiden on-field archetype is required');

    const result = evaluateReviewedArchetypes([archetype], {
      mainStats: { sands: 'atkPct' },
      stats: { energyRecharge: 120 }
    });

    expect(result.matches).toEqual([]);
    expect(result.evaluations).toEqual([
      {
        archetypeId: 'raiden-emblem-on-field',
        compatible: false,
        matchedSignalIds: ['raiden-onfield-atk-sands'],
        matchedSignals: [{ id: 'raiden-onfield-atk-sands', weight: 2, required: false }],
        missingSignalIds: [],
        missingSignals: [],
        conflictingSignalIds: ['raiden-onfield-er', 'raiden-onfield-er-sands'],
        conflictingSignals: [
          { id: 'raiden-onfield-er', weight: 5, required: false },
          { id: 'raiden-onfield-er-sands', weight: 2, required: false }
        ],
        supportingWeight: 2,
        minimumSupportingWeight: 7
      }
    ]);
  });

  it('keeps a synthetic required-signal conflict incompatible despite enough support', () => {
    const source = reviewedCharacter('10000065').archetypes.find(
      ({ id }) => id === 'shinobu-healer-quicken'
    );
    if (source?.coverage !== 'reviewed') throw new Error('reviewed archetype is required');
    const archetype = structuredClone(source);
    archetype.signals[0]!.required = true;
    archetype.minimumSupportingWeight = 4;

    const result = evaluateReviewedArchetypes([archetype], {
      mainStats: { sands: 'hpPct', circlet: 'critRate' }
    });

    expect(result.matches).toEqual([]);
    expect(result.evaluations[0]).toMatchObject({
      compatible: false,
      matchedSignalIds: ['shinobu-quicken-hp-sands'],
      matchedSignals: [{ id: 'shinobu-quicken-hp-sands', weight: 4, required: false }],
      conflictingSignalIds: ['shinobu-quicken-healing-circlet'],
      conflictingSignals: [{ id: 'shinobu-quicken-healing-circlet', weight: 4, required: true }],
      supportingWeight: 4
    });
  });
});
