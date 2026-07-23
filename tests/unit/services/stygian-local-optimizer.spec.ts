import { describe, expect, it } from 'vitest';

import {
  assessStygianDifficultyEvidence,
  buildLocalStygianPlan
} from '../../../src/main/services/stygian-local-optimizer.js';
import type { CharacterKnowledgeReader } from '../../../src/shared/character-knowledge.js';
import { STYGIAN_CHARACTERS, stygianInput, stygianScenario } from './stygian-test-fixtures.js';

describe('buildLocalStygianPlan', () => {
  it('jointly builds three deterministic non-overlapping teams when reuse is forbidden', () => {
    const options = {
      input: stygianInput({ difficultyId: 'difficulty-3', target: 'primogems' as const }),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS
    };
    const first = buildLocalStygianPlan(options);
    const second = buildLocalStygianPlan(options);
    expect(second).toEqual(first);
    expect(first.status).toBe('planned');
    if (first.status !== 'planned') throw new Error('Expected plan');
    const ids = first.plan.phases.flatMap(({ team }) => team.characterIds);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('uses the scenario-owned allowed and limited reuse rules', () => {
    const fourCharacters = STYGIAN_CHARACTERS.slice(0, 4);
    const allowed = buildLocalStygianPlan({
      input: stygianInput({ difficultyId: 'difficulty-2', target: 'primogems' }),
      scenario: stygianScenario({ reuse: { rule: 'allowed', notes: [] } }),
      characters: fourCharacters
    });
    expect(allowed.status).toBe('planned');
    if (allowed.status !== 'planned') throw new Error('Expected allowed plan');
    expect(new Set(allowed.plan.phases.flatMap(({ team }) => team.characterIds)).size).toBe(4);

    const limitedScenario = stygianScenario({
      reuse: { rule: 'limited', maxPartyAppearancesPerCharacter: 2, notes: [] }
    });
    const insufficient = buildLocalStygianPlan({
      input: stygianInput({ difficultyId: 'difficulty-2', target: 'primogems' }),
      scenario: limitedScenario,
      characters: STYGIAN_CHARACTERS.slice(0, 5)
    });
    expect(insufficient).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'ROSTER_INSUFFICIENT' })])
    });
    expect(
      buildLocalStygianPlan({
        input: stygianInput({ difficultyId: 'difficulty-2', target: 'primogems' }),
        scenario: limitedScenario,
        characters: STYGIAN_CHARACTERS.slice(0, 6)
      }).status
    ).toBe('planned');
  });

  it('honors global locked and excluded characters without bypassing boss mechanics', () => {
    const scenario = stygianScenario();
    scenario.phases[0]!.boss.mechanics.shields = [{ element: 'pyro' }];
    const result = buildLocalStygianPlan({
      input: stygianInput({
        difficultyId: 'difficulty-3',
        target: 'primogems',
        lockedCharacterIds: ['1013'],
        excludedCharacterIds: ['1002']
      }),
      scenario,
      characters: STYGIAN_CHARACTERS
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected plan');
    expect(result.plan.phases.flatMap(({ team }) => team.characterIds)).toContain('1013');
    expect(result.plan.phases.flatMap(({ team }) => team.characterIds)).not.toContain('1002');
    const firstIds = result.plan.phases.find(({ phase }) => phase === 1)!.team.characterIds;
    const firstElements = firstIds.map(
      (id) => STYGIAN_CHARACTERS.find(({ id: numericId }) => String(numericId) === id)!.element
    );
    expect(firstElements).toContain('Hydro');
  });

  it('optimizes the joint assignment with phase and boss modifiers instead of taking the first feasible leaf', () => {
    const scenario = stygianScenario();
    scenario.difficulties[2]!.modifiers = [];
    scenario.phases[0]!.phaseModifiers = [
      { id: 'phase-energy', description: '本阶段能量压力显著。' }
    ];
    scenario.phases[0]!.bossModifiers = [
      { id: 'boss-energy', description: '首领要求快速充能循环。' }
    ];
    scenario.phases[1]!.phaseModifiers = [];
    scenario.phases[1]!.bossModifiers = [];
    scenario.phases[2]!.phaseModifiers = [];
    scenario.phases[2]!.bossModifiers = [];
    const characters = STYGIAN_CHARACTERS.slice(0, 12).map((character, index) => ({
      ...character,
      level: index >= 8 ? 60 : 90,
      completeness: 'build' as const,
      build: {
        ...character.build,
        stats: {
          ...character.build?.stats,
          energyRecharge: index >= 8 ? 220 : 100
        }
      }
    }));
    const result = buildLocalStygianPlan({
      input: stygianInput({ difficultyId: 'difficulty-3', target: 'primogems' }),
      scenario,
      characters
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected plan');
    expect(result.plan.phases[0]!.team.characterIds).toEqual(['1009', '1010', '1011', '1012']);
    expect(result.phaseGuidance[0]!.mechanismBasis.join('')).toContain('快速充能循环');
  });

  it('reports bounded-search exhaustion separately from actual infeasibility', () => {
    const result = buildLocalStygianPlan({
      input: stygianInput({ difficultyId: 'difficulty-3', target: 'primogems' }),
      scenario: stygianScenario(),
      characters: STYGIAN_CHARACTERS,
      searchStateBudget: 1
    });
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [expect.objectContaining({ code: 'SEARCH_BUDGET_EXCEEDED' })]
    });
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: 'ROSTER_INSUFFICIENT' })
    );
  });

  it('reports lock limits, unowned locks, and lock/exclude conflicts with distinct issues', () => {
    expect(
      buildLocalStygianPlan({
        input: stygianInput({
          lockedCharacterIds: STYGIAN_CHARACTERS.slice(0, 13).map(({ id }) => String(id))
        }),
        scenario: stygianScenario(),
        characters: STYGIAN_CHARACTERS
      })
    ).toMatchObject({ status: 'blocked', issues: [{ code: 'LOCK_LIMIT_EXCEEDED' }] });
    expect(
      buildLocalStygianPlan({
        input: stygianInput({ lockedCharacterIds: ['9999'] }),
        scenario: stygianScenario(),
        characters: STYGIAN_CHARACTERS
      })
    ).toMatchObject({ status: 'blocked', issues: [{ code: 'CHARACTER_NOT_OWNED' }] });
    expect(
      buildLocalStygianPlan({
        input: stygianInput({ lockedCharacterIds: ['1001'], excludedCharacterIds: ['1001'] }),
        scenario: stygianScenario(),
        characters: STYGIAN_CHARACTERS
      })
    ).toMatchObject({ status: 'blocked', issues: [{ code: 'LOCK_EXCLUDE_CONFLICT' }] });
  });

  it('surfaces a known required capability in the checked result guidance', () => {
    const scenario = stygianScenario();
    scenario.phases[0]!.boss.mechanics.tags = ['requires-capability:bow'];
    const knowledge: CharacterKnowledgeReader = {
      version: 'test',
      coverage: { characterCount: 1, notes: 'test' },
      lookup: (id) =>
        id === '1001'
          ? {
              status: 'known',
              id,
              name: '幽境角色1',
              knowledgeVersion: 'test',
              weaponType: 'bow',
              unknownFields: []
            }
          : {
              status: 'unknown',
              id,
              knowledgeVersion: 'test',
              unknownFields: ['weaponType']
            },
      coverageFor: (ids) => ({
        knowledgeVersion: 'test',
        requested: new Set(ids).size,
        known: ids.includes('1001') ? 1 : 0,
        unknownCharacterIds: ids.filter((id) => id !== '1001')
      })
    };
    const result = buildLocalStygianPlan({
      input: stygianInput({ difficultyId: 'difficulty-3', target: 'primogems' }),
      scenario,
      characters: STYGIAN_CHARACTERS,
      knowledge
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected plan');
    expect(result.phaseGuidance[0]!.mechanismBasis).toContain('需满足硬机制：弓角色');
  });

  it('blocks truly infeasible mechanics instead of manufacturing a party', () => {
    const scenario = stygianScenario();
    scenario.phases[1]!.boss.mechanics.shields = [{ element: 'pyro' }];
    const result = buildLocalStygianPlan({
      input: stygianInput({ difficultyId: 'difficulty-2', target: 'primogems' }),
      scenario,
      characters: STYGIAN_CHARACTERS.map((character) => ({ ...character, element: 'Pyro' }))
    });
    expect(result).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'MECHANIC_COVERAGE_INVALID' })
      ])
    });
  });
});

describe('assessStygianDifficultyEvidence', () => {
  it('uses auditable profile-evidence thresholds and recommends a lower tier without claiming pass/fail', () => {
    const assessment = assessStygianDifficultyEvidence({
      difficultyOrder: 6,
      target: 'dire-challenge',
      difficultyIdsByOrder: [
        'difficulty-1',
        'difficulty-2',
        'difficulty-3',
        'difficulty-4',
        'difficulty-5',
        'difficulty-6'
      ],
      selectedCharacters: STYGIAN_CHARACTERS.slice(6, 14)
    });
    expect(assessment.recommendation).toBe('lower-difficulty');
    expect(assessment.suggestedDifficultyId).toBe('difficulty-4');
    expect(assessment.evidence.join('')).toMatch(/资料|练度证据/);
    expect(assessment.evidence.join('')).not.toMatch(/必过|稳过/);
  });
});
