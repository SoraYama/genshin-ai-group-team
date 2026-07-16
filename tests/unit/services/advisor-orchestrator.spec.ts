import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../../src/shared/domain.js';
import { ORCHESTRATION_ROUTE_V1 } from '../../../src/main/agents/orchestrator/policy.js';
import {
  AdvisorOrchestrator,
  type AgentQueryRunner
} from '../../../src/main/services/advisor-orchestrator.js';

const characters: CharacterProfile[] = [1, 2, 3, 4, 5].map((id) => ({
  id,
  name: `Character ${id}`,
  element: ['Pyro', 'Hydro', 'Anemo', 'Geo', 'Cryo'][id - 1] ?? 'None',
  rarity: id === 5 ? 4 : 5,
  imageUrl: '',
  level: 90,
  completeness: 'basic',
  missingFields: ['stats', 'weapon', 'artifacts', 'talents'],
  provenance: { ownership: { source: 'miyoushe-list', fetchedAt: '2026-01-01T00:00:00Z' } }
}));

class FixtureRunner implements AgentQueryRunner {
  readonly prompts: Array<{ prompt: string; systemPrompt: string }> = [];
  constructor(private readonly outputs: unknown[]) {}

  async *run(prompt: string, options: { systemPrompt: string }): AsyncIterable<unknown> {
    this.prompts.push({ prompt, systemPrompt: options.systemPrompt });
    const output = this.outputs.shift();
    yield { type: 'result', result: JSON.stringify(output) };
  }
}

const validOutputs = () => [
  { usableCharacterIds: [1, 2, 3, 4, 5], partial: true, dataNotes: ['武器数据缺失'] },
  {
    teams: [
      {
        name: '反应测试队',
        characterIds: [1, 2, 3, 4],
        concept: '蒸发与扩散',
        confidence: 'medium',
        assumptions: ['按基础角色机制判断']
      }
    ]
  },
  { reviews: [{ teamIndex: 0, viable: true, issues: ['充能数据未知'] }] },
  { rotations: [{ teamIndex: 0, rotationTip: '2E → 3Q → 1E/Q → 4Q' }] },
  {
    summary: '基于部分数据给出一套稳健候选。',
    teams: [{ teamIndex: 0, reasoning: '覆盖反应与生存需求，面板结论保持保守。' }]
  }
];

describe('AdvisorOrchestrator', () => {
  it('routes five isolated agents and combines only validated owned characters', async () => {
    const runner = new FixtureRunner(validOutputs());
    const events: string[] = [];
    const result = await new AdvisorOrchestrator(runner).run({
      serializedProfile: JSON.stringify({
        profile: { characters: characters.map(({ id, name }) => ({ id, name })) },
        enemies: ['测试敌人']
      }),
      characters,
      correlationId: 'correlation',
      side: 'single',
      emit: (event) => {
        if (event.type === 'progress') events.push(event.stage);
      },
      sdkOptions: {
        apiKey: 'test-key',
        baseUrl: 'https://example.test',
        model: 'test-model',
        systemPrompt: '',
        cwd: '/tmp',
        abortController: new AbortController()
      }
    });

    expect(runner.prompts).toHaveLength(5);
    expect(runner.prompts.map((call) => call.systemPrompt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DataCuratorAgent'),
        expect.stringContaining('TeamComposerAgent'),
        expect.stringContaining('CritiqueAgent'),
        expect.stringContaining('RotationCoachAgent'),
        expect.stringContaining('ExplainAgent')
      ])
    );
    expect(events).toEqual(ORCHESTRATION_ROUTE_V1);
    expect(result).toMatchObject({
      source: 'llm',
      partial: true,
      summary: expect.stringContaining('部分数据'),
      teams: [
        {
          name: '反应测试队',
          confidence: 'medium',
          assumptions: ['按基础角色机制判断'],
          critiqueIssues: ['充能数据未知'],
          rotationTip: '2E → 3Q → 1E/Q → 4Q'
        }
      ]
    });
    expect(result.teams[0]?.characters.map((character) => character.id)).toEqual([1, 2, 3, 4]);
  });

  it('rejects critique output that does not review every team exactly once', async () => {
    const outputs = validOutputs();
    outputs[1] = {
      teams: [
        {
          name: 'A',
          characterIds: [1, 2, 3, 4],
          concept: 'A',
          confidence: 'low',
          assumptions: []
        },
        {
          name: 'B',
          characterIds: [2, 3, 4, 5],
          concept: 'B',
          confidence: 'low',
          assumptions: []
        }
      ]
    };
    outputs[2] = { reviews: [{ teamIndex: 0, viable: true, issues: [] }] };
    const runner = new FixtureRunner(outputs);
    await expect(
      new AdvisorOrchestrator(runner).run({
        serializedProfile: JSON.stringify({ profile: {}, enemies: [] }),
        characters,
        correlationId: 'correlation',
        side: 'single',
        emit: () => {},
        sdkOptions: {
          apiKey: 'test-key',
          baseUrl: 'https://example.test',
          model: 'test-model',
          systemPrompt: '',
          cwd: '/tmp',
          abortController: new AbortController()
        }
      })
    ).rejects.toThrow('exactly once');
    expect(runner.prompts).toHaveLength(3);
  });

  it('stops the complete orchestration when the parent request is cancelled', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const runner = new FixtureRunner(validOutputs());
    await expect(
      new AdvisorOrchestrator(runner).run({
        serializedProfile: JSON.stringify({ profile: {}, enemies: [] }),
        characters,
        correlationId: 'cancelled-correlation',
        side: 'right',
        emit: () => {},
        sdkOptions: {
          apiKey: 'test-key',
          baseUrl: 'https://example.test',
          model: 'test-model',
          systemPrompt: '',
          cwd: '/tmp',
          abortController
        }
      })
    ).rejects.toThrow('cancelled');
    expect(runner.prompts).toHaveLength(1);
  });
});
