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

  it('counts a selected special guest from the owned roster when its level is qualified', () => {
    const scenario = theaterScenario();
    scenario.eligibility.requiredHeadcount = 9;
    const report = evaluateTheaterEligibility({
      input: theaterInput({ selectedSpecialGuestCharacterIds: ['1009'] }),
      scenario,
      characters: THEATER_CHARACTERS.slice(0, 9)
    });

    expect(report.hardQualifiedCount).toBe(9);
    expect(report.status).toBe('eligible');
    expect(report.pools).toContainEqual(
      expect.objectContaining({
        id: '1009',
        source: 'special-guest',
        qualification: 'qualified',
        countsTowardRequirement: true,
        owned: true
      })
    );
  });

  it('rejects a selected owned special guest below the minimum level', () => {
    const scenario = theaterScenario();
    scenario.eligibility.requiredHeadcount = 9;
    const characters = THEATER_CHARACTERS.slice(0, 9).map((character) =>
      character.id === 1009 ? { ...character, level: 60 } : character
    );
    const report = evaluateTheaterEligibility({
      input: theaterInput({ selectedSpecialGuestCharacterIds: ['1009'] }),
      scenario,
      characters
    });

    expect(report).toMatchObject({ status: 'blocked', hardQualifiedCount: 8, shortage: 1 });
    expect(report.pools).toContainEqual(
      expect.objectContaining({
        id: '1009',
        source: 'special-guest',
        qualification: 'unqualified',
        countsTowardRequirement: false
      })
    );
  });

  it('does not count an owned actor when the selected instance comes from opening cast', () => {
    const scenario = theaterScenario();
    const report = evaluateTheaterEligibility({
      input: theaterInput({ selectedOpeningCharacterIds: ['1001'] }),
      scenario,
      characters: THEATER_CHARACTERS.slice(0, 8)
    });

    expect(report).toMatchObject({ status: 'blocked', hardQualifiedCount: 7, shortage: 1 });
    expect(report.pools).toContainEqual(
      expect.objectContaining({
        id: '1001',
        source: 'opening',
        qualification: 'unknown',
        countsTowardRequirement: false
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
