import type { PublishedScenarioFieldPath, ScenarioV2 } from '../../../src/shared/scenario-v2.js';

const publishedSource = {
  id: 'development-sample-source',
  source: 'genshin-db' as const,
  retrievedAt: '2026-01-01T00:00:00.000Z',
  attribution: 'Original development-only fixture data'
};

const metadata = (mode: ScenarioV2['mode'], dataVersion = 'dev.2') => ({
  schemaVersion: 2 as const,
  dataVersion,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: '2026-02-01T00:00:00.000Z',
  sourceRefs: [publishedSource],
  fieldProvenance: (
    (mode === 'spiral-abyss'
      ? ['meta.effectiveRange', 'scenario.floors', 'scenario.blessing']
      : mode === 'stygian-onslaught'
        ? [
            'meta.effectiveRange',
            'scenario.phases',
            'scenario.difficulties',
            'scenario.reusePolicy'
          ]
        : [
            'meta.effectiveRange',
            'scenario.eligibility',
            'scenario.cast',
            'scenario.nodes',
            'scenario.vigor'
          ]) as PublishedScenarioFieldPath[]
  ).map((fieldPath) => ({ fieldPath, sourceRefId: publishedSource.id })),
  reviewedAt: '2026-01-01T01:00:00.000Z',
  reviewedBy: 'development-fixture-reviewer'
});

const entity = (id: string, name: string) => ({ id, names: { 'zh-CN': name, en: id } });

const mechanics = {
  shields: [],
  resistances: [],
  immunities: [],
  tags: ['development-sample']
};

const enemy = (id: string, name: string) => ({
  enemy: entity(id, name),
  level: 100,
  count: 1,
  mechanics
});

export function makeScenario(
  mode: ScenarioV2['mode'],
  suffix = 'current',
  dataVersion = 'dev.2'
): ScenarioV2 {
  if (mode === 'spiral-abyss') {
    return {
      mode,
      id: `development.${mode}.${suffix}`,
      meta: metadata(mode, dataVersion),
      blessing: { id: 'development-blessing', description: '仅用于开发演示的原创效果' },
      floors: [
        {
          floor: 12,
          chambers: [
            {
              chamber: 1,
              firstHalf: {
                waves: [{ id: 'first-wave', enemies: [enemy('training-sprite', '训练灵体')] }]
              },
              secondHalf: {
                waves: [{ id: 'second-wave', enemies: [enemy('stone-sentinel', '石铸哨卫')] }]
              }
            }
          ]
        }
      ]
    };
  }

  if (mode === 'stygian-onslaught') {
    return {
      mode,
      id: `development.${mode}.${suffix}`,
      meta: metadata(mode, dataVersion),
      crossPartyReusePolicy: { rule: 'forbidden', notes: ['开发样例规则，不代表正式服'] },
      difficulties: Array.from({ length: 6 }, (_, index) => ({
        id: `development-difficulty-${index + 1}`,
        order: index + 1,
        name: entity(`difficulty-${index + 1}`, `演示难度 ${index + 1}`),
        modifiers: [{ id: `difficulty-modifier-${index + 1}`, description: '开发样例修正' }]
      })),
      phases: Array.from({ length: 3 }, (_, index) => ({
        phase: index + 1,
        encounterId: `development-encounter-${index + 1}`,
        boss: enemy(`development-boss-${index + 1}`, `演示首领 ${index + 1}`),
        phaseModifiers: [{ id: `phase-modifier-${index + 1}`, description: '开发样例阶段规则' }],
        bossModifiers: [{ id: `boss-modifier-${index + 1}`, description: '开发样例首领规则' }]
      }))
    };
  }

  return {
    mode,
    id: `development.${mode}.${suffix}`,
    meta: metadata(mode, dataVersion),
    eligibility: { elements: ['anemo', 'geo'], minimumLevel: 70, requiredHeadcount: 8 },
    pools: {
      opening: [entity('development-opening', '演示开幕角色')],
      trial: [entity('development-trial', '演示试用角色')],
      specialGuest: [entity('development-guest', '演示特邀角色')],
      support: [entity('development-support', '演示助演角色')]
    },
    vigor: { initial: 2, max: 4, actCosts: [{ act: 1, cost: 1 }], nodeCosts: [] },
    acts: [
      {
        act: 1,
        encounters: [
          {
            id: 'development-act-1',
            waves: [
              { id: 'development-theater-wave', enemies: [enemy('paper-phantom', '纸页幻影')] }
            ]
          }
        ],
        pathNotes: [{ kind: 'random', text: '开发样例中的随机分支' }]
      }
    ],
    arcanaNodes: []
  };
}
