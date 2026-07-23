import type { CharacterProfile } from '../../../src/shared/domain.js';
import type {
  StygianAdvisorPlanInput,
  StygianScenario
} from '../../../src/shared/stygian-advisor.js';
import type { StygianOnslaughtScenario, StygianPlan } from '../../../src/shared/scenario-v2.js';
import { makeScenario } from '../scenario-publication/fixtures.js';

const elements = ['Pyro', 'Hydro', 'Anemo', 'Geo', 'Cryo', 'Electro', 'Dendro', 'Hydro'];

export const STYGIAN_CHARACTERS: CharacterProfile[] = Array.from({ length: 14 }, (_, index) => ({
  id: 1001 + index,
  name: `幽境角色${index + 1}`,
  element: elements[index % elements.length] ?? 'Unknown',
  rarity: index < 5 ? 5 : 4,
  imageUrl: '',
  level: 90 - (index % 10),
  build: {
    stats: {
      hp: 20_000 + index * 500,
      atk: 1_200 + index * 80,
      def: 700 + index * 10,
      critRate: 45 + index,
      critDmg: 90 + index * 4,
      energyRecharge: 110 + index * 5,
      elementalMastery: index * 15
    }
  },
  completeness: index < 8 ? 'detailed' : 'build',
  missingFields: index < 8 ? [] : ['weapon', 'artifacts', 'talents'],
  provenance: {
    ownership: { source: 'miyoushe-list', fetchedAt: '2026-07-23T00:00:00.000Z' },
    stats: { source: 'enka', fetchedAt: '2026-07-23T00:00:00.000Z' }
  }
}));

export function stygianScenario(
  options: {
    reuse?: StygianOnslaughtScenario['crossPartyReusePolicy'];
  } = {}
): StygianOnslaughtScenario {
  return buildStygianScenario(options, false) as StygianOnslaughtScenario;
}

export function developmentStygianScenario(
  options: {
    reuse?: StygianOnslaughtScenario['crossPartyReusePolicy'];
  } = {}
): Extract<StygianScenario, { meta: { syntheticProvenance: unknown } }> {
  return buildStygianScenario(options, true) as Extract<
    StygianScenario,
    { meta: { syntheticProvenance: unknown } }
  >;
}

function buildStygianScenario(
  options: { reuse?: StygianOnslaughtScenario['crossPartyReusePolicy'] },
  development: boolean
): StygianScenario {
  const base = makeScenario('stygian-onslaught', 'stygian-validator', '2026.07.1');
  if (base.mode !== 'stygian-onslaught') throw new Error('Expected Stygian scenario');
  const scenario = {
    ...base,
    id: development ? 'development.stygian.sample' : 'stygian.2026-07',
    crossPartyReusePolicy: options.reuse ?? { rule: 'forbidden' as const, notes: [] },
    difficulties: base.difficulties.map((difficulty, index) => ({
      ...difficulty,
      id: `difficulty-${index + 1}`,
      order: index + 1,
      name: {
        id: `difficulty.${index + 1}`,
        names: { 'zh-CN': `难度 ${index + 1}`, en: `Difficulty ${index + 1}` }
      },
      modifiers:
        index === 5
          ? [
              { id: 'time-window', description: '限时窗口更紧。' },
              { id: 'energy-pressure', description: '能量回复压力上升。' }
            ]
          : []
    })),
    phases: base.phases.map((phase, index) => ({
      ...phase,
      phase: index + 1,
      encounterId: `encounter-${index + 1}`,
      boss: {
        ...phase.boss,
        enemy: {
          id: `boss-${index + 1}`,
          names: { 'zh-CN': `试炼首领${index + 1}`, en: `Trial Boss ${index + 1}` }
        },
        mechanics: {
          shields: [],
          resistances: [],
          immunities: [],
          tags: []
        }
      },
      phaseModifiers: [{ id: `phase-rule-${index + 1}`, description: `阶段 ${index + 1} 机制。` }],
      bossModifiers: [{ id: `boss-rule-${index + 1}`, description: `首领 ${index + 1} 修正。` }]
    }))
  };
  if (!development) return scenario;
  return {
    ...scenario,
    meta: {
      schemaVersion: 2,
      dataVersion: 'development.2026-07.1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2026-02-01T00:00:00.000Z',
      reviewedAt: '2026-01-01T00:00:00.000Z',
      reviewedBy: 'development-reviewer',
      syntheticProvenance: {
        kind: 'synthetic-development-data',
        disclaimer: 'Synthetic test data only.',
        fields: [
          { fieldPath: 'meta.effectiveRange', note: 'Synthetic interval' },
          { fieldPath: 'scenario.phases', note: 'Synthetic phases' },
          { fieldPath: 'scenario.difficulties', note: 'Synthetic difficulties' },
          { fieldPath: 'scenario.reusePolicy', note: 'Synthetic reuse policy' }
        ]
      }
    }
  };
}

export function stygianInput(
  overrides: Omit<Partial<StygianAdvisorPlanInput>, 'target'> & { target?: unknown } = {}
): StygianAdvisorPlanInput {
  return {
    correlationId: 'stygian-test-request',
    uid: '123456789',
    scenarioId: 'stygian.2026-07',
    dataVersion: '2026.07.1',
    locale: 'zh-CN',
    difficultyId: 'difficulty-6',
    target: 'dire-challenge',
    preferences: {
      comfort: 'medium',
      survival: 'medium',
      lowInvestment: 'low',
      noBuildChange: true
    },
    lockedCharacterIds: [],
    excludedCharacterIds: [],
    ...overrides
  } as StygianAdvisorPlanInput;
}

export function validStygianPlan(overrides: Partial<StygianPlan> = {}): StygianPlan {
  return {
    mode: 'stygian-onslaught',
    schemaVersion: 2,
    scenarioId: 'stygian.2026-07',
    dataVersion: '2026.07.1',
    confidence: 'medium',
    warnings: [],
    assumptions: [],
    reusePolicyAcknowledgement: 'forbidden',
    phases: [1, 2, 3].map((phase, index) => ({
      phase,
      team: {
        id: `phase-${phase}`,
        characterIds: Array.from({ length: 4 }, (_, offset) => String(1001 + index * 4 + offset)),
        purpose: `处理阶段 ${phase} 的首领机制。`,
        rotationNotes: ['开局先布置辅助技能，再进入输出窗口。']
      }
    })),
    ...overrides
  };
}
