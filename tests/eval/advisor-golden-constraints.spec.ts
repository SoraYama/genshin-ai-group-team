import { describe, expect, it } from 'vitest';

import { buildLocalAbyssPlan } from '../../src/main/services/abyss-local-optimizer.js';
import { validateAbyssPlan } from '../../src/main/services/abyss-plan-validator.js';
import { buildLocalStygianPlan } from '../../src/main/services/stygian-local-optimizer.js';
import { validateStygianPlan } from '../../src/main/services/stygian-plan-validator.js';
import { buildLocalTheaterPlan } from '../../src/main/services/theater-local-planner.js';
import { validateTheaterPlan } from '../../src/main/services/theater-plan-validator.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario,
  validAbyssPlan
} from '../unit/services/abyss-test-fixtures.js';
import {
  STYGIAN_CHARACTERS,
  stygianInput,
  stygianScenario,
  validStygianPlan
} from '../unit/services/stygian-test-fixtures.js';
import {
  THEATER_CHARACTERS,
  THEATER_KNOWLEDGE,
  theaterInput,
  theaterScenario,
  validTheaterPlan
} from '../unit/services/theater-test-fixtures.js';

/**
 * These are constraint goldens, not prescribed teams. A plan may choose any
 * actors as long as the deterministic rules below remain true.
 */
describe('advisor golden constraints', () => {
  describe('Spiral Abyss', () => {
    it('accepts a valid two-half plan and rejects size, reuse, intervention, ID, and evidence violations', () => {
      const scenario = abyssScenario();
      const input = abyssInput({ lockedCharacterIds: ['1001'], excludedCharacterIds: ['1009'] });
      const valid = validAbyssPlan();

      expect(
        validateAbyssPlan({
          input,
          scenario,
          characters: ABYSS_CHARACTERS,
          plan: valid
        })
      ).toMatchObject({ ok: true, issues: [] });

      const mutations = [
        {
          expected: 'TEAM_SIZE_INVALID',
          plan: {
            ...valid,
            firstHalfTeam: { ...valid.firstHalfTeam, characterIds: ['1001', '1004', '1005'] }
          }
        },
        {
          expected: 'CROSS_TEAM_DUPLICATE',
          plan: {
            ...valid,
            secondHalfTeam: {
              ...valid.secondHalfTeam,
              characterIds: ['1001', '1003', '1007', '1008']
            }
          }
        },
        {
          expected: 'CHARACTER_EXCLUDED',
          plan: {
            ...valid,
            secondHalfTeam: {
              ...valid.secondHalfTeam,
              characterIds: ['1002', '1003', '1007', '1009']
            }
          }
        },
        {
          expected: 'CHARACTER_NOT_OWNED',
          plan: {
            ...valid,
            secondHalfTeam: {
              ...valid.secondHalfTeam,
              characterIds: ['1002', '1003', '1007', '999999']
            }
          }
        },
        {
          expected: 'TACTICS_MISSING',
          plan: {
            ...valid,
            chambers: valid.chambers.map((chamber, index) =>
              index === 0
                ? { ...chamber, firstHalf: { ...chamber.firstHalf, tactics: [] } }
                : chamber
            )
          }
        }
      ] as const;

      for (const mutation of mutations) {
        const result = validateAbyssPlan({
          input,
          scenario,
          characters: ABYSS_CHARACTERS,
          plan: mutation.plan
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.issues.map(({ code }) => code)).toContain(mutation.expected);
        }
      }
    });

    it('keeps hard-constraint violation rate at zero for the deterministic fallback', () => {
      const scenario = abyssScenario();
      const input = abyssInput({ lockedCharacterIds: ['1001'], excludedCharacterIds: ['1010'] });
      const result = buildLocalAbyssPlan({
        input,
        scenario,
        characters: ABYSS_CHARACTERS
      });
      expect(result.status).toBe('planned');
      if (result.status !== 'planned') return;
      expect(
        validateAbyssPlan({
          input,
          scenario,
          characters: ABYSS_CHARACTERS,
          plan: result.plan
        })
      ).toMatchObject({ ok: true, issues: [] });
    });
  });

  describe('Stygian Onslaught', () => {
    it.each([
      { rule: { rule: 'forbidden' as const, notes: [] }, maximum: 1 },
      {
        rule: {
          rule: 'limited' as const,
          maxPartyAppearancesPerCharacter: 2,
          notes: ['每名角色最多进入两队。']
        },
        maximum: 2
      },
      { rule: { rule: 'allowed' as const, notes: ['允许跨阶段复用。'] }, maximum: 3 }
    ])('enforces three phases and the $rule.rule reuse policy', ({ rule, maximum }) => {
      const scenario = stygianScenario({ reuse: rule });
      const input = stygianInput();
      const valid = validStygianPlan({
        reusePolicyAcknowledgement: rule.rule
      });
      expect(
        validateStygianPlan({
          input,
          scenario,
          characters: STYGIAN_CHARACTERS,
          plan: valid
        })
      ).toMatchObject({ ok: true, issues: [] });

      const repeated = {
        ...valid,
        phases: valid.phases.map((phase, index) => ({
          ...phase,
          team: {
            ...phase.team,
            characterIds:
              index > 0 && index <= maximum
                ? ['1001', ...phase.team.characterIds.slice(1)]
                : phase.team.characterIds
          }
        }))
      };
      if (maximum < 3) {
        const validation = validateStygianPlan({
          input,
          scenario,
          characters: STYGIAN_CHARACTERS,
          plan: repeated
        });
        expect(validation.ok).toBe(false);
        if (!validation.ok) {
          expect(validation.issues.map(({ code }) => code)).toContain('REUSE_POLICY_VIOLATION');
        }
      }
    });

    it('rejects difficulty/reward mismatch, exclusions, unknown IDs, missing phases, and missing evidence', () => {
      const scenario = stygianScenario();
      const valid = validStygianPlan();
      const checks = [
        {
          input: stygianInput({ difficultyId: 'difficulty-1', target: 'dire-challenge' }),
          plan: valid,
          expected: 'TARGET_DIFFICULTY_CONFLICT'
        },
        {
          input: stygianInput({ excludedCharacterIds: ['1001'] }),
          plan: valid,
          expected: 'CHARACTER_EXCLUDED'
        },
        {
          input: stygianInput(),
          plan: {
            ...valid,
            phases: valid.phases.map((phase, index) =>
              index === 0
                ? {
                    ...phase,
                    team: {
                      ...phase.team,
                      characterIds: ['999999', ...phase.team.characterIds.slice(1)]
                    }
                  }
                : phase
            )
          },
          expected: 'CHARACTER_NOT_OWNED'
        },
        {
          input: stygianInput(),
          plan: { ...valid, phases: valid.phases.slice(0, 2) },
          expected: 'PHASE_COVERAGE_INVALID'
        },
        {
          input: stygianInput(),
          plan: {
            ...valid,
            phases: valid.phases.map((phase, index) =>
              index === 0 ? { ...phase, team: { ...phase.team, rotationNotes: [] } } : phase
            )
          },
          expected: 'PLAN_SCHEMA_INVALID'
        },
        {
          input: stygianInput(),
          plan: {
            ...valid,
            phases: valid.phases.map((phase, index) => {
              if (index !== 0) return phase;
              const teamWithoutEvidence = Object.fromEntries(
                Object.entries(phase.team).filter(([key]) => key !== 'rotationNotes')
              );
              return { ...phase, team: teamWithoutEvidence };
            })
          },
          expected: 'PLAN_SCHEMA_INVALID'
        }
      ] as const;

      for (const check of checks) {
        const result = validateStygianPlan({
          input: check.input,
          scenario,
          characters: STYGIAN_CHARACTERS,
          plan: check.plan
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.issues.map(({ code }) => code)).toContain(check.expected);
      }
    });

    it('keeps hard-constraint violation rate at zero for the three-party fallback', () => {
      const scenario = stygianScenario();
      const input = stygianInput({ target: 'dire-challenge', difficultyId: 'difficulty-6' });
      const result = buildLocalStygianPlan({
        input,
        scenario,
        characters: STYGIAN_CHARACTERS
      });
      expect(result.status).toBe('planned');
      if (result.status !== 'planned') return;
      expect(
        validateStygianPlan({
          input,
          scenario,
          characters: STYGIAN_CHARACTERS,
          plan: result.plan
        })
      ).toMatchObject({ ok: true, issues: [] });
    });
  });

  describe('Imaginarium Theater', () => {
    it('accepts source-aware actors and rejects eligibility, source, vigor, random, and unknown-ID violations', () => {
      const scenario = theaterScenario();
      const input = theaterInput();
      const valid = validTheaterPlan();
      expect(
        validateTheaterPlan({
          input,
          scenario,
          characters: THEATER_CHARACTERS,
          knowledge: THEATER_KNOWLEDGE,
          plan: valid
        })
      ).toMatchObject({ ok: true });

      const mutations = [
        {
          expected: 'CAST_ELIGIBILITY_INVALID',
          plan: {
            ...valid,
            cast: {
              ...valid.cast,
              selectedCharacterIds: valid.cast.selectedCharacterIds.slice(0, 7)
            }
          }
        },
        {
          expected: 'CAST_SOURCE_MISMATCH',
          plan: {
            ...valid,
            cast: { ...valid.cast, trialCharacterIds: ['unknown-trial'] }
          }
        },
        {
          expected: 'CANDIDATE_NOT_IN_CAST',
          plan: {
            ...valid,
            acts: valid.acts.map((act, index) =>
              index === 0
                ? {
                    ...act,
                    candidateCharacterIds: ['999999', ...act.candidateCharacterIds.slice(1)],
                    plannedVigorSpend: [
                      { characterId: '999999', cost: 1 },
                      ...act.plannedVigorSpend.slice(1)
                    ]
                  }
                : act
            )
          }
        },
        {
          expected: 'VIGOR_BUDGET_INVALID',
          plan: {
            ...valid,
            acts: valid.acts.map((act, index) =>
              index === 0
                ? {
                    ...act,
                    plannedVigorSpend: act.plannedVigorSpend.map((spend, spendIndex) =>
                      spendIndex === 0 ? { ...spend, cost: 2 } : spend
                    )
                  }
                : act
            )
          }
        },
        {
          expected: 'PATH_CHOICE_INVALID',
          plan: {
            ...valid,
            acts: valid.acts.map((act, index) =>
              index === 1
                ? { ...act, pathChoice: { kind: 'fixed' as const, note: '当作确定路线' } }
                : act
            )
          }
        }
      ] as const;

      for (const mutation of mutations) {
        const result = validateTheaterPlan({
          input,
          scenario,
          characters: THEATER_CHARACTERS,
          knowledge: THEATER_KNOWLEDGE,
          plan: mutation.plan
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.issues.map(({ code }) => code)).toContain(mutation.expected);
        }
      }
    });

    it('keeps source identity, per-character vigor and node budgets valid in the fallback', () => {
      const scenario = theaterScenario();
      const input = theaterInput({ selectedTrialCharacterIds: ['trial.1'] });
      const result = buildLocalTheaterPlan({
        input,
        scenario,
        characters: THEATER_CHARACTERS,
        knowledge: THEATER_KNOWLEDGE
      });
      expect(result.status).toBe('planned');
      if (result.status !== 'planned') return;
      expect(result.nodeBudget).toEqual(
        expect.arrayContaining([expect.objectContaining({ nodeId: 'node.1', cost: 1 })])
      );
      expect(result.vigorBudget).toHaveLength(
        result.plan.acts.reduce((sum, act) => sum + act.candidateCharacterIds.length, 0)
      );
      expect(
        validateTheaterPlan({
          input,
          scenario,
          characters: THEATER_CHARACTERS,
          knowledge: THEATER_KNOWLEDGE,
          plan: result.plan
        })
      ).toMatchObject({ ok: true });
    });
  });
});
