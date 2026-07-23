import { describe, expect, it } from 'vitest';

import { buildLocalTheaterPlan } from '../../../src/main/services/theater-local-planner.js';
import type { CharacterKnowledgeReader } from '../../../src/shared/character-knowledge.js';
import { THEATER_CHARACTERS, theaterInput, theaterScenario } from './theater-test-fixtures.js';

const knowledge: CharacterKnowledgeReader = {
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

describe('buildLocalTheaterPlan', () => {
  it('is deterministic and emits a cast route instead of fixed teams', () => {
    const options = {
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge
    };
    const first = buildLocalTheaterPlan(options);
    const second = buildLocalTheaterPlan(options);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'planned', source: 'local-rules' });
    if (first.status !== 'planned') throw new Error('Expected planned');
    expect(first.plan).not.toHaveProperty('teams');
    expect(first.plan.cast.selectedCharacterIds).toHaveLength(9);
    expect(first.plan.acts[0]?.candidateCharacterIds).toContain('1001');
    expect(first.routeGuidance.preserveCharacterIds).toContain('1001');
  });

  it('keeps every act within the cumulative vigor budget and uses conditional wording for random paths', () => {
    const result = buildLocalTheaterPlan({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge
    });
    if (result.status !== 'planned') throw new Error('Expected planned');
    expect(result.vigorBudget).toHaveLength(8);
    expect(result.vigorBudget.every(({ before, spent, after }) => before - spent === after)).toBe(
      true
    );
    expect(result.vigorBudget.every(({ characterId }) => /^\d+$/.test(characterId))).toBe(true);
    expect(result.plan.acts[1]?.pathChoice.kind).toBe('conditional');
    expect(result.plan.acts[1]?.pathChoice.note).toContain('如果');
  });

  it('blocks with construction advice when hard eligibility is short', () => {
    const result = buildLocalTheaterPlan({
      input: theaterInput({ selectedTrialCharacterIds: ['trial.1'] }),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS.slice(0, 7),
      knowledge
    });
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [expect.objectContaining({ code: 'ROSTER_INSUFFICIENT' })],
      eligibility: { shortage: 1 }
    });
  });

  it('returns a bounded validated act plan for a selected act', () => {
    const result = buildLocalTheaterPlan({
      input: theaterInput({ act: 1 }),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected planned');
    expect(result.plan.acts.map(({ act }) => act)).toEqual([1]);
  });

  it('blocks instead of treating a missing target-act vigor cost as zero', () => {
    const scenario = theaterScenario();
    scenario.vigor.actCosts = scenario.vigor.actCosts.filter(({ act }) => act !== 2);
    const result = buildLocalTheaterPlan({
      input: theaterInput(),
      scenario,
      characters: THEATER_CHARACTERS,
      knowledge
    });
    expect(result).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'VIGOR_BUDGET_INVALID' })])
    });
  });

  it('routes a selected external actor with an explicit source instead of leaving it unused', () => {
    const result = buildLocalTheaterPlan({
      input: theaterInput({ selectedTrialCharacterIds: ['trial.1'] }),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected planned');
    expect(result.plan.cast.trialCharacterIds).toEqual(['trial.1']);
    expect(
      result.plan.acts.flatMap(({ candidateCharacterIds }) => candidateCharacterIds)
    ).toContain('trial.1');
    expect(result.vigorBudget).toContainEqual(
      expect.objectContaining({ characterId: 'trial.1', spent: 1 })
    );
  });

  it('treats an act with no declared branch notes as a fixed no-branch route', () => {
    const scenario = theaterScenario();
    scenario.acts[0]!.pathNotes = [];
    const result = buildLocalTheaterPlan({
      input: theaterInput(),
      scenario,
      characters: THEATER_CHARACTERS,
      knowledge
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected planned');
    expect(result.plan.acts[0]?.pathChoice).toMatchObject({ kind: 'fixed' });
  });

  it('keeps a mixed fixed and random path conditional instead of claiming certainty', () => {
    const scenario = theaterScenario();
    scenario.acts[0]!.pathNotes = [
      { kind: 'fixed', text: '先完成当前战斗。' },
      { kind: 'random', text: '之后节点随机揭示。' }
    ];
    const result = buildLocalTheaterPlan({
      input: theaterInput(),
      scenario,
      characters: THEATER_CHARACTERS,
      knowledge
    });

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected planned');
    expect(result.plan.acts[0]?.pathChoice).toMatchObject({ kind: 'conditional' });
    expect(result.plan.acts[0]?.pathChoice.note).toContain('随机');
  });

  it('orders Arcana by declared path certainty and snapshots only known node costs', () => {
    const scenario = theaterScenario();
    scenario.arcanaNodes = [
      {
        id: 'node.random',
        name: { id: 'arcana.random', names: { 'zh-CN': '随机回响' } },
        description: '仅在随机揭示后考虑。',
        pathNotes: [{ kind: 'random', text: '节点可能不会出现。' }]
      },
      ...scenario.arcanaNodes!,
      {
        id: 'node.unknown-cost',
        name: { id: 'arcana.unknown', names: { 'zh-CN': '未定花费' } },
        description: '资料没有给出资源消耗。',
        pathNotes: [{ kind: 'fixed', text: '节点效果已知。' }]
      }
    ];
    scenario.vigor.nodeCosts.push({ nodeId: 'node.random', cost: 2 });

    const result = buildLocalTheaterPlan({
      input: theaterInput(),
      scenario,
      characters: THEATER_CHARACTERS,
      knowledge
    });

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected planned');
    expect(result.routeGuidance.arcanaPriorityIds).toEqual(['node.1', 'node.random']);
    expect(result.routeGuidance.arcanaPriorities).toEqual([
      expect.objectContaining({
        nodeId: 'node.1',
        name: '聚敌增益',
        condition: '演员没有聚怪能力',
        reason: '缺少聚怪时优先'
      }),
      expect.objectContaining({
        nodeId: 'node.random',
        name: '随机回响',
        condition: '随机出现该节点时',
        reason: '节点可能不会出现。'
      })
    ]);
    expect(result.nodeBudget).toEqual([
      { nodeId: 'node.1', cost: 1 },
      { nodeId: 'node.random', cost: 2 }
    ]);
    expect(result.warnings.join('')).toContain('未定花费');
    expect(result.routeGuidance.arcanaPriorityIds).not.toContain('node.unknown-cost');
  });

  it('uses a fresh mechanism substitute when the first actor has no remaining vigor', () => {
    const scenario = theaterScenario();
    scenario.vigor.initial = 1;
    scenario.vigor.max = 1;
    scenario.acts[1]!.encounters[0]!.waves[0]!.enemies[0]!.mechanics.tags = [
      'requires-capability:grouping'
    ];
    const replacementKnowledge: CharacterKnowledgeReader = {
      ...knowledge,
      lookup: (id) =>
        id === '1001' || id === '1002'
          ? {
              status: 'known',
              knowledgeVersion: 'test',
              id,
              name: `剧诗角色${id === '1001' ? '1' : '2'}`,
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
          : knowledge.lookup(id),
      coverageFor: (ids) => ({
        knowledgeVersion: 'test',
        requested: new Set(ids).size,
        known: ids.filter((id) => id === '1001' || id === '1002').length,
        unknownCharacterIds: ids.filter((id) => id !== '1001' && id !== '1002')
      })
    };

    const result = buildLocalTheaterPlan({
      input: theaterInput(),
      scenario,
      characters: THEATER_CHARACTERS,
      knowledge: replacementKnowledge
    });

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected planned');
    expect(result.plan.acts[0]?.candidateCharacterIds).toContain('1001');
    expect(result.plan.acts[1]?.candidateCharacterIds).toContain('1002');
    expect(result.plan.acts[1]?.candidateCharacterIds).not.toContain('1001');
  });

  it('does not spend every known mechanism substitute as optional filler', () => {
    const scenario = theaterScenario();
    scenario.eligibility.requiredHeadcount = 4;
    scenario.vigor.initial = 1;
    scenario.vigor.max = 1;
    scenario.acts[1]!.encounters[0]!.waves[0]!.enemies[0]!.mechanics.tags = [
      'requires-capability:grouping'
    ];
    const allGrouping: CharacterKnowledgeReader = {
      ...knowledge,
      lookup: (id) => ({
        status: 'known',
        knowledgeVersion: 'test',
        id,
        name: `剧诗角色${id}`,
        capabilities: ['grouping'],
        unknownFields: [
          'weaponType',
          'roles',
          'energyCost',
          'energyNeeds',
          'applicationNotes',
          'kitNotes'
        ]
      }),
      coverageFor: (ids) => ({
        knowledgeVersion: 'test',
        requested: new Set(ids).size,
        known: new Set(ids).size,
        unknownCharacterIds: []
      })
    };

    const result = buildLocalTheaterPlan({
      input: theaterInput(),
      scenario,
      characters: THEATER_CHARACTERS.slice(0, 4),
      knowledge: allGrouping
    });

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('Expected planned');
    expect(result.plan.acts[0]?.candidateCharacterIds).toEqual(['1001']);
    expect(result.plan.acts[1]?.candidateCharacterIds).toEqual(['1002']);
  });

  it('blocks immediately when an exhausted mechanism actor has no viable substitute', () => {
    const scenario = theaterScenario();
    scenario.vigor.initial = 1;
    scenario.vigor.max = 1;
    scenario.acts[1]!.encounters[0]!.waves[0]!.enemies[0]!.mechanics.tags = [
      'requires-capability:grouping'
    ];

    const result = buildLocalTheaterPlan({
      input: theaterInput(),
      scenario,
      characters: THEATER_CHARACTERS,
      knowledge
    });

    expect(result).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'MECHANIC_COVERAGE_INVALID',
          details: expect.objectContaining({ act: 2, requirement: 'grouping' })
        })
      ])
    });
  });
});
