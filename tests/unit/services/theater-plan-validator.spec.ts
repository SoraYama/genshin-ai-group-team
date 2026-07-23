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
      vigorBudget: [
        { act: 1, before: 2, spent: 1, after: 1 },
        { act: 2, before: 1, spent: 1, after: 0 }
      ]
    });
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
      { characterId: '1002', cost: 1 }
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
