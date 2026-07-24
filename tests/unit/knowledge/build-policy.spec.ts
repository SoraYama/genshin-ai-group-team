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
      reviewedArchetypes.every(({ minimumSupportingWeight }) => minimumSupportingWeight > 0)
    ).toBe(true);
  });

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
    ).toEqual(['raiden-onfield-er']);
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
});
