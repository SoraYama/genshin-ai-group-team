import { describe, expect, it } from 'vitest';

import { validateTheaterPlan } from '../../../src/main/services/theater-plan-validator.js';
import type { CharacterKnowledgeReader } from '../../../src/shared/character-knowledge.js';
import {
  THEATER_CHARACTERS,
  theaterInput,
  theaterScenario,
  validTheaterPlan
} from './theater-test-fixtures.js';

const groupingKnowledge: CharacterKnowledgeReader = {
  version: 'test',
  coverage: { characterCount: 1, notes: 'test' },
  lookup: (id) =>
    id === '1001'
      ? {
          status: 'known',
          knowledgeVersion: 'test',
          id,
          name: '剧诗角色1',
          capabilities: ['grouping'],
          unknownFields: [
            'weaponType',
            'roles',
            'energyCost',
            'energyNeeds',
            'applicationNotes',
            'kitNotes'
          ]
        }
      : {
          status: 'unknown',
          id,
          knowledgeVersion: 'test',
          unknownFields: [
            'weaponType',
            'roles',
            'energyCost',
            'energyNeeds',
            'capabilities',
            'applicationNotes',
            'kitNotes'
          ]
        },
  coverageFor: (ids) => ({
    knowledgeVersion: 'test',
    requested: new Set(ids).size,
    known: ids.includes('1001') ? 1 : 0,
    unknownCharacterIds: ids.filter((id) => id !== '1001')
  })
};

describe('validateTheaterPlan', () => {
  it('accepts a complete route whose selected owned cast and per-act candidates are valid', () => {
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: theaterScenario(),
        characters: THEATER_CHARACTERS,
        knowledge: groupingKnowledge,
        plan: validTheaterPlan()
      })
    ).toMatchObject({
      ok: true,
      vigorBudget: expect.arrayContaining([
        { act: 1, characterId: '1001', before: 2, spent: 1, after: 1 },
        { act: 1, characterId: '1004', before: 2, spent: 1, after: 1 },
        { act: 2, characterId: '1005', before: 2, spent: 1, after: 1 },
        { act: 2, characterId: '1008', before: 2, spent: 1, after: 1 }
      ])
    });
  });

  it('rechecks final cast headcount, level, and element instead of trusting the preflight roster', () => {
    const cases = [
      validTheaterPlan({
        cast: { ...validTheaterPlan().cast, selectedCharacterIds: ['1001'] }
      }),
      validTheaterPlan({
        cast: {
          ...validTheaterPlan().cast,
          selectedCharacterIds: ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1009']
        }
      }),
      validTheaterPlan({
        cast: {
          ...validTheaterPlan().cast,
          selectedCharacterIds: ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1011']
        }
      })
    ];
    for (const plan of cases) {
      expect(
        validateTheaterPlan({
          input: theaterInput(),
          scenario: theaterScenario(),
          characters: THEATER_CHARACTERS,
          knowledge: groupingKnowledge,
          plan
        })
      ).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'CAST_ELIGIBILITY_INVALID' })
        ])
      });
    }
  });

  it('blocks when a target act has no explicit vigor cost instead of inferring zero', () => {
    const scenario = theaterScenario();
    scenario.vigor.actCosts = scenario.vigor.actCosts.filter(({ act }) => act !== 2);
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario,
        characters: THEATER_CHARACTERS,
        knowledge: groupingKnowledge,
        plan: validTheaterPlan()
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'VIGOR_BUDGET_INVALID' })])
    });
  });

  it('normalizes valid agent acts by act number before returning the plan and ledger', () => {
    const plan = validTheaterPlan();
    plan.acts.reverse();
    const result = validateTheaterPlan({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge: groupingKnowledge,
      plan
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid plan');
    expect(result.plan.acts.map(({ act }) => act)).toEqual([1, 2]);
    expect(result.vigorBudget.map(({ act }) => act)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it('rejects cast source mismatch and an external pool entry masquerading as owned', () => {
    const plan = validTheaterPlan();
    plan.cast.trialCharacterIds = ['support.1'];
    plan.cast.selectedCharacterIds[0] = 'trial.1';
    const result = validateTheaterPlan({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      plan
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'CAST_SOURCE_MISMATCH' }),
        expect.objectContaining({ code: 'CHARACTER_NOT_OWNED' })
      ])
    });
  });

  it('rejects one actor ID assigned to more than one cast source', () => {
    const plan = validTheaterPlan();
    plan.cast.openingCharacterIds = ['1001'];
    expect(
      validateTheaterPlan({
        input: theaterInput({ selectedOpeningCharacterIds: ['1001'] }),
        scenario: theaterScenario(),
        characters: THEATER_CHARACTERS,
        knowledge: groupingKnowledge,
        plan
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'CAST_DUPLICATE' })])
    });
  });

  it('does not count an owned profile character when the plan uses its external actor instance', () => {
    const plan = validTheaterPlan();
    plan.cast.selectedCharacterIds = plan.cast.selectedCharacterIds.filter((id) => id !== '1001');
    plan.cast.openingCharacterIds = ['1001'];
    expect(
      validateTheaterPlan({
        input: theaterInput({ selectedOpeningCharacterIds: ['1001'] }),
        scenario: theaterScenario(),
        characters: THEATER_CHARACTERS,
        knowledge: groupingKnowledge,
        plan
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'CAST_ELIGIBILITY_INVALID',
          details: expect.objectContaining({ required: 8, qualified: 7 })
        })
      ])
    });
  });

  it('rejects candidates outside the admitted cast and planned spend outside candidates', () => {
    const plan = validTheaterPlan();
    plan.acts[0]!.candidateCharacterIds = ['1001', '9999'];
    plan.acts[0]!.plannedVigorSpend = [{ characterId: '1002', cost: 1 }];
    const result = validateTheaterPlan({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      plan
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'CANDIDATE_NOT_IN_CAST' }),
        expect.objectContaining({ code: 'VIGOR_BUDGET_INVALID' })
      ])
    });
  });

  it('rejects negative cumulative vigor and per-act cost above the scenario rule', () => {
    const plan = validTheaterPlan();
    plan.acts[0]!.plannedVigorSpend = [
      { characterId: '1001', cost: 2 },
      { characterId: '1002', cost: 1 },
      { characterId: '1003', cost: 1 },
      { characterId: '1004', cost: 1 }
    ];
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: theaterScenario(),
        characters: THEATER_CHARACTERS,
        plan
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'VIGOR_BUDGET_INVALID' })])
    });
  });

  it('does not let random scenario paths masquerade as fixed outcomes', () => {
    const plan = validTheaterPlan();
    plan.acts[1]!.pathChoice = { kind: 'fixed', note: '这条路线已确定。' };
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: theaterScenario(),
        characters: THEATER_CHARACTERS,
        plan
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'PATH_CHOICE_INVALID' })])
    });
  });

  it('requires every requested act and every hard mechanic capability', () => {
    const missingAct = validTheaterPlan({ acts: validTheaterPlan().acts.slice(1) });
    expect(
      validateTheaterPlan({
        input: theaterInput({ act: 1 }),
        scenario: theaterScenario(),
        characters: THEATER_CHARACTERS,
        knowledge: groupingKnowledge,
        plan: missingAct
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'ACT_COVERAGE_INVALID' })])
    });
    const missingCapability = validTheaterPlan();
    missingCapability.acts[0]!.candidateCharacterIds = ['1002', '1003', '1004'];
    missingCapability.acts[0]!.plannedVigorSpend = [{ characterId: '1002', cost: 1 }];
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: theaterScenario(),
        characters: THEATER_CHARACTERS,
        knowledge: groupingKnowledge,
        plan: missingCapability
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'MECHANIC_COVERAGE_INVALID' })
      ])
    });
  });

  it('rejects scenario identity drift and excluded selected owned characters', () => {
    const plan = validTheaterPlan({ scenarioId: 'other', dataVersion: 'other' });
    const result = validateTheaterPlan({
      input: theaterInput({ excludedCharacterIds: ['1001'] }),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      plan
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'SCENARIO_MISMATCH' }),
        expect.objectContaining({ code: 'DATA_VERSION_MISMATCH' }),
        expect.objectContaining({ code: 'CHARACTER_EXCLUDED' })
      ])
    });
  });
});
