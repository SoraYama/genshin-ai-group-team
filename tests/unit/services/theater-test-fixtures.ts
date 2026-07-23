import type { CharacterProfile } from '../../../src/shared/domain.js';
import type { CharacterKnowledgeReader } from '../../../src/shared/character-knowledge.js';
import type {
  TheaterAdvisorPlanInput,
  TheaterScenario
} from '../../../src/shared/theater-advisor.js';
import type { ImaginariumTheaterScenario, TheaterPlan } from '../../../src/shared/scenario-v2.js';
import { makeScenario } from '../scenario-publication/fixtures.js';

const elements = [
  'Anemo',
  'Geo',
  'Anemo',
  'Geo',
  'Anemo',
  'Geo',
  'Anemo',
  'Geo',
  'Pyro',
  'Hydro',
  'Geo',
  'Anemo'
];

export const THEATER_CHARACTERS: CharacterProfile[] = Array.from({ length: 12 }, (_, index) => ({
  id: 1001 + index,
  name: `剧诗角色${index + 1}`,
  element: elements[index] ?? 'Unknown',
  rarity: index < 4 ? 5 : 4,
  imageUrl: '',
  level: index === 10 ? 60 : 90 - (index % 4) * 5,
  build: {
    stats: {
      hp: 18_000 + index * 500,
      atk: 1_100 + index * 70,
      def: 650 + index * 12,
      critRate: 40 + index,
      critDmg: 80 + index * 3,
      energyRecharge: 110 + index * 4,
      elementalMastery: index * 12
    }
  },
  completeness: index < 8 ? 'detailed' : 'build',
  missingFields: index < 8 ? [] : ['weapon', 'artifacts', 'talents'],
  provenance: {
    ownership: { source: 'miyoushe-list', fetchedAt: '2026-07-23T00:00:00.000Z' },
    stats: { source: 'enka', fetchedAt: '2026-07-23T00:00:00.000Z' }
  }
}));

export const THEATER_KNOWLEDGE: CharacterKnowledgeReader = {
  version: 'theater-test-knowledge',
  coverage: { characterCount: 1, notes: 'test' },
  lookup: (id) =>
    id === '1001'
      ? {
          status: 'known',
          knowledgeVersion: 'theater-test-knowledge',
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
          knowledgeVersion: 'theater-test-knowledge',
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
    knowledgeVersion: 'theater-test-knowledge',
    requested: new Set(ids).size,
    known: ids.includes('1001') ? 1 : 0,
    unknownCharacterIds: ids.filter((id) => id !== '1001')
  })
};

export function theaterScenario(): ImaginariumTheaterScenario {
  const base = makeScenario('imaginarium-theater', 'theater-validator', '2026.07.1');
  if (base.mode !== 'imaginarium-theater') throw new Error('Expected Theater scenario');
  return {
    ...base,
    id: 'theater.2026-07',
    eligibility: { elements: ['anemo', 'geo'], minimumLevel: 70, requiredHeadcount: 8 },
    pools: {
      opening: [{ id: '1001', names: { 'zh-CN': '开幕角色一', en: 'Opening One' } }],
      trial: [{ id: 'trial.1', names: { 'zh-CN': '试用演员一', en: 'Trial One' } }],
      specialGuest: [{ id: '1009', names: { 'zh-CN': '特邀角色一', en: 'Guest One' } }],
      support: [{ id: 'support.1', names: { 'zh-CN': '支援演员一', en: 'Support One' } }]
    },
    vigor: {
      initial: 2,
      max: 4,
      actCosts: [
        { act: 1, cost: 1 },
        { act: 2, cost: 1 }
      ],
      nodeCosts: [{ nodeId: 'node.1', cost: 1 }]
    },
    acts: [
      {
        act: 1,
        encounters: base.acts[0]!.encounters.map((encounter) => ({
          ...encounter,
          id: 'act-1-encounter',
          waves: encounter.waves.map((wave) => ({
            ...wave,
            enemies: wave.enemies.map((enemy) => ({
              ...enemy,
              mechanics: { ...enemy.mechanics, tags: ['requires-capability:grouping'] }
            }))
          }))
        })),
        pathNotes: [{ kind: 'conditional', text: '遇到群怪时优先聚怪', condition: '出现分散群怪' }]
      },
      {
        act: 2,
        encounters: base.acts[0]!.encounters.map((encounter) => ({
          ...encounter,
          id: 'act-2-encounter'
        })),
        pathNotes: [{ kind: 'random', text: '随机路线只能给出应变策略' }]
      }
    ],
    arcanaNodes: [
      {
        id: 'node.1',
        name: { id: 'arcana.node.1', names: { 'zh-CN': '聚敌增益', en: 'Grouping Boon' } },
        description: '为分散敌人提供应对窗口。',
        pathNotes: [{ kind: 'conditional', text: '缺少聚怪时优先', condition: '演员没有聚怪能力' }]
      }
    ]
  };
}

export function theaterInput(
  overrides: Omit<Partial<TheaterAdvisorPlanInput>, 'target'> & { target?: unknown } = {}
): TheaterAdvisorPlanInput {
  return {
    correlationId: 'theater-test-request',
    uid: '123456789',
    scenarioId: 'theater.2026-07',
    dataVersion: '2026.07.1',
    target: 'safe-clear',
    preferences: {
      comfort: 'medium',
      survival: 'medium',
      lowInvestment: 'low',
      noBuildChange: true
    },
    selectedCharacterIds: [],
    excludedCharacterIds: [],
    selectedOpeningCharacterIds: [],
    selectedTrialCharacterIds: [],
    selectedSpecialGuestCharacterIds: [],
    selectedSupportCharacterIds: [],
    ...overrides
  } as TheaterAdvisorPlanInput;
}

export function validTheaterPlan(overrides: Partial<TheaterPlan> = {}): TheaterPlan {
  return {
    mode: 'imaginarium-theater',
    schemaVersion: 2,
    scenarioId: 'theater.2026-07',
    dataVersion: '2026.07.1',
    confidence: 'medium',
    warnings: [],
    assumptions: [],
    cast: {
      openingCharacterIds: [],
      selectedCharacterIds: Array.from({ length: 8 }, (_, index) => String(1001 + index)),
      trialCharacterIds: [],
      specialGuestCharacterIds: [],
      supportCharacterIds: []
    },
    acts: [
      {
        act: 1,
        candidateCharacterIds: ['1001', '1002', '1003', '1004'],
        plannedVigorSpend: ['1001', '1002', '1003', '1004'].map((characterId) => ({
          characterId,
          cost: 1
        })),
        pathChoice: { kind: 'conditional', note: '如果群怪分散，优先聚怪路线。' }
      },
      {
        act: 2,
        candidateCharacterIds: ['1005', '1006', '1007', '1008'],
        plannedVigorSpend: ['1005', '1006', '1007', '1008'].map((characterId) => ({
          characterId,
          cost: 1
        })),
        pathChoice: { kind: 'random', note: '随机结果确定后，再按敌人类型选择应对分支。' }
      }
    ],
    ...overrides
  };
}

export function asTheaterScenario(value: ImaginariumTheaterScenario): TheaterScenario {
  return value;
}
