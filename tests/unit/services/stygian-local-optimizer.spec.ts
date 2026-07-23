import { describe, expect, it } from 'vitest';

import {
  assessStygianDifficultyEvidence,
  buildLocalStygianPlan
} from '../../../src/main/services/stygian-local-optimizer.js';
import type { CharacterKnowledgeReader } from '../../../src/shared/character-knowledge.js';
import type { CharacterProfile } from '../../../src/shared/domain.js';
import { STYGIAN_CHARACTERS, stygianInput, stygianScenario } from './stygian-test-fixtures.js';

function expandedRoster(size: number, options: { irrelevantScoreBoost?: boolean } = {}) {
  return Array.from({ length: size }, (_, index): CharacterProfile => {
    const base = STYGIAN_CHARACTERS[index % STYGIAN_CHARACTERS.length]!;
    const isOriginal = index < STYGIAN_CHARACTERS.length;
    return {
      ...base,
      id: isOriginal ? base.id : 2001 + index,
      name: isOriginal ? base.name : `扩展角色${index + 1}`,
      level: options.irrelevantScoreBoost && !isOriginal ? 100 : base.level,
      rarity: options.irrelevantScoreBoost && !isOriginal ? 5 : base.rarity,
      build: {
        ...base.build,
        stats: {
          ...base.build?.stats,
          atk: options.irrelevantScoreBoost && !isOriginal ? 9_999 : base.build?.stats?.atk,
          energyRecharge:
            options.irrelevantScoreBoost && !isOriginal ? 300 : base.build?.stats?.energyRecharge
        }
      },
      completeness:
        options.irrelevantScoreBoost && !isOriginal ? ('detailed' as const) : base.completeness
    };
  });
}

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

  it.each([14, 38, 80])(
    'keeps a %i-character roster synchronously bounded without losing forbidden-reuse feasibility',
    (rosterSize) => {
      const startedAt = performance.now();
      const result = buildLocalStygianPlan({
        input: stygianInput({ difficultyId: 'difficulty-3', target: 'primogems' }),
        scenario: stygianScenario(),
        characters: expandedRoster(rosterSize)
      });
      const durationMs = performance.now() - startedAt;

      expect(result.status).toBe('planned');
      expect(durationMs).toBeLessThan(1_000);
      if (result.status !== 'planned') throw new Error('Expected bounded plan');
      const ids = result.plan.phases.flatMap(({ team }) => team.characterIds);
      expect(ids).toHaveLength(12);
      expect(new Set(ids).size).toBe(12);
    },
    10_000
  );

  it('preserves the feasible solution when a larger roster adds unrelated higher-scoring roles', () => {
    const scenario = stygianScenario();
    scenario.phases[0]!.boss.mechanics.tags = ['requires-capability:bow'];
    scenario.phases[1]!.boss.mechanics.tags = ['requires-capability:claymore'];
    scenario.phases[2]!.boss.mechanics.tags = ['requires-capability:healing'];
    const specialistByRequirement = new Map([
      ['1001', { weaponType: 'bow' as const }],
      ['1002', { weaponType: 'claymore' as const }],
      ['1003', { capabilities: ['healing' as const] }]
    ]);
    const knowledge: CharacterKnowledgeReader = {
      version: 'specialist-test',
      coverage: { characterCount: 3, notes: 'Only the required specialists are known.' },
      lookup: (id) => {
        const specialist = specialistByRequirement.get(id);
        return specialist
          ? {
              status: 'known' as const,
              id,
              name: `专才${id}`,
              knowledgeVersion: 'specialist-test',
              ...specialist,
              unknownFields: specialist.weaponType
                ? ([
                    'roles',
                    'energyCost',
                    'energyNeeds',
                    'capabilities',
                    'applicationNotes',
                    'kitNotes'
                  ] as const)
                : ([
                    'weaponType',
                    'roles',
                    'energyCost',
                    'energyNeeds',
                    'applicationNotes',
                    'kitNotes'
                  ] as const)
            }
          : {
              status: 'unknown' as const,
              id,
              knowledgeVersion: 'specialist-test',
              unknownFields: [
                'weaponType',
                'roles',
                'energyCost',
                'energyNeeds',
                'capabilities',
                'applicationNotes',
                'kitNotes'
              ]
            };
      },
      coverageFor: (ids) => ({
        knowledgeVersion: 'specialist-test',
        requested: new Set(ids).size,
        known: ids.filter((id) => specialistByRequirement.has(id)).length,
        unknownCharacterIds: ids.filter((id) => !specialistByRequirement.has(id))
      })
    };
    const options = {
      input: stygianInput({ difficultyId: 'difficulty-3', target: 'primogems' as const }),
      scenario,
      knowledge
    };
    const baseline = buildLocalStygianPlan({ ...options, characters: expandedRoster(14) });
    const expanded = buildLocalStygianPlan({
      ...options,
      characters: expandedRoster(80, { irrelevantScoreBoost: true })
    });

    expect(baseline.status).toBe('planned');
    expect(expanded.status, JSON.stringify(expanded)).toBe('planned');
    if (expanded.status !== 'planned') throw new Error('Expected expanded plan');
    expect(expanded.plan.phases[0]!.team.characterIds).toContain('1001');
    expect(expanded.plan.phases[1]!.team.characterIds).toContain('1002');
    expect(expanded.plan.phases[2]!.team.characterIds).toContain('1003');
  });

  it('localizes every raw modifier before building player-facing guidance', () => {
    const scenario = stygianScenario();
    scenario.difficulties[2]!.modifiers = [
      { id: 'unknown-difficulty', description: 'Enemies gain increased resistance' }
    ];
    scenario.phases[0]!.phaseModifiers = [
      { id: 'phase_damage_up', description: 'phase_damage_up' }
    ];
    scenario.phases[0]!.bossModifiers = [
      { id: 'boss-internal-key', description: 'Boss gains increased resistance' }
    ];

    const result = buildLocalStygianPlan({
      input: stygianInput({ difficultyId: 'difficulty-3', target: 'primogems' }),
      scenario,
      characters: STYGIAN_CHARACTERS
    });

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected localized plan');
    expect(result.phaseGuidance[0]!.mechanismBasis).toContain('挑战修正暂无中文说明');
    expect(result.phaseGuidance[0]!.risks).toContain('挑战修正暂无中文说明');
    expect(JSON.stringify(result)).not.toMatch(
      /Enemies gain increased resistance|phase_damage_up|Boss gains/i
    );
  });
});

describe('assessStygianDifficultyEvidence', () => {
  const difficultyIdsByOrder = [
    'difficulty-1',
    'difficulty-2',
    'difficulty-3',
    'difficulty-4',
    'difficulty-5',
    'difficulty-6'
  ];

  it('never recommends outside the selected target range across all six difficulty orders', () => {
    const minimumOrder = {
      primogems: 1,
      'high-reward': 5,
      'dire-challenge': 6
    } as const;
    for (const target of ['primogems', 'high-reward', 'dire-challenge'] as const) {
      for (let order = minimumOrder[target]; order <= 6; order += 1) {
        const assessment = assessStygianDifficultyEvidence({
          difficultyOrder: order,
          target,
          difficultyIdsByOrder,
          selectedCharacters: STYGIAN_CHARACTERS.slice(6, 14)
        });
        if (!assessment.suggestedDifficultyId) {
          if (assessment.recommendation === 'lower-difficulty' && order === minimumOrder[target]) {
            expect(assessment.evidence.join('')).toContain('降低奖励目标');
          }
          continue;
        }
        const suggestedOrder = difficultyIdsByOrder.indexOf(assessment.suggestedDifficultyId) + 1;
        expect(suggestedOrder, `${target} order ${order}`).toBeGreaterThanOrEqual(
          minimumOrder[target]
        );
        expect(suggestedOrder, `${target} order ${order}`).toBeLessThan(order);
      }
    }
  });

  it('uses stricter evidence for the application high-reward goal than for primogems', () => {
    const common = {
      difficultyOrder: 5,
      difficultyIdsByOrder,
      selectedCharacters: STYGIAN_CHARACTERS.slice(0, 8).map((character) => ({
        ...character,
        level: 90,
        completeness: 'detailed' as const
      }))
    };
    const primogems = assessStygianDifficultyEvidence({ ...common, target: 'primogems' });
    const highReward = assessStygianDifficultyEvidence({ ...common, target: 'high-reward' });

    expect(primogems.recommendation).toBe('proceed-with-caution');
    expect(highReward.recommendation).toBe('lower-difficulty');
    expect(highReward.suggestedDifficultyId).toBeUndefined();
    expect(highReward.evidence.join('')).toContain('降低奖励目标');
  });

  it('uses auditable profile-evidence thresholds without claiming pass/fail', () => {
    const assessment = assessStygianDifficultyEvidence({
      difficultyOrder: 6,
      target: 'dire-challenge',
      difficultyIdsByOrder,
      selectedCharacters: STYGIAN_CHARACTERS.slice(6, 14)
    });
    expect(assessment.recommendation).toBe('lower-difficulty');
    expect(assessment.suggestedDifficultyId).toBeUndefined();
    expect(assessment.evidence.join('')).toContain('降低奖励目标');
    expect(assessment.evidence.join('')).toMatch(/资料|练度证据/);
    expect(assessment.evidence.join('')).not.toMatch(/必过|稳过/);
  });
});
