import type { CharacterProfile } from '../../../src/shared/domain.js';
import type { AbyssAdvisorPlanInput, AbyssPlanOutput } from '../../../src/shared/abyss-advisor.js';
import type { SpiralAbyssScenario } from '../../../src/shared/scenario-v2.js';
import { makeScenario } from '../scenario-publication/fixtures.js';

const elements = ['Pyro', 'Hydro', 'Anemo', 'Geo', 'Cryo', 'Electro', 'Dendro', 'Hydro'];

export const ABYSS_CHARACTERS: CharacterProfile[] = Array.from({ length: 10 }, (_, index) => ({
  id: 1001 + index,
  name: `测试角色${index + 1}`,
  element: elements[index] ?? 'Unknown',
  rarity: index < 4 ? 5 : 4,
  imageUrl: '',
  level: 90 - index,
  build: {
    stats: {
      hp: 20_000 + index * 1_000,
      atk: 1_200 + index * 100,
      def: 700 + index * 20,
      critRate: 50 + index,
      critDmg: 100 + index * 5,
      energyRecharge: 110 + index * 10,
      elementalMastery: index * 20
    }
  },
  completeness: index < 6 ? 'detailed' : 'build',
  missingFields: index < 6 ? [] : ['weapon', 'artifacts', 'talents'],
  provenance: {
    ownership: { source: 'miyoushe-list', fetchedAt: '2026-07-23T00:00:00.000Z' },
    stats: { source: 'enka', fetchedAt: '2026-07-23T00:00:00.000Z' }
  }
}));

export function abyssScenario(): SpiralAbyssScenario {
  const base = makeScenario('spiral-abyss', 'validator', '2026.07.1');
  if (base.mode !== 'spiral-abyss') throw new Error('Expected abyss scenario');
  const first = base.floors[0]?.chambers[0];
  if (!first) throw new Error('Expected chamber');
  return {
    ...base,
    id: 'abyss.2026-07',
    blessing: { id: 'blessing', description: '元素战技命中后提高全队伤害。' },
    floors: [
      {
        floor: 12,
        chambers: [
          {
            ...first,
            chamber: 1,
            targetSeconds: 180,
            firstHalf: {
              waves: [
                {
                  id: '12-1-first-wave-1',
                  enemies: [
                    {
                      enemy: {
                        id: 'training-hydra',
                        names: { 'zh-CN': '训练水兽', en: 'Training Hydra' }
                      },
                      level: 100,
                      count: 2,
                      mechanics: {
                        shields: [{ element: 'hydro', strength: 12 }],
                        resistances: [{ damageType: 'hydro', percent: 70 }],
                        immunities: [],
                        tags: ['多目标', '需要破水盾']
                      }
                    }
                  ]
                }
              ]
            },
            secondHalf: {
              waves: [
                {
                  id: '12-1-second-wave-1',
                  enemies: [
                    {
                      enemy: {
                        id: 'stone-sentinel',
                        names: { 'zh-CN': '石铸哨卫', en: 'Stone Sentinel' }
                      },
                      level: 100,
                      count: 1,
                      mechanics: {
                        shields: [],
                        resistances: [{ damageType: 'geo', percent: 50 }],
                        immunities: ['冻结'],
                        tags: ['单体', '高韧性']
                      }
                    }
                  ]
                }
              ]
            }
          },
          {
            ...first,
            chamber: 2,
            targetSeconds: 180,
            firstHalf: {
              waves: [
                {
                  id: '12-2-first-wave-1',
                  enemies: [
                    {
                      enemy: {
                        id: 'ember-runner',
                        names: { 'zh-CN': '焰行者', en: 'Ember Runner' }
                      },
                      level: 102,
                      count: 3,
                      mechanics: {
                        shields: [],
                        resistances: [{ damageType: 'pyro', percent: 50 }],
                        immunities: [],
                        tags: ['分散站位']
                      }
                    }
                  ]
                }
              ]
            },
            secondHalf: {
              waves: [
                {
                  id: '12-2-second-wave-1',
                  enemies: [
                    {
                      enemy: {
                        id: 'storm-eye',
                        names: { 'zh-CN': '风暴之眼', en: 'Storm Eye' }
                      },
                      level: 102,
                      count: 1,
                      mechanics: {
                        shields: [{ element: 'electro' }],
                        resistances: [],
                        immunities: ['雷元素伤害'],
                        tags: ['阶段转场']
                      }
                    }
                  ]
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

export function abyssInput(overrides: Partial<AbyssAdvisorPlanInput> = {}): AbyssAdvisorPlanInput {
  return {
    uid: '123456789',
    scenarioId: 'abyss.2026-07',
    dataVersion: '2026.07.1',
    floor: 12,
    preferences: {
      comfort: 'medium',
      survival: 'medium',
      lowInvestment: 'low',
      noBuildChange: true
    },
    lockedCharacterIds: [],
    excludedCharacterIds: [],
    ...overrides
  };
}

export function validAbyssPlan(overrides: Partial<AbyssPlanOutput> = {}): AbyssPlanOutput {
  return {
    mode: 'spiral-abyss',
    schemaVersion: 2,
    scenarioId: 'abyss.2026-07',
    dataVersion: '2026.07.1',
    confidence: 'medium',
    warnings: [],
    assumptions: ['未知角色职责未用于确定性结论。'],
    firstHalfTeam: {
      id: 'first-half',
      characterIds: ['1001', '1004', '1005', '1006'],
      purpose: '覆盖上半全部房间',
      rotationNotes: ['按充能情况调整技能顺序。']
    },
    secondHalfTeam: {
      id: 'second-half',
      characterIds: ['1002', '1003', '1007', '1008'],
      purpose: '覆盖下半全部房间',
      rotationNotes: ['保留关键技能处理转场。']
    },
    chambers: [1, 2].map((chamber) => ({
      floor: 12,
      chamber,
      firstHalf: {
        tactics: [`第 ${chamber} 间上半先处理机制目标。`],
        risks: ['输出窗口可能偏紧。'],
        substitutionNotes: ['调整后重新生成完整双队。']
      },
      secondHalf: {
        tactics: [`第 ${chamber} 间下半保留关键技能。`],
        risks: ['未知机制资料按保守策略处理。'],
        substitutionNotes: ['调整后重新生成完整双队。']
      }
    })),
    ...overrides
  };
}
