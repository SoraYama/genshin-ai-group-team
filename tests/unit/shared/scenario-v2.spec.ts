import { describe, expect, it } from 'vitest';

import {
  abyssPlanSchema,
  imaginariumTheaterScenarioSchema,
  playerInterventionSchema,
  recommendationPlanSchema,
  scenarioV2Schema,
  spiralAbyssScenarioSchema,
  stygianOnslaughtScenarioSchema,
  stygianPlanSchema,
  theaterPlanSchema
} from '../../../src/shared/scenario-v2';

const sourceRef = {
  id: 'official-2026-07-01',
  source: 'official-announcement' as const,
  url: 'https://example.com/announcement',
  retrievedAt: '2026-07-01T00:00:00.000Z'
};

const meta = {
  schemaVersion: 2 as const,
  dataVersion: '2026.07.1',
  effectiveFrom: '2026-07-01T00:00:00.000Z',
  effectiveTo: '2026-08-01T00:00:00.000Z',
  sourceRefs: [sourceRef],
  staleStatus: 'fresh' as const,
  reviewedAt: '2026-07-01T01:00:00.000Z',
  reviewedBy: 'content-reviewer',
  manifest: {
    algorithm: 'sha256' as const,
    hash: 'a'.repeat(64),
    signature: 'release-signature'
  }
};

const entity = (id: string, zhName: string) => ({
  id,
  names: { 'zh-CN': zhName, en: id }
});

const enemy = {
  enemy: entity('enemy.hilichurl', '丘丘人'),
  level: 100,
  count: 2,
  mechanics: {
    shields: [{ element: 'pyro', strength: 12 }],
    resistances: [{ damageType: 'physical', percent: 10 }],
    immunities: ['frozen'],
    tags: ['groupable', 'lightweight']
  }
};

const wave = (id: string) => ({ id, enemies: [enemy] });

const team = (id: string, characterIds: string[]) => ({
  id,
  characterIds,
  purpose: '稳定完成目标'
});

const commonPlan = {
  scenarioId: 'scenario.current',
  dataVersion: meta.dataVersion,
  confidence: 'high' as const,
  warnings: [],
  assumptions: ['角色状态以最近一次本地资料为准']
};

describe('scenario v2 mode schemas', () => {
  it('accepts arbitrary configured Spiral Abyss floors with halves and waves', () => {
    const result = spiralAbyssScenarioSchema.safeParse({
      mode: 'spiral-abyss',
      id: 'abyss.2026-07',
      meta,
      floors: [
        {
          floor: 13,
          chambers: [
            {
              chamber: 1,
              firstHalf: { waves: [wave('13-1-a-1')] },
              secondHalf: { waves: [wave('13-1-b-1'), wave('13-1-b-2')] }
            }
          ]
        }
      ]
    });

    expect(result.success).toBe(true);
    expect(scenarioV2Schema.safeParse(result.data).success).toBe(true);
  });

  it('accepts Stygian Onslaught with three phases, six difficulties, and a data-owned reuse rule', () => {
    const result = stygianOnslaughtScenarioSchema.safeParse({
      mode: 'stygian-onslaught',
      id: 'stygian.2026-07',
      meta,
      crossPartyReusePolicy: {
        rule: 'limited',
        maxPartyAppearancesPerCharacter: 2,
        notes: ['同一角色至多参与两场首领战']
      },
      difficulties: Array.from({ length: 6 }, (_, index) => ({
        id: `difficulty-${index + 1}`,
        order: index + 1,
        name: entity(`difficulty.${index + 1}`, `难度 ${index + 1}`),
        modifiers: [{ id: 'time-limit', description: '限时挑战' }]
      })),
      phases: Array.from({ length: 3 }, (_, index) => ({
        phase: index + 1,
        boss: {
          enemy: entity(`boss.${index + 1}`, `首领 ${index + 1}`),
          level: 110,
          count: 1,
          mechanics: { shields: [], resistances: [], immunities: [], tags: ['boss'] }
        },
        phaseModifiers: [{ id: 'phase-rule', description: '阶段规则' }],
        bossModifiers: [{ id: 'boss-rule', description: '首领强化' }]
      }))
    });

    expect(result.success).toBe(true);
    expect(scenarioV2Schema.safeParse(result.data).success).toBe(true);
  });

  it('accepts Imaginarium Theater eligibility, cast pools, vigor, and branching path notes', () => {
    const result = imaginariumTheaterScenarioSchema.safeParse({
      mode: 'imaginarium-theater',
      id: 'theater.2026-07',
      meta,
      eligibility: {
        elements: ['pyro', 'hydro', 'anemo'],
        minimumLevel: 70,
        requiredHeadcount: 22
      },
      pools: {
        opening: [entity('character.opening', '开幕角色')],
        trial: [entity('character.trial', '试用角色')],
        specialGuest: [entity('character.guest', '特邀角色')],
        support: [entity('character.support', '助演角色')]
      },
      vigor: { initial: 2, max: 4, actCosts: [{ act: 1, cost: 1 }] },
      acts: [
        {
          act: 1,
          encounters: [{ id: 'act-1-battle', waves: [wave('act-1-wave-1')] }],
          pathNotes: [
            { kind: 'conditional', text: '若缺少治疗则优先恢复事件', condition: '无生存位' },
            { kind: 'random', text: '候选事件由本局随机生成' }
          ]
        }
      ],
      arcanaNodes: [
        { id: 'arcana-1', name: entity('arcana.1', '秘法节点'), description: '改变后续路线' }
      ]
    });

    expect(result.success).toBe(true);
    expect(scenarioV2Schema.safeParse(result.data).success).toBe(true);
  });

  it('rejects Stygian Onslaught unless it has exactly three phases', () => {
    const invalid = {
      mode: 'stygian-onslaught',
      id: 'stygian.invalid',
      meta,
      crossPartyReusePolicy: { rule: 'forbidden' },
      difficulties: Array.from({ length: 6 }, (_, index) => ({
        id: `difficulty-${index + 1}`,
        order: index + 1,
        name: entity(`difficulty.${index + 1}`, `难度 ${index + 1}`),
        modifiers: []
      })),
      phases: [
        {
          phase: 1,
          boss: enemy,
          phaseModifiers: [],
          bossModifiers: []
        },
        {
          phase: 2,
          boss: enemy,
          phaseModifiers: [],
          bossModifiers: []
        }
      ]
    };

    expect(scenarioV2Schema.safeParse(invalid).success).toBe(false);
  });

  it('rejects Theater acts above the current act 10 ceiling', () => {
    const invalid = {
      mode: 'imaginarium-theater',
      id: 'theater.invalid',
      meta,
      eligibility: { elements: ['pyro'], minimumLevel: 70, requiredHeadcount: 10 },
      pools: { opening: [], trial: [], specialGuest: [], support: [] },
      vigor: { initial: 2, max: 4, actCosts: [] },
      acts: [{ act: 11, encounters: [], pathNotes: [] }]
    };

    expect(imaginariumTheaterScenarioSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects metadata whose effective end precedes its start', () => {
    const result = spiralAbyssScenarioSchema.safeParse({
      mode: 'spiral-abyss',
      id: 'abyss.invalid-dates',
      meta: {
        ...meta,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z'
      },
      floors: []
    });

    expect(result.success).toBe(false);
  });
});

describe('scenario v2 recommendation plan schemas', () => {
  it('accepts an Abyss plan with two non-overlapping teams per chamber', () => {
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...commonPlan,
      chambers: [
        {
          floor: 12,
          chamber: 1,
          firstHalf: team('first', ['a', 'b', 'c', 'd']),
          secondHalf: team('second', ['e', 'f', 'g', 'h'])
        }
      ]
    });

    expect(result.success).toBe(true);
    expect(recommendationPlanSchema.safeParse(result.data).success).toBe(true);
  });

  it('accepts a three-party Stygian plan with explicit reuse-policy acknowledgement', () => {
    const result = stygianPlanSchema.safeParse({
      mode: 'stygian-onslaught',
      ...commonPlan,
      reusePolicyAcknowledgement: 'limited',
      phases: [
        { phase: 1, team: team('phase-1', ['a', 'b', 'c', 'd']) },
        { phase: 2, team: team('phase-2', ['a', 'e', 'f', 'g']) },
        { phase: 3, team: team('phase-3', ['h', 'i', 'j', 'k']) }
      ]
    });

    expect(result.success).toBe(true);
    expect(recommendationPlanSchema.safeParse(result.data).success).toBe(true);
  });

  it('accepts a Theater cast and path plan instead of a fixed four-character team', () => {
    const result = theaterPlanSchema.safeParse({
      mode: 'imaginarium-theater',
      ...commonPlan,
      cast: {
        openingCharacterIds: ['a', 'b'],
        selectedCharacterIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        trialCharacterIds: ['c'],
        specialGuestCharacterIds: ['d'],
        supportCharacterIds: ['e']
      },
      acts: [
        {
          act: 1,
          candidateCharacterIds: ['a', 'b', 'c'],
          plannedVigorSpend: [{ characterId: 'a', cost: 1 }],
          pathChoice: { kind: 'conditional', note: '若出现精英战则保留主力' }
        }
      ]
    });

    expect(result.success).toBe(true);
    expect(recommendationPlanSchema.safeParse(result.data).success).toBe(true);
  });

  it('rejects an Abyss plan that reuses a character across chamber halves', () => {
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...commonPlan,
      chambers: [
        {
          floor: 12,
          chamber: 1,
          firstHalf: team('first', ['shared', 'b', 'c', 'd']),
          secondHalf: team('second', ['shared', 'f', 'g', 'h'])
        }
      ]
    });

    expect(result.success).toBe(false);
  });
});

describe('structured player intervention', () => {
  it('rejects overlapping locked and excluded characters', () => {
    const result = playerInterventionSchema.safeParse({
      lockedCharacterIds: ['character.raiden'],
      excludedCharacterIds: ['character.raiden'],
      target: { mode: 'spiral-abyss', floor: 12, chamber: 3 },
      preferences: {
        comfort: 'high',
        survival: 'high',
        lowInvestment: 'medium',
        noBuildChange: true
      }
    });

    expect(result.success).toBe(false);
  });
});
