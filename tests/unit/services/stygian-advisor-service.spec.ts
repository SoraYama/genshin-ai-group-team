import { describe, expect, it, vi } from 'vitest';

import { StygianAdvisorService } from '../../../src/main/services/stygian-advisor-service.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import type { StygianPlanAgentRunner } from '../../../src/main/services/stygian-plan-agent.js';
import {
  STYGIAN_CHARACTERS,
  stygianInput,
  stygianScenario,
  validStygianPlan
} from './stygian-test-fixtures.js';

function directive<T>(target: T) {
  return {
    target,
    tone: 'steady',
    reasonCodes: ['setup-order'],
    factRefs: [{ kind: 'plan', field: 'validated-target' }]
  };
}

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
    yield { type: 'result', subtype: 'success', result: JSON.stringify({ invalid: true }) };
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

class HangingAfterComposeRunner implements StygianPlanAgentRunner {
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

class SuccessfulStageRunner implements StygianPlanAgentRunner {
  readonly calls: AgentSdkRunOptions[] = [];
  readonly prompts: string[] = [];

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push(options);
    this.prompts.push(prompt);
    if (options.systemPrompt.includes('CritiqueAgent v2')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          decision: 'accept',
          issues: [
            {
              code: 'energy-window-tight',
              severity: 'soft',
              target: { kind: 'stygian-phase', phase: 1 },
              message: '第一阶段能量窗口偏紧。'
            }
          ]
        })
      };
      return;
    }
    if (options.systemPrompt.includes('RotationCoachAgent v2')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          rotations: [1, 2, 3].map((phase) => directive({ kind: 'stygian-phase', phase }))
        })
      };
      return;
    }
    if (options.systemPrompt.includes('ExplainAgent v2')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          explanations: [1, 2, 3].map((phase) => directive({ kind: 'stygian-phase', phase }))
        })
      };
      return;
    }
    const request = JSON.parse(prompt) as { context: { profileRef: { uid: string } } };
    const selectedCharacterIds = validStygianPlan().phases.flatMap(({ team }) => team.characterIds);
    const toolUses = [
      {
        id: 'profile',
        name: 'mcp__genshin__read_profile_cache',
        input: { uid: request.context.profileRef.uid, characterIds: selectedCharacterIds }
      },
      ...[1, 2, 3].map((phase) => ({
        id: `phase-${phase}`,
        name: 'mcp__genshin__query_stygian_phase',
        input: {
          scenarioId: 'stygian.2026-07',
          dataVersion: '2026.07.1',
          difficultyId: 'difficulty-6',
          phase
        }
      })),
      {
        id: 'knowledge',
        name: 'mcp__genshin__query_genshin_db',
        input: { characterIds: STYGIAN_CHARACTERS.slice(0, 12).map(({ id }) => String(id)) }
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
      subtype: 'success',
      result: JSON.stringify(validStygianPlan()),
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01
    };
  }
}

class ComposeToolsOnlyRepairRunner implements StygianPlanAgentRunner {
  calls = 0;

  async *run(): AsyncIterable<unknown> {
    const round = this.calls;
    this.calls += 1;
    const toolUses = [
      {
        id: 'profile',
        name: 'mcp__genshin__read_profile_cache',
        input: { uid: '123456789' }
      },
      ...[1, 2, 3].map((phase) => ({
        id: `phase-${phase}`,
        name: 'mcp__genshin__query_stygian_phase',
        input: {
          scenarioId: 'stygian.2026-07',
          dataVersion: '2026.07.1',
          difficultyId: 'difficulty-6',
          phase
        }
      })),
      {
        id: 'knowledge',
        name: 'mcp__genshin__query_genshin_db',
        input: { characterIds: STYGIAN_CHARACTERS.slice(0, 12).map(({ id }) => String(id)) }
      }
    ];
    if (round === 0) {
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
    }
    const plan = validStygianPlan();
    if (round === 0) {
      plan.phases.forEach((phase) => {
        phase.team.characterIds = ['1001', '1002', '1003', '1004'];
      });
    }
    yield { type: 'result', subtype: 'success', result: JSON.stringify(plan) };
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
    runner?: StygianPlanAgentRunner;
    view?: ReturnType<typeof readyView>;
    history?: ReturnType<typeof vi.fn>;
    audit?: ReturnType<typeof vi.fn>;
    timeout?: number;
    recordUsage?: ReturnType<typeof vi.fn>;
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
      getCustomHeaders: () => ({}),
      recordUsage: options.recordUsage
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
    if (result.status !== 'planned') throw new Error('Expected planned result');
    expect(result.narrative).toMatchObject({ origin: 'local-rules' });
    expect(result.narrative.sections.map(({ targetKey }) => targetKey)).toEqual([
      'stygian-phase:1',
      'stygian-phase:2',
      'stygian-phase:3'
    ]);
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'stygian-onslaught',
        difficultyId: 'difficulty-6',
        difficultyNames: expect.objectContaining({
          'zh-CN': '难度 6',
          'en-US': 'Difficulty 6'
        }),
        target: 'dire-challenge',
        reusePolicy: { rule: 'forbidden', notes: [] },
        scenarioTrust: 'production',
        scenarioFreshness: 'fresh',
        playerCycle: {
          status: 'known',
          label: '2026-01-01 — 2026-02-01',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: '2026-02-01T00:00:00.000Z'
        },
        phaseGuidance: result.phaseGuidance,
        difficultyAssessment: result.difficultyAssessment,
        narrative: result.narrative,
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

  it('maps accepted staged risks, rotation, and explanation onto the validated result', async () => {
    const runner = new SuccessfulStageRunner();
    const history = vi.fn();
    const recordUsage = vi.fn();
    const result = await service({ apiKey: 'secret', runner, history, recordUsage }).recommend(
      stygianInput()
    );

    expect(result).toMatchObject({ status: 'planned', source: 'smart-service' });
    if (result.status !== 'planned') throw new Error('Expected planned result');
    expect(result.phaseGuidance[0]?.risks).toContain('第一阶段能量窗口偏紧。');
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

  it('falls back once to the checked local plan after two failed repairs', async () => {
    const runner = new InvalidAgentRunner();
    const history = vi.fn();
    const result = await service({ apiKey: 'secret', runner, history }).recommend(stygianInput());
    expect(runner.calls).toBe(3);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    if (result.status !== 'planned') throw new Error('Expected local fallback');
    expect(result.narrative.sections.map(({ targetKey }) => targetKey)).toEqual([
      'stygian-phase:1',
      'stygian-phase:2',
      'stygian-phase:3'
    ]);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ narrative: result.narrative }));
    expect(result.warnings.join('')).toContain('本地规则');
  });

  it('falls back when a repair turn returns a valid plan without its own required tool reads', async () => {
    const runner = new ComposeToolsOnlyRepairRunner();
    const result = await service({ apiKey: 'secret', runner }).recommend(stygianInput());

    expect(runner.calls).toBe(3);
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

  it('records compose usage once when a later Critique stage is cancelled', async () => {
    const runner = new HangingAfterComposeRunner();
    const recordUsage = vi.fn();
    const advisor = service({
      apiKey: 'secret',
      runner,
      recordUsage,
      timeout: 1_000
    });
    const pending = advisor.recommend(stygianInput());
    await runner.stageStarted;
    expect(advisor.cancel('stygian-test-request')).toBe(true);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(10, 5, 0.01);
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
