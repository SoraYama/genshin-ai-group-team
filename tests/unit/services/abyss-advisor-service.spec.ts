import { describe, expect, it, vi } from 'vitest';

import { AbyssAdvisorService } from '../../../src/main/services/abyss-advisor-service.js';
import { CharacterKnowledgeStore } from '../../../src/main/services/character-knowledge-store.js';
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
  async *run(_prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls += 1;
    if (options.systemPrompt.includes('CritiqueAgent v2')) {
      yield { type: 'result', result: JSON.stringify({ decision: 'accept', issues: [] }) };
      return;
    }
    if (options.systemPrompt.includes('RotationCoachAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          rotations: [{ target: { kind: 'abyss-team', half: 'first' }, notes: ['先辅助后输出。'] }]
        })
      };
      return;
    }
    if (options.systemPrompt.includes('ExplainAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          explanations: [
            {
              target: { kind: 'abyss-chamber', floor: 12, chamber: 1, half: 'first' },
              text: '基于已验证方案处理本房间。'
            }
          ]
        })
      };
      return;
    }
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

class HangingAfterComposeRunner {
  calls = 0;
  private releaseStarted!: () => void;
  readonly stageStarted = new Promise<void>((resolve) => {
    this.releaseStarted = resolve;
  });

  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls += 1;
    if (this.calls === 1) {
      const compose = new FixtureRunner([validAbyssPlan()]);
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

function readyScenario() {
  return {
    status: 'ready' as const,
    trust: 'production' as const,
    snapshotStatus: 'ready' as const,
    notCurrent: false,
    usableForRecommendation: true,
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
  scenarioService?: { getView: () => Promise<AbyssScenarioView> };
  knowledge?: CharacterKnowledgeStore;
  toolLog?: ReturnType<typeof vi.fn>;
  auditLog?: ReturnType<typeof vi.fn>;
}) {
  return new AbyssAdvisorService({
    runner: options.runner,
    scenarioService: options.scenarioService ?? {
      getView: async () => options.scenarioView ?? readyScenario()
    },
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
    agentTimeoutMs: options.agentTimeoutMs,
    knowledge: options.knowledge,
    toolLog: options.toolLog,
    auditLog: options.auditLog
  });
}

describe('AbyssAdvisorService', () => {
  it('records a correlated, redacted result audit with stable issue codes', async () => {
    const auditLog = vi.fn();
    const result = await service({
      runner: new FixtureRunner([]),
      characters: ABYSS_CHARACTERS.slice(0, 7),
      auditLog
    }).recommend(abyssInput());

    expect(result.status).toBe('blocked');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'abyss-test-request',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1',
        knowledgeVersion: 'unavailable',
        outcome: 'blocked',
        issueCodes: ['ROSTER_INSUFFICIENT'],
        parameterSummary: expect.objectContaining({ floor: 12, recompute: 'both' })
      })
    );
    expect(JSON.stringify(auditLog.mock.calls)).not.toMatch(
      /123456789|测试角色|api.?key|authorization/i
    );
  });

  it('uses the strict agent plan, emits player-semantic progress, and persists an immutable snapshot', async () => {
    const appendAbyss = vi.fn();
    const recordUsage = vi.fn();
    const runner = new FixtureRunner([validAbyssPlan()]);
    const advisor = service({ runner, apiKey: 'secret', appendAbyss, recordUsage });
    const progress: string[] = [];
    const result = await advisor.recommend(abyssInput(), ({ correlationId, step }) =>
      progress.push(`${correlationId}:${step}`)
    );

    expect(result).toMatchObject({ status: 'planned', source: 'smart-service' });
    if (result.status !== 'planned') throw new Error('Expected planned result');
    expect(result.plan.firstHalfTeam.rotationNotes).toContain('先辅助后输出。');
    expect(result.plan.chambers[0]?.firstHalf.tactics).toContain('基于已验证方案处理本房间。');
    expect(progress).toEqual([
      'abyss-test-request:reading-roster',
      'abyss-test-request:analyzing-rules',
      'abyss-test-request:generating-teams',
      'abyss-test-request:checking-conflicts',
      'abyss-test-request:writing-tactics'
    ]);
    expect(runner.calls).toBe(4);
    expect(recordUsage).toHaveBeenCalledWith(12, 6, 0.02);
    expect(appendAbyss).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: 'abyss.2026-07',
        schemaVersion: 2,
        dataVersion: '2026.07.1',
        mode: 'spiral-abyss',
        source: 'smart-service',
        scenarioTrust: 'production',
        playerCycle: {
          status: 'known',
          label: '2026-01-01 — 2026-02-01',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: '2026-02-01T00:00:00.000Z'
        },
        plan: expect.objectContaining({
          mode: 'spiral-abyss',
          firstHalfTeam: expect.objectContaining({
            characterIds: validAbyssPlan().firstHalfTeam.characterIds
          })
        })
      })
    );
  });

  it('runs two repairs then falls back to the local joint optimizer when all attempts fail', async () => {
    const invalid = { ...validAbyssPlan(), chambers: [] };
    const runner = new FixtureRunner([invalid, invalid, invalid]);
    const result = await service({ runner, apiKey: 'secret' }).recommend(abyssInput());

    expect(runner.calls).toBe(3);
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.warnings.join(' ')).toContain('智能服务');
  });

  it('downgrades smart output when selected-character knowledge coverage is incomplete', async () => {
    const knowledge = CharacterKnowledgeStore.fromUnknown({
      schemaVersion: 1,
      knowledgeVersion: 'partial-knowledge-v1',
      updatedAt: '2026-07-23T00:00:00.000Z',
      coverage: { characterCount: 1, notes: '仅覆盖一个测试角色。' },
      characters: [
        {
          id: '1001',
          name: '测试角色1',
          weaponType: 'sword',
          roles: ['support'],
          energyCost: 60,
          energyNeeds: 'medium',
          capabilities: ['off-field'],
          applicationNotes: [],
          kitNotes: [],
          unknownFields: []
        }
      ]
    });
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan({ confidence: 'high' })]),
      apiKey: 'secret',
      knowledge
    }).recommend(abyssInput());

    expect(result.status).toBe('planned');
    if (result.status === 'planned') {
      expect(result.source).toBe('smart-service');
      expect(result.plan.confidence).toBe('low');
      expect(result.assumptions.join(' ')).toContain('角色知识仅覆盖 1 / 8');
      expect(result.plan.assumptions.join(' ')).toContain('partial-knowledge-v1');
    }
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
        usableForRecommendation: false,
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

  it.each(['fresh', 'expiring'] as const)(
    'allows verified last-known-good %s data and carries the refresh warning into the plan',
    async (freshness) => {
      const runner = new FixtureRunner([validAbyssPlan()]);
      const result = await service({
        runner,
        scenarioView: {
          status: 'ready',
          trust: 'production',
          snapshotStatus: 'last-known-good',
          refreshErrorCode: 'network-unavailable',
          refreshWarning: '正在使用最近一次已确认的资料；本次刷新失败。',
          notCurrent: false,
          usableForRecommendation: true,
          freshness,
          checkedAt: '2026-07-23T00:00:00.000Z',
          scenario: abyssScenario()
        }
      }).recommend(abyssInput());

      expect(result.status).toBe('planned');
      expect(result.warnings).toContain('正在使用最近一次已确认的资料；本次刷新失败。');
      if (result.status === 'planned') {
        expect(result.plan.warnings).toContain('正在使用最近一次已确认的资料；本次刷新失败。');
      }
    }
  );

  it('aborts a hung smart-service request and falls back to local rules', async () => {
    const appendAbyss = vi.fn();
    const advisor = service({
      runner: new HangingRunner() as never,
      apiKey: 'secret',
      agentTimeoutMs: 10,
      appendAbyss
    });
    const result = await advisor.recommend(abyssInput());
    expect(result).toMatchObject({ status: 'planned', source: 'local-rules' });
    expect(result.warnings.join(' ')).toContain('智能服务');
    expect(appendAbyss).toHaveBeenCalledTimes(1);
    expect(appendAbyss).toHaveBeenCalledWith(expect.objectContaining({ source: 'local-rules' }));
  });

  it('cancels a hanging Critique stage without saving a fallback or partial history', async () => {
    const runner = new HangingAfterComposeRunner();
    const appendAbyss = vi.fn();
    const advisor = service({
      runner: runner as never,
      apiKey: 'secret',
      agentTimeoutMs: 1_000,
      appendAbyss
    });
    const pending = advisor.recommend(abyssInput());
    await runner.stageStarted;
    expect(advisor.cancel()).toBe(true);
    await expect(pending).rejects.toThrow('cancelled');
    expect(runner.calls).toBe(2);
    expect(appendAbyss).not.toHaveBeenCalled();
  });

  it('cancels while scenario data is still loading and never starts generation or history writes', async () => {
    let resolveScenario!: (view: AbyssScenarioView) => void;
    const scenarioPromise = new Promise<AbyssScenarioView>((resolve) => {
      resolveScenario = resolve;
    });
    const appendAbyss = vi.fn();
    const runner = new FixtureRunner([validAbyssPlan()]);
    const advisor = service({
      runner,
      apiKey: 'secret',
      appendAbyss,
      scenarioService: { getView: () => scenarioPromise }
    });

    const pending = advisor.recommend(abyssInput());
    expect(advisor.cancel()).toBe(true);
    await expect(pending).rejects.toThrow('cancelled');
    resolveScenario(readyScenario());
    expect(runner.calls).toBe(0);
    expect(appendAbyss).not.toHaveBeenCalled();
  });

  it('persists development-sample trust so history cannot present rehearsal data as current', async () => {
    const appendAbyss = vi.fn();
    const baseScenario = abyssScenario();
    const development = {
      status: 'ready' as const,
      trust: 'development-sample' as const,
      notCurrent: true as const,
      freshness: 'unknown' as const,
      checkedAt: '2026-07-23T00:00:00.000Z',
      scenario: {
        mode: baseScenario.mode,
        id: 'development.spiral-abyss.sample',
        meta: {
          schemaVersion: 2 as const,
          dataVersion: 'development.sample-v1',
          effectiveFrom: baseScenario.meta.effectiveFrom,
          reviewedAt: baseScenario.meta.reviewedAt,
          reviewedBy: baseScenario.meta.reviewedBy,
          syntheticProvenance: {
            kind: 'synthetic-development-data' as const,
            disclaimer: '仅用于演练。',
            fields: [{ fieldPath: 'scenario.floors' as const, note: '合成敌情。' }]
          }
        },
        blessing: baseScenario.blessing,
        floors: baseScenario.floors
      }
    } satisfies AbyssScenarioView;
    const result = await service({
      runner: new FixtureRunner([validAbyssPlan()]),
      appendAbyss,
      scenarioView: development
    }).recommend(
      abyssInput({
        scenarioId: development.scenario.id,
        dataVersion: development.scenario.meta.dataVersion
      })
    );

    expect(result.status).toBe('planned');
    expect(appendAbyss).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioTrust: 'development-sample' })
    );
  });
});
