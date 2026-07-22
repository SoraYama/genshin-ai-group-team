import { describe, expect, it, vi } from 'vitest';

import { AbyssAdvisorService } from '../../../src/main/services/abyss-advisor-service.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
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
    yield { type: 'result', result: JSON.stringify(this.outputs.shift()) };
  }
}

function readyScenario() {
  return {
    status: 'ready' as const,
    trust: 'production' as const,
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
}) {
  return new AbyssAdvisorService({
    runner: options.runner,
    scenarioService: { getView: async () => readyScenario() },
    profiles: { get: () => profile(options.characters) },
    history: { appendAbyss: options.appendAbyss ?? vi.fn() },
    config: {
      getApiKey: () => options.apiKey,
      getBaseUrl: () => 'https://example.test',
      getModel: () => 'test-model',
      getCustomHeaders: () => ({})
    },
    sdkEnvironment: { cwd: '/tmp/gta-test', clientVersion: 'test' }
  });
}

describe('AbyssAdvisorService', () => {
  it('uses the strict agent plan, emits player-semantic progress, and persists an immutable snapshot', async () => {
    const appendAbyss = vi.fn();
    const runner = new FixtureRunner([validAbyssPlan()]);
    const advisor = service({ runner, apiKey: 'secret', appendAbyss });
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
});
