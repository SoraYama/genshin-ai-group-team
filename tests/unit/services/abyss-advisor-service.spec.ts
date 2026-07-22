import { describe, expect, it, vi } from 'vitest';

import { AbyssAdvisorService } from '../../../src/main/services/abyss-advisor-service.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import type { AbyssScenarioView } from '../../../src/shared/abyss-advisor.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario,
  validAbyssPlan
} from './abyss-test-fixtures.js';

class FixtureRunner {
  calls = 0;
  constructor(private readonly outputs: unknown[]) {}
  async *run(_prompt: string, _options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls += 1;
    const toolUses = [
      {
        id: 'profile',
        name: 'mcp__genshin__read_profile_cache',
        input: { uid: '123456789' }
      },
      ...[1, 2].map((chamber) => ({
        id: `enemy-${chamber}`,
        name: 'mcp__genshin__query_enemy_data',
        input: {
          scenarioId: 'abyss.2026-07',
          dataVersion: '2026.07.1',
          floor: 12,
          chamber
        }
      })),
      {
        id: 'characters',
        name: 'mcp__genshin__query_genshin_db',
        input: { characterIds: ABYSS_CHARACTERS.slice(0, 8).map(({ id }) => String(id)) }
      }
    ];
    yield {
      type: 'assistant',
      message: { content: toolUses.map((use) => ({ type: 'tool_use', ...use })) }
    };
    yield {
      type: 'user',
      message: {
        content: toolUses.map(({ id }) => ({
          type: 'tool_result',
          tool_use_id: id,
          is_error: false,
          content: 'ok'
        }))
      }
    };
    yield {
      type: 'result',
      result: JSON.stringify(this.outputs.shift()),
      usage: { input_tokens: 12, output_tokens: 6 },
      total_cost_usd: 0.02
    };
  }
}

class HangingRunner {
  async *run(_prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    await new Promise<void>((resolve) => {
      options.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'aborted' };
    throw new Error('aborted');
  }
}

function readyScenario() {
  return {
    status: 'ready' as const,
    trust: 'production' as const,
    snapshotStatus: 'ready' as const,
    notCurrent: false,
    freshness: 'fresh' as const,
    checkedAt: '2026-07-23T00:00:00.000Z',
    scenario: abyssScenario()
  };
}

function profile(characters = ABYSS_CHARACTERS) {
  return {
    schemaVersion: 2 as const,
    uid: '123456789',
    source: 'merged' as const,
    fetchedAt: '2026-07-23T00:00:00.000Z',
    characters,
    coverage: {
      ownedCount: characters.length,
      detailedCount: characters.filter(({ completeness }) => completeness === 'detailed').length,
      buildCount: characters.length,
      statsCount: characters.length,
      enkaShowcaseCount: characters.length,
      missingDetailCount: characters.filter(({ completeness }) => completeness !== 'detailed')
        .length,
      partial: characters.some(({ completeness }) => completeness !== 'detailed')
    }
  };
}

function service(options: {
  runner: FixtureRunner;
  apiKey?: string;
  characters?: typeof ABYSS_CHARACTERS;
  appendAbyss?: ReturnType<typeof vi.fn>;
  scenarioView?: AbyssScenarioView;
  agentTimeoutMs?: number;
  recordUsage?: ReturnType<typeof vi.fn>;
}) {
  return new AbyssAdvisorService({
    runner: options.runner,
    scenarioService: { getView: async () => options.scenarioView ?? readyScenario() },
    profiles: { get: () => profile(options.characters) },
    history: { appendAbyss: options.appendAbyss ?? vi.fn() },
    config: {
      getApiKey: () => options.apiKey,
      getBaseUrl: () => 'https://example.test',
      getModel: () => 'test-model',
      getCustomHeaders: () => ({}),
      recordUsage: options.recordUsage
    },
    sdkEnvironment: { cwd: '/tmp/gta-test', clientVersion: 'test' },
    agentTimeoutMs: options.agentTimeoutMs
  });
}

describe('AbyssAdvisorService', () => {
  it('uses the strict agent plan, emits player-semantic progress, and persists an immutable snapshot', async () => {
    const appendAbyss = vi.fn();
    const recordUsage = vi.fn();
    const runner = new FixtureRunner([validAbyssPlan()]);
    const advisor = service({ runner, apiKey: 'secret', appendAbyss, recordUsage });
    const progress: string[] = [];
    const result = await advisor.recommend(abyssInput(), (step) => progress.push(step));

    expect(result).toMatchObject({ status: 'planned', source: 'smart-service' });
    expect(progress).toEqual([
      'reading-roster',
      'analyzing-rules',
      'generating-teams',
      'checking-conflicts',
      'writing-tactics'
    ]);
    expect(runner.calls).toBe(1);
    expect(recordUsage).toHaveBeenCalledWith(12, 6, 0.02);
    expect(appendAbyss).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: 'abyss.2026-07',
        schemaVersion: 2,
        dataVersion: '2026.07.1',
        mode: 'spiral-abyss',
        source: 'smart-service',
        plan: validAbyssPlan()
      })
    );
  });

  it('runs one repair then falls back to the local joint optimizer when both agent attempts fail', async () => {
    const invalid = { ...validAbyssPlan(), chambers: [] };
    const runner = new FixtureRunner([invalid, invalid]);
    const result = await service({ runner, apiKey: 'secret' }).recommend(abyssInput());

    expect(runner.calls).toBe(2);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.warnings.join(' ')).toContain('智能服务');
  });

  it('uses local rules without invoking the agent when the smart service is not configured', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await service({ runner }).recommend(abyssInput());
    expect(runner.calls).toBe(0);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
  });

  it('returns blocked instead of an invalid agent request when the roster has fewer than eight characters', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await service({
      runner,
      apiKey: 'secret',
      characters: ABYSS_CHARACTERS.slice(0, 7)
    }).recommend(abyssInput());
    expect(runner.calls).toBe(0);
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'ROSTER_INSUFFICIENT' }]
    });
  });

  it('blocks scenario identity drift before either agent or fallback generation', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await service({ runner, apiKey: 'secret' }).recommend(
      abyssInput({ dataVersion: 'wrong' })
    );
    expect(runner.calls).toBe(0);
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'DATA_VERSION_MISMATCH' }]
    });
  });

  it('keeps stale or last-known-good production data read-only', async () => {
    const runner = new FixtureRunner([validAbyssPlan()]);
    const result = await service({
      runner,
      apiKey: 'secret',
      scenarioView: {
        status: 'ready',
        trust: 'production',
        snapshotStatus: 'last-known-good',
        refreshErrorCode: 'network-unavailable',
        notCurrent: true,
        freshness: 'stale',
        checkedAt: '2026-07-23T00:00:00.000Z',
        scenario: abyssScenario()
      }
    }).recommend(abyssInput());
    expect(runner.calls).toBe(0);
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'SCENARIO_MISMATCH' }]
    });
  });

  it('aborts a hung smart-service request and falls back to local rules', async () => {
    const advisor = service({
      runner: new HangingRunner() as never,
      apiKey: 'secret',
      agentTimeoutMs: 10
    });
    const result = await advisor.recommend(abyssInput());
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.warnings.join(' ')).toContain('智能服务');
  });
});
