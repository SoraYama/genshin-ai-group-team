import { describe, expect, it, vi } from 'vitest';

import { TheaterAdvisorService } from '../../../src/main/services/theater-advisor-service.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import {
  THEATER_CHARACTERS,
  THEATER_KNOWLEDGE,
  theaterInput,
  theaterScenario
} from './theater-test-fixtures.js';

class InvalidRunner {
  calls = 0;
  async *run(): AsyncIterable<unknown> {
    this.calls += 1;
    yield { type: 'result', result: JSON.stringify({ invalid: true }) };
  }
}
class WaitingRunner {
  run(_prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            await new Promise<void>((resolve) =>
              options.abortController.signal.addEventListener('abort', () => resolve(), {
                once: true
              })
            );
            throw new Error('aborted');
          }
        };
      }
    };
  }
}

const profile = (characters = THEATER_CHARACTERS) => ({
  schemaVersion: 2 as const,
  uid: '123456789',
  source: 'merged' as const,
  fetchedAt: '2026-07-23T00:00:00.000Z',
  characters,
  coverage: {
    ownedCount: characters.length,
    detailedCount: 8,
    buildCount: characters.length,
    statsCount: characters.length,
    enkaShowcaseCount: 8,
    missingDetailCount: Math.max(0, characters.length - 8),
    partial: true
  }
});
function readyView(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready' as const,
    trust: 'production' as const,
    snapshotStatus: 'ready' as const,
    notCurrent: false,
    usableForRecommendation: true,
    freshness: 'fresh' as const,
    checkedAt: '2026-07-23T00:00:00.000Z',
    scenario: theaterScenario(),
    ...overrides
  };
}
function service(
  options: {
    runner?: InvalidRunner | WaitingRunner;
    characters?: typeof THEATER_CHARACTERS;
    apiKey?: string;
    view?: ReturnType<typeof readyView>;
    history?: ReturnType<typeof vi.fn>;
    audit?: ReturnType<typeof vi.fn>;
    timeout?: number;
  } = {}
) {
  return new TheaterAdvisorService({
    runner: options.runner ?? new InvalidRunner(),
    scenarioService: { getView: async () => options.view ?? readyView() },
    profiles: { get: () => profile(options.characters) },
    history: { appendTheater: options.history ?? vi.fn() },
    config: {
      getApiKey: () => options.apiKey,
      getBaseUrl: () => 'https://example.test',
      getModel: () => 'test',
      getCustomHeaders: () => ({})
    },
    sdkEnvironment: { cwd: '/tmp', clientVersion: 'test' },
    agentTimeoutMs: options.timeout,
    knowledge: THEATER_KNOWLEDGE,
    auditLog: options.audit
  });
}

describe('TheaterAdvisorService', () => {
  it('emits five correlated steps and persists an immutable route snapshot', async () => {
    const history = vi.fn();
    const progress = vi.fn();
    const result = await service({ history }).recommend(theaterInput(), progress);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(progress.mock.calls.map(([event]) => event.step)).toEqual([
      'reading-roster',
      'checking-eligibility',
      'planning-cast',
      'budgeting-vigor',
      'writing-route'
    ]);
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'imaginarium-theater',
        target: 'safe-clear',
        scenarioTrust: 'production',
        playerCycle: {
          status: 'known',
          label: '2026-01-01 — 2026-02-01',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: '2026-02-01T00:00:00.000Z'
        },
        eligibility: expect.objectContaining({ hardQualifiedCount: 9 }),
        vigorBudget: expect.arrayContaining([
          expect.objectContaining({
            act: 1,
            characterId: '1001',
            before: 2,
            spent: 1,
            after: 1
          }),
          expect.objectContaining({
            act: 2,
            characterId: '1008',
            before: 2,
            spent: 1,
            after: 1
          })
        ]),
        cast: expect.arrayContaining([expect.objectContaining({ id: '1001', source: 'owned' })])
      })
    );
  });

  it('persists the source actually selected in the plan even for external actors', async () => {
    const history = vi.fn();
    const result = await service({ history }).recommend(
      theaterInput({ selectedOpeningCharacterIds: ['1001'] })
    );
    expect(result.status).toBe('planned');
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        cast: expect.arrayContaining([expect.objectContaining({ id: '1001', source: 'opening' })])
      })
    );
  });

  it('emits a structured audit event when secondary history persistence fails', async () => {
    const audit = vi.fn();
    const history = vi.fn(() => {
      throw new Error('disk unavailable');
    });
    const result = await service({ history, audit }).recommend(theaterInput());
    expect(result.status).toBe('planned');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'history-write-failed',
        correlationId: 'theater-test-request',
        issueCodes: ['HISTORY_WRITE_FAILED']
      })
    );
  });

  it('blocks insufficient eligibility before any Agent call', async () => {
    const runner = new InvalidRunner();
    const result = await service({
      runner,
      characters: THEATER_CHARACTERS.slice(0, 7),
      apiKey: 'secret'
    }).recommend(theaterInput({ selectedTrialCharacterIds: ['trial.1'] }));
    expect(result).toMatchObject({ status: 'blocked', eligibility: { shortage: 1 } });
    expect(runner.calls).toBe(0);
  });

  it('blocks stale production data and keeps usable last-known-good visible', async () => {
    const stale = await service({
      view: readyView({ freshness: 'stale', notCurrent: true, usableForRecommendation: false })
    }).recommend(theaterInput());
    expect(stale).toMatchObject({
      status: 'blocked',
      issues: [expect.objectContaining({ code: 'SCENARIO_MISMATCH' })]
    });
    const lkg = await service({
      view: readyView({
        snapshotStatus: 'last-known-good',
        refreshWarning: '正在使用最近一次已确认的资料。'
      })
    }).recommend(theaterInput());
    expect(lkg.warnings.join('')).toContain('最近一次已确认');
  });

  it('repairs once then falls back to the checked local route', async () => {
    const runner = new InvalidRunner();
    const result = await service({ runner, apiKey: 'secret' }).recommend(theaterInput());
    expect(runner.calls).toBe(2);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.warnings.join('')).toContain('本地规则');
  });

  it('times out or cancels without writing an invalid history entry', async () => {
    const timeout = await service({
      runner: new WaitingRunner(),
      apiKey: 'secret',
      timeout: 5
    }).recommend(theaterInput());
    expect(timeout).toMatchObject({ status: 'planned', source: 'local-rules' });
    let release: ((value: ReturnType<typeof readyView>) => void) | undefined;
    const history = vi.fn();
    const pendingView = new Promise<ReturnType<typeof readyView>>((resolve) => {
      release = resolve;
    });
    const advisor = new TheaterAdvisorService({
      runner: new InvalidRunner(),
      scenarioService: { getView: () => pendingView },
      profiles: { get: () => profile() },
      history: { appendTheater: history },
      config: {
        getApiKey: () => undefined,
        getBaseUrl: () => '',
        getModel: () => '',
        getCustomHeaders: () => ({})
      },
      sdkEnvironment: { cwd: '/tmp', clientVersion: 'test' },
      knowledge: THEATER_KNOWLEDGE
    });
    const pending = advisor.recommend(theaterInput());
    expect(advisor.cancel('theater-test-request')).toBe(true);
    release?.(readyView());
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(history).not.toHaveBeenCalled();
  });
});
