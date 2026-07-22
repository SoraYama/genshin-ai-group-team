import { describe, expect, it } from 'vitest';

import { AbyssPlanAgent } from '../../../src/main/services/abyss-plan-agent.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario,
  validAbyssPlan
} from './abyss-test-fixtures.js';

class FixtureRunner {
  readonly calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];

  constructor(private readonly outputs: unknown[]) {}

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    yield { type: 'result', result: JSON.stringify(this.outputs.shift()) };
  }
}

function sdkOptions(): AgentSdkRunOptions {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    model: 'test-model',
    systemPrompt: '',
    cwd: '/tmp',
    abortController: new AbortController(),
    maxTurns: 4,
    mcpServers: { genshin: { type: 'sdk', name: 'genshin', instance: {} as never } },
    allowedBusinessTools: [
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_enemy_data',
      'mcp__genshin__query_genshin_db'
    ]
  };
}

describe('AbyssPlanAgent', () => {
  it('validates compose output, sends structured issues to one repair turn, then accepts valid JSON', async () => {
    const invalid = validAbyssPlan({
      secondHalfTeam: {
        ...validAbyssPlan().secondHalfTeam,
        characterIds: ['1001', '1006', '1007', '1008']
      }
    });
    const repaired = validAbyssPlan();
    const runner = new FixtureRunner([invalid, repaired]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      sdkOptions: sdkOptions()
    });

    expect(result).toMatchObject({ ok: true, repaired: true, plan: repaired });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.options.systemPrompt).toContain('AbyssTeamComposer');
    expect(runner.calls[0]?.options.maxTurns).toBe(4);
    expect(runner.calls[1]?.prompt).toContain('CROSS_TEAM_DUPLICATE');
    expect(runner.calls[1]?.prompt).toContain('只修复');
  });

  it('returns the second structured issue list after exactly one failed repair', async () => {
    const invalid = { ...validAbyssPlan(), chambers: [] };
    const runner = new FixtureRunner([invalid, invalid]);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      sdkOptions: sdkOptions()
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['CHAMBER_COVERAGE_INVALID', 'PLAN_SCHEMA_INVALID'])
    );
    expect(runner.calls).toHaveLength(2);
  });

  it('treats narrative or malformed output as invalid instead of scraping arbitrary prose', async () => {
    const runner = new FixtureRunner(['```json\n{}\n```', 'not-json']);
    const result = await new AbyssPlanAgent(runner).compose({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'AGENT_OUTPUT_INVALID' }]
    });
  });
});
