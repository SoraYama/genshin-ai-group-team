import { describe, expect, it, vi } from 'vitest';

import { StygianAdvisorService } from '../../../src/main/services/stygian-advisor-service.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import { STYGIAN_CHARACTERS, stygianInput, stygianScenario } from './stygian-test-fixtures.js';

const profile = {
  schemaVersion: 2 as const,
  uid: '123456789',
  source: 'merged' as const,
  fetchedAt: '2026-07-23T00:00:00.000Z',
  characters: STYGIAN_CHARACTERS,
  coverage: {
    ownedCount: 14,
    detailedCount: 8,
    buildCount: 14,
    statsCount: 14,
    enkaShowcaseCount: 14,
    missingDetailCount: 6,
    partial: true
  }
};

class InvalidAgentRunner {
  calls = 0;
  async *run(): AsyncIterable<unknown> {
    this.calls += 1;
    yield { type: 'result', result: JSON.stringify({ invalid: true }) };
  }
}

class WaitingAgentRunner {
  async *run(_prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    await new Promise<void>((resolve) => {
      options.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    if (!options.abortController.signal.aborted) yield undefined;
    throw new Error('aborted');
  }
}

function readyView(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready' as const,
    trust: 'production' as const,
    snapshotStatus: 'ready' as const,
    notCurrent: false,
    usableForRecommendation: true,
    freshness: 'fresh' as const,
    checkedAt: '2026-07-23T00:00:00.000Z',
    scenario: stygianScenario(),
    ...overrides
  };
}

function service(
  options: {
    apiKey?: string;
    runner?: InvalidAgentRunner | WaitingAgentRunner;
    view?: ReturnType<typeof readyView>;
    history?: ReturnType<typeof vi.fn>;
    audit?: ReturnType<typeof vi.fn>;
    timeout?: number;
  } = {}
) {
  return new StygianAdvisorService({
    runner: options.runner ?? new InvalidAgentRunner(),
    scenarioService: { getView: async () => options.view ?? readyView() },
    profiles: { get: () => profile },
    history: { appendStygian: options.history ?? vi.fn() },
    config: {
      getApiKey: () => options.apiKey,
      getBaseUrl: () => 'https://example.test',
      getModel: () => 'test-model',
      getCustomHeaders: () => ({})
    },
    sdkEnvironment: { cwd: '/tmp', clientVersion: 'test' },
    agentTimeoutMs: options.timeout,
    auditLog: options.audit
  });
}

describe('StygianAdvisorService', () => {
  it('runs the local checked planner, emits all five correlated steps, and stores an immutable history snapshot', async () => {
    const history = vi.fn();
    const audit = vi.fn();
    const progress = vi.fn();
    const result = await service({ history, audit }).recommend(stygianInput(), progress);
    expect(result.status).toBe('planned');
    expect(progress.mock.calls.map(([event]) => event.step)).toEqual([
      'reading-roster',
      'analyzing-rules',
      'allocating-parties',
      'checking-mechanics',
      'writing-guidance'
    ]);
    expect(
      progress.mock.calls.every(([event]) => event.correlationId === 'stygian-test-request')
    ).toBe(true);
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'stygian-onslaught',
        difficultyId: 'difficulty-6',
        difficultyName: '难度 6',
        target: 'dire-challenge',
        reusePolicy: { rule: 'forbidden', notes: [] },
        scenarioTrust: 'production',
        scenarioFreshness: 'fresh',
        characters: expect.arrayContaining([expect.objectContaining({ name: '幽境角色1' })])
      })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'stygian-test-request',
        outcome: 'planned',
        parameterSummary: expect.objectContaining({
          difficultyId: 'difficulty-6',
          target: 'dire-challenge',
          reuseRule: 'forbidden'
        })
      })
    );
  });

  it('blocks stale or unknown production data before planning', async () => {
    const result = await service({
      view: readyView({ notCurrent: true, usableForRecommendation: false, freshness: 'stale' })
    }).recommend(stygianInput());
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [expect.objectContaining({ code: 'SCENARIO_MISMATCH' })]
    });
  });

  it('keeps fresh last-known-good usable with a visible warning', async () => {
    const result = await service({
      view: readyView({
        snapshotStatus: 'last-known-good',
        refreshWarning: '正在使用最近一次已确认的资料；本次刷新失败。'
      })
    }).recommend(stygianInput());
    expect(result.warnings.join('')).toContain('最近一次已确认');
  });

  it('falls back once to the checked local plan when smart output and repair both fail', async () => {
    const runner = new InvalidAgentRunner();
    const result = await service({ apiKey: 'secret', runner }).recommend(stygianInput());
    expect(runner.calls).toBe(2);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.warnings.join('')).toContain('本地规则');
  });

  it('times out smart generation and returns the local plan without labelling it infeasible', async () => {
    const result = await service({
      apiKey: 'secret',
      runner: new WaitingAgentRunner(),
      timeout: 5
    }).recommend(stygianInput());
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: 'MECHANIC_COVERAGE_INVALID' })
    );
  });

  it('cancels the active request and prevents history writes', async () => {
    let release: (() => void) | undefined;
    const history = vi.fn();
    const pendingScenario = new Promise<ReturnType<typeof readyView>>((resolve) => {
      release = () => resolve(readyView());
    });
    const advisor = new StygianAdvisorService({
      runner: new InvalidAgentRunner(),
      scenarioService: { getView: () => pendingScenario },
      profiles: { get: () => profile },
      history: { appendStygian: history },
      config: {
        getApiKey: () => undefined,
        getBaseUrl: () => '',
        getModel: () => '',
        getCustomHeaders: () => ({})
      },
      sdkEnvironment: { cwd: '/tmp', clientVersion: 'test' }
    });
    const pending = advisor.recommend(stygianInput());
    expect(advisor.cancel('stygian-test-request')).toBe(true);
    release?.();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(history).not.toHaveBeenCalled();
  });

  it('ignores a stale correlation cancel after a newer request has started', async () => {
    const releases: Array<(view: ReturnType<typeof readyView>) => void> = [];
    const advisor = new StygianAdvisorService({
      runner: new InvalidAgentRunner(),
      scenarioService: {
        getView: () =>
          new Promise<ReturnType<typeof readyView>>((resolve) => {
            releases.push(resolve);
          })
      },
      profiles: { get: () => profile },
      history: { appendStygian: vi.fn() },
      config: {
        getApiKey: () => undefined,
        getBaseUrl: () => '',
        getModel: () => '',
        getCustomHeaders: () => ({})
      },
      sdkEnvironment: { cwd: '/tmp', clientVersion: 'test' }
    });
    const oldRequest = advisor.recommend(stygianInput({ correlationId: 'stale-request' }));
    const newRequest = advisor.recommend(stygianInput({ correlationId: 'current-request' }));
    expect(advisor.cancel('stale-request')).toBe(false);
    releases[1]?.(readyView());
    await expect(newRequest).resolves.toMatchObject({ status: 'planned' });
    await expect(oldRequest).rejects.toThrow(/cancelled/);
  });
});
