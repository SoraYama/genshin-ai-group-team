import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../src/shared/domain.js';
import {
  AdvisorOrchestrator,
  type AgentQueryRunner
} from '../../src/main/services/advisor-orchestrator.js';

const rosterModes = [
  { name: 'full', partial: false },
  { name: 'partial-detail', partial: true },
  { name: 'no-enka', partial: true },
  { name: 'basic-only', partial: true },
  { name: 'mixed-provenance', partial: true }
] as const;
const enemyModes = [
  'no-enemy',
  'pyro-immune',
  'cryo-shield',
  'energy-drain',
  'multi-target',
  'single-boss'
] as const;

const cases = rosterModes.flatMap((roster) =>
  enemyModes.map((enemy) => ({
    name: `${roster.name}/${enemy}`,
    partial: roster.partial,
    enemy
  }))
);

const characters: CharacterProfile[] = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1,
  name: `Owned ${index + 1}`,
  element: ['Pyro', 'Hydro', 'Anemo', 'Geo', 'Cryo', 'Electro', 'Dendro', 'Hydro'][index]!,
  rarity: index < 4 ? 5 : 4,
  imageUrl: '',
  level: 80,
  completeness: 'basic',
  missingFields: ['stats', 'weapon', 'artifacts', 'talents'],
  provenance: { ownership: { source: 'miyoushe-list', fetchedAt: '2026-01-01T00:00:00Z' } }
}));

class EvalRunner implements AgentQueryRunner {
  calls = 0;
  constructor(private readonly outputs: unknown[]) {}
  async *run(): AsyncIterable<unknown> {
    this.calls += 1;
    yield { type: 'result', subtype: 'success', result: JSON.stringify(this.outputs.shift()) };
  }
}

function outputs(partial: boolean): unknown[] {
  const assumptions = partial ? ['未知 build 仅按角色基础机制判断'] : [];
  return [
    {
      usableCharacterIds: characters.map((character) => character.id),
      partial,
      dataNotes: partial ? ['部分角色缺少详细 build'] : []
    },
    {
      teams: [
        {
          name: '离线评估队',
          characterIds: [1, 2, 3, 4],
          concept: '反应、生存与循环兼顾',
          confidence: partial ? 'low' : 'high',
          assumptions
        }
      ]
    },
    { reviews: [{ teamIndex: 0, viable: true, issues: partial ? ['充能面板未知'] : [] }] },
    { rotations: [{ teamIndex: 0, rotationTip: '3E → 2Q → 1E/Q → 4E' }] },
    {
      summary: partial ? '基于部分数据的离线评估建议。' : '完整数据离线评估建议。',
      teams: [{ teamIndex: 0, reasoning: '只使用已拥有角色并保留输入假设。' }]
    }
  ];
}

describe('30-case offline advisor matrix', () => {
  it.each(cases)('$name preserves contract and ownership invariants', async (fixture) => {
    const runner = new EvalRunner(outputs(fixture.partial));
    const result = await new AdvisorOrchestrator(runner).run({
      serializedProfile: JSON.stringify({
        profile: {
          coverage: { partial: fixture.partial },
          characters: characters.map(({ id, name, element }) => ({ id, name, element }))
        },
        enemies: fixture.enemy === 'no-enemy' ? [] : [fixture.enemy]
      }),
      characters,
      correlationId: fixture.name,
      side: 'single',
      emit: () => {},
      sdkOptions: {
        apiKey: 'offline',
        baseUrl: 'https://offline.invalid',
        model: 'offline',
        systemPrompt: '',
        cwd: '/tmp',
        abortController: new AbortController()
      }
    });
    const ids = result.teams[0]?.characters.map((character) => character.id) ?? [];
    expect(runner.calls).toBe(5);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => characters.some((character) => character.id === id))).toBe(true);
    expect(result.partial).toBe(fixture.partial);
    if (fixture.partial) {
      expect(result.summary).toContain('部分数据');
      expect(result.teams[0]?.assumptions?.length).toBeGreaterThan(0);
    }
  });
});
