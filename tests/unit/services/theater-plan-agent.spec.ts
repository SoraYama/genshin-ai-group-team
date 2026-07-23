import { describe, expect, it } from 'vitest';

import { TheaterPlanAgent } from '../../../src/main/services/theater-plan-agent.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import type { CharacterKnowledgeReader } from '../../../src/shared/character-knowledge.js';
import {
  THEATER_CHARACTERS,
  theaterInput,
  theaterScenario,
  validTheaterPlan
} from './theater-test-fixtures.js';

const groupingKnowledge: CharacterKnowledgeReader = {
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

class Runner {
  calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];
  constructor(
    private outputs: unknown[],
    private toolRounds: number[] = [0, 1]
  ) {}
  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    const round = this.calls.length - 1;
    const uses = [
      { id: 'profile', name: 'mcp__genshin__read_profile_cache', input: { uid: '123456789' } },
      ...[1, 2].map((act) => ({
        id: `act-${act}`,
        name: 'mcp__genshin__query_theater_act',
        input: { scenarioId: 'theater.2026-07', dataVersion: '2026.07.1', act }
      })),
      {
        id: 'knowledge',
        name: 'mcp__genshin__query_genshin_db',
        input: { characterIds: Array.from({ length: 8 }, (_, index) => String(1001 + index)) }
      }
    ];
    if (this.toolRounds.includes(round)) {
      yield {
        type: 'assistant',
        message: { content: uses.map((use) => ({ type: 'tool_use', ...use })) }
      };
      yield {
        type: 'user',
        message: {
          content: uses.map(({ id }) => ({
            type: 'tool_result',
            tool_use_id: id,
            is_error: false,
            content: 'ok'
          }))
        }
      };
    }
    yield {
      type: 'result',
      result: JSON.stringify(this.outputs.shift()),
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01
    };
  }
}

function sdkOptions(): AgentSdkRunOptions {
  return {
    apiKey: 'test',
    baseUrl: 'https://example.test',
    model: 'test',
    systemPrompt: '',
    cwd: '/tmp',
    abortController: new AbortController(),
    maxTurns: 4,
    mcpServers: { genshin: { type: 'sdk', name: 'genshin', instance: {} as never } },
    allowedBusinessTools: [
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_theater_act',
      'mcp__genshin__query_genshin_db'
    ]
  };
}

describe('TheaterPlanAgent', () => {
  it('validates compose, performs one repair, and audits tools independently each round', async () => {
    const invalid = validTheaterPlan();
    invalid.acts[1]!.pathChoice = { kind: 'fixed', note: '已确定' };
    const runner = new Runner([invalid, validTheaterPlan()]);
    const result = await new TheaterPlanAgent(runner).compose({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge: groupingKnowledge,
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: true,
      repaired: true,
      usage: { inputTokens: 20, outputTokens: 10 }
    });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.prompt).toContain('PATH_CHOICE_INVALID');
  });

  it('requires profile, knowledge, and every target act read in the same round', async () => {
    const runner = new Runner([validTheaterPlan(), validTheaterPlan()], [0]);
    const result = await new TheaterPlanAgent(runner).compose({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'AGENT_OUTPUT_INVALID', path: ['tools'] })]
    });
    expect(runner.calls).toHaveLength(2);
  });

  it('falls through deterministic issues after exactly one invalid repair', async () => {
    const runner = new Runner(['not-json', {}]);
    const result = await new TheaterPlanAgent(runner).compose({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'AGENT_OUTPUT_INVALID' })]
    });
    expect(runner.calls).toHaveLength(2);
  });
});
