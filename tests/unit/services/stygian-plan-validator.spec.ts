import { describe, expect, it } from 'vitest';

import { validateStygianPlan } from '../../../src/main/services/stygian-plan-validator.js';
import type { CharacterKnowledgeReader } from '../../../src/shared/character-knowledge.js';
import {
  STYGIAN_CHARACTERS,
  stygianInput,
  stygianScenario,
  validStygianPlan
} from './stygian-test-fixtures.js';

const shieldKnowledge: CharacterKnowledgeReader = {
  version: 'test-knowledge',
  coverage: { characterCount: 1, notes: 'test' },
  lookup: (id) =>
    id === '1001'
      ? {
          status: 'known',
          knowledgeVersion: 'test-knowledge',
          id,
          name: '幽境角色1',
          capabilities: ['shield'],
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
          knowledgeVersion: 'test-knowledge',
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
    knowledgeVersion: 'test-knowledge',
    requested: new Set(ids).size,
    known: ids.includes('1001') ? 1 : 0,
    unknownCharacterIds: ids.filter((id) => id !== '1001')
  })
};

describe('validateStygianPlan', () => {
  it('enforces the complete application target-to-difficulty compatibility matrix', () => {
    const minimumOrder = {
      primogems: 1,
      'high-reward': 5,
      'dire-challenge': 6
    } as const;
    const scenario = stygianScenario();

    for (const target of ['primogems', 'high-reward', 'dire-challenge'] as const) {
      for (let order = 1; order <= 6; order += 1) {
        const result = validateStygianPlan({
          input: stygianInput({ target, difficultyId: `difficulty-${order}` }),
          scenario,
          characters: STYGIAN_CHARACTERS,
          plan: validStygianPlan()
        });
        if (order >= minimumOrder[target]) {
          expect(result.ok, `${target} order ${order}`).toBe(true);
        } else {
          expect(result.ok, `${target} order ${order}`).toBe(false);
          if (!result.ok) {
            expect(result.issues).toContainEqual(
              expect.objectContaining({ code: 'TARGET_DIFFICULTY_CONFLICT' })
            );
          }
        }
      }
    }
  });

  it('accepts exactly three four-person owned parties under a forbidden reuse rule', () => {
    expect(
      validateStygianPlan({
        input: stygianInput(),
        scenario: stygianScenario(),
        characters: STYGIAN_CHARACTERS,
        plan: validStygianPlan()
      })
    ).toMatchObject({ ok: true });
  });

  it('rejects missing difficulty or a requested phase absent from the scenario', () => {
    const missingDifficulty = validateStygianPlan({
      input: stygianInput({ difficultyId: 'missing' }),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      plan: validStygianPlan()
    });
    expect(missingDifficulty).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'DIFFICULTY_NOT_FOUND' })])
    });

    const missingPhase = validateStygianPlan({
      input: stygianInput({ phase: 3 }),
      scenario: {
        ...stygianScenario(),
        phases: stygianScenario().phases.slice(0, 2)
      } as ReturnType<typeof stygianScenario>,
      characters: STYGIAN_CHARACTERS,
      plan: validStygianPlan()
    });
    expect(missingPhase).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'PHASE_NOT_FOUND' })])
    });
  });

  it('enforces forbidden, allowed, and limited cross-party reuse from scenario data', () => {
    const reused = validStygianPlan({
      phases: validStygianPlan().phases.map((phase) => ({
        ...phase,
        team: { ...phase.team, characterIds: ['1001', '1002', '1003', '1004'] }
      }))
    });
    expect(
      validateStygianPlan({
        input: stygianInput(),
        scenario: stygianScenario(),
        characters: STYGIAN_CHARACTERS,
        plan: reused
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'REUSE_POLICY_VIOLATION' })])
    });

    expect(
      validateStygianPlan({
        input: stygianInput(),
        scenario: stygianScenario({ reuse: { rule: 'allowed', notes: [] } }),
        characters: STYGIAN_CHARACTERS,
        plan: { ...reused, reusePolicyAcknowledgement: 'allowed' }
      })
    ).toMatchObject({ ok: true });

    expect(
      validateStygianPlan({
        input: stygianInput(),
        scenario: stygianScenario({
          reuse: { rule: 'limited', maxPartyAppearancesPerCharacter: 2, notes: [] }
        }),
        characters: STYGIAN_CHARACTERS,
        plan: { ...reused, reusePolicyAcknowledgement: 'limited' }
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'REUSE_POLICY_VIOLATION' })])
    });
  });

  it('requires the plan acknowledgement to match the exact scenario reuse rule', () => {
    const result = validateStygianPlan({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      plan: { ...validStygianPlan(), reusePolicyAcknowledgement: 'allowed' }
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'REUSE_ACKNOWLEDGEMENT_MISMATCH' })
      ])
    });
  });

  it('enforces owned, excluded, locked, shield, immunity, and capability constraints', () => {
    const scenario = stygianScenario();
    scenario.phases[0]!.boss.mechanics.tags = ['requires-capability:shield'];
    const plan = validStygianPlan({
      phases: validStygianPlan().phases.map((phase, index) =>
        index === 0
          ? { ...phase, team: { ...phase.team, characterIds: ['1002', '1003', '1004', '1005'] } }
          : phase
      )
    });
    const result = validateStygianPlan({
      input: stygianInput({ lockedCharacterIds: ['1001'], excludedCharacterIds: ['1014'] }),
      scenario,
      characters: STYGIAN_CHARACTERS,
      knowledge: shieldKnowledge,
      plan
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'LOCKED_CHARACTER_MISSING' }),
        expect.objectContaining({ code: 'MECHANIC_COVERAGE_INVALID' })
      ])
    });

    const excludedPlan = {
      ...validStygianPlan(),
      phases: validStygianPlan().phases.map((phase, index) =>
        index === 2
          ? { ...phase, team: { ...phase.team, characterIds: ['1009', '1010', '1011', '1014'] } }
          : phase
      )
    };
    expect(
      validateStygianPlan({
        input: stygianInput({ excludedCharacterIds: ['1014'] }),
        scenario: stygianScenario(),
        characters: STYGIAN_CHARACTERS.slice(0, 13),
        plan: excludedPlan
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'CHARACTER_NOT_OWNED' }),
        expect.objectContaining({ code: 'CHARACTER_EXCLUDED' })
      ])
    });
  });

  it('rejects scenario identity and data version drift independently', () => {
    const result = validateStygianPlan({
      input: stygianInput(),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      plan: { ...validStygianPlan(), scenarioId: 'other', dataVersion: 'other' }
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'SCENARIO_MISMATCH' }),
        expect.objectContaining({ code: 'DATA_VERSION_MISMATCH' })
      ])
    });
  });

  it('rejects raw tool names, internal keys, and service slugs in player-facing plan text', () => {
    const plan = validStygianPlan();
    plan.phases[0]!.team.purpose =
      '调用 query_stygian_phase 后按 dire-challenge 的 dataVersion 处理。';
    expect(
      validateStygianPlan({
        input: stygianInput(),
        scenario: stygianScenario(),
        characters: STYGIAN_CHARACTERS,
        plan
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'AGENT_OUTPUT_INVALID' })])
    });
  });
});
