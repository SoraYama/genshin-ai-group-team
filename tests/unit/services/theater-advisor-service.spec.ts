import { describe, expect, it, vi } from 'vitest';

import { TheaterAdvisorService } from '../../../src/main/services/theater-advisor-service.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import type { TheaterPlanAgentRunner } from '../../../src/main/services/theater-plan-agent.js';
import {
  THEATER_CHARACTERS,
  THEATER_KNOWLEDGE,
  theaterInput,
  theaterScenario,
  validTheaterPlan
} from './theater-test-fixtures.js';

function directive<T>(target: T) {
  return {
    target,
    tone: 'steady',
    reasonCodes: ['setup-order'],
    factRefs: [{ kind: 'plan', field: 'validated-target' }]
  };
}

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

class HangingAfterComposeRunner implements TheaterPlanAgentRunner {
  calls = 0;
  private releaseStarted!: () => void;
  readonly stageStarted = new Promise<void>((resolve) => {
    this.releaseStarted = resolve;
  });

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls += 1;
    if (this.calls === 1) {
      const compose = new SuccessfulStageRunner();
      for await (const message of compose.run(prompt, options)) yield message;
      return;
    }
    this.releaseStarted();
    await new Promise<void>((resolve) => {
      options.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new Error('aborted');
  }
}

class SuccessfulStageRunner implements TheaterPlanAgentRunner {
  readonly calls: AgentSdkRunOptions[] = [];
  readonly prompts: string[] = [];

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push(options);
    this.prompts.push(prompt);
    if (options.systemPrompt.includes('CritiqueAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          decision: 'accept',
          issues: [
            {
              code: 'cast-flexibility-low',
              severity: 'soft',
              target: { kind: 'theater-act', act: 1 },
              message: '第一幕演员调整余量较小。'
            }
          ]
        })
      };
      return;
    }
    if (options.systemPrompt.includes('RotationCoachAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          rotations: [1, 2].map((act) => directive({ kind: 'theater-act', act }))
        })
      };
      return;
    }
    if (options.systemPrompt.includes('ExplainAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          explanations: [
            directive({ kind: 'theater-cast' }),
            ...[1, 2].map((act) => directive({ kind: 'theater-act', act }))
          ]
        })
      };
      return;
    }
    const request = JSON.parse(prompt) as { context: { profileRef: { uid: string } } };
    const selectedCharacterIds = validTheaterPlan().cast.selectedCharacterIds;
    const tools = [
      {
        id: 'profile',
        name: 'mcp__genshin__read_profile_cache',
        input: { uid: request.context.profileRef.uid, characterIds: selectedCharacterIds }
      },
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
    yield {
      type: 'assistant',
      message: { content: tools.map((use) => ({ type: 'tool_use', ...use })) }
    };
    yield {
      type: 'user',
      message: {
        content: tools.map(({ id }) => ({
          type: 'tool_result',
          tool_use_id: id,
          is_error: false,
          content: 'ok'
        }))
      }
    };
    yield {
      type: 'result',
      result: JSON.stringify(validTheaterPlan()),
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01
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
    runner?: TheaterPlanAgentRunner;
    characters?: typeof THEATER_CHARACTERS;
    apiKey?: string;
    view?: ReturnType<typeof readyView>;
    history?: ReturnType<typeof vi.fn>;
    audit?: ReturnType<typeof vi.fn>;
    timeout?: number;
    recordUsage?: ReturnType<typeof vi.fn>;
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
      getCustomHeaders: () => ({}),
      recordUsage: options.recordUsage
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
    if (result.status !== 'planned') throw new Error('Expected local plan');
    expect(result.narrative.sections.map(({ targetKey }) => targetKey)).toEqual([
      'theater-cast',
      'theater-act:1',
      'theater-act:2'
    ]);
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
        narrative: result.narrative,
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
        cast: expect.arrayContaining([expect.objectContaining({ id: '1001', source: 'owned' })]),
        arcanaSnapshots: [
          {
            id: 'node.1',
            nameRef: 'arcana.node.1',
            names: { 'zh-CN': '聚敌增益', en: 'Grouping Boon' }
          }
        ],
        encounterSnapshots: expect.arrayContaining([
          expect.objectContaining({
            act: 1,
            encounterId: 'act-1-encounter',
            enemyRefs: expect.arrayContaining([
              expect.objectContaining({ id: expect.any(String), names: expect.any(Object) })
            ])
          })
        ])
      })
    );
  });

  it('maps staged soft risks, rotation, and explanation into existing route guidance', async () => {
    const runner = new SuccessfulStageRunner();
    const history = vi.fn();
    const recordUsage = vi.fn();
    const result = await service({ runner, apiKey: 'secret', history, recordUsage }).recommend(
      theaterInput()
    );

    expect(result).toMatchObject({ status: 'planned', source: 'smart-service' });
    if (result.status !== 'planned') throw new Error('Expected planned result');
    expect(result.routeGuidance.notes.join(' ')).toContain('演员调整余量较小');
    expect(result.narrative).toMatchObject({
      origin: 'agent-structured',
      summary: { 'zh-CN': expect.any(String), 'en-US': expect.any(String) }
    });
    expect(runner.calls).toHaveLength(4);
    expect(
      runner.calls.slice(1).every(({ allowedBusinessTools }) => allowedBusinessTools?.length === 0)
    ).toBe(true);
    expect(history).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(10, 5, 0.01);
    const composePayload = JSON.parse(runner.prompts[0]!) as {
      context: {
        candidate: { eligibleCharacterIds: string[] };
        knowledge: { unknowns: Array<{ subjectId: string }> };
      };
    };
    expect(composePayload.context.knowledge.unknowns.map(({ subjectId }) => subjectId)).toEqual(
      composePayload.context.candidate.eligibleCharacterIds
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
        cast: expect.arrayContaining([
          expect.objectContaining({
            id: '1001',
            source: 'opening',
            names: { 'zh-CN': '开幕角色一', en: 'Opening One' },
            nameRef: { kind: 'scenario-entity', id: '1001' }
          })
        ])
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

  it('uses two repair rounds then falls back to the checked local route', async () => {
    const runner = new InvalidRunner();
    const history = vi.fn();
    const result = await service({ runner, apiKey: 'secret', history }).recommend(theaterInput());
    expect(runner.calls).toBe(3);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    if (result.status !== 'planned') throw new Error('Expected local fallback');
    expect(result.narrative.sections.map(({ targetKey }) => targetKey)).toEqual([
      'theater-cast',
      'theater-act:1',
      'theater-act:2'
    ]);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ narrative: result.narrative }));
    expect(result.warnings.join('')).toContain('本地规则');
  });

  it('records compose usage once when a later Critique stage is cancelled', async () => {
    const runner = new HangingAfterComposeRunner();
    const recordUsage = vi.fn();
    const advisor = service({
      runner,
      apiKey: 'secret',
      recordUsage,
      timeout: 1_000
    });
    const pending = advisor.recommend(theaterInput());
    await runner.stageStarted;
    expect(advisor.cancel('theater-test-request')).toBe(true);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(10, 5, 0.01);
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
