import { describe, expect, it } from 'vitest';

import { evaluateTheaterEligibility } from '../../../src/main/services/theater-eligibility.js';
import { THEATER_CHARACTERS, theaterInput, theaterScenario } from './theater-test-fixtures.js';

describe('evaluateTheaterEligibility', () => {
  it('counts owned characters only when element and level qualify', () => {
    const report = evaluateTheaterEligibility({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS
    });

    expect(report.status).toBe('eligible');
    expect(report.eligibleOwnedCount).toBe(9);
    expect(report.hardQualifiedCount).toBe(9);
    expect(report.ineligibleOwned).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ characterId: '1009', reasons: ['element'] }),
        expect.objectContaining({ characterId: '1010', reasons: ['element'] }),
        expect.objectContaining({ characterId: '1011', reasons: ['level'] })
      ])
    );
  });

  it('does not let an external special-guest instance contribute to owned hard eligibility', () => {
    const report = evaluateTheaterEligibility({
      input: theaterInput({ selectedSpecialGuestCharacterIds: ['1009'] }),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS
    });

    expect(report.hardQualifiedCount).toBe(9);
    expect(report.pools).toContainEqual(
      expect.objectContaining({
        id: '1009',
        source: 'special-guest',
        qualification: 'unknown',
        countsTowardRequirement: false,
        owned: true
      })
    );
  });

  it('does not treat external trial or support entries as owned or hard-qualified when rules are undefined', () => {
    const report = evaluateTheaterEligibility({
      input: theaterInput({
        selectedTrialCharacterIds: ['trial.1'],
        selectedSupportCharacterIds: ['support.1']
      }),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS.slice(0, 7)
    });

    expect(report.status).toBe('blocked');
    expect(report.hardQualifiedCount).toBe(7);
    expect(report.shortage).toBe(1);
    expect(report.pools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'trial.1',
          qualification: 'unknown',
          countsTowardRequirement: false
        }),
        expect.objectContaining({
          id: 'support.1',
          qualification: 'unknown',
          countsTowardRequirement: false
        })
      ])
    );
  });

  it('returns construction advice from low-level matching characters and missing capabilities', () => {
    const report = evaluateTheaterEligibility({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS.slice(0, 6).concat(THEATER_CHARACTERS[10]!),
      knowledge: {
        version: 'test',
        coverage: { characterCount: 0, notes: 'test' },
        lookup: () => ({ status: 'unknown', id: 'x', knowledgeVersion: 'test', unknownFields: [] }),
        coverageFor: () => ({
          knowledgeVersion: 'test',
          requested: 0,
          known: 0,
          unknownCharacterIds: []
        })
      }
    });

    expect(report.status).toBe('blocked');
    expect(report.constructionAdvice).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'raise-level', characterId: '1011' }),
        expect.objectContaining({ kind: 'capability-gap', capability: 'grouping' })
      ])
    );
  });
});
