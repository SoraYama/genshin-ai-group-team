import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AgentRunTraceStore,
  type CompleteStageInput,
  type StartTraceInput
} from '../../../src/main/services/agent-run-trace-store.js';
import { agentRunTraceSchema } from '../../../src/shared/agent-run-trace.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };
const KNOWLEDGE = { trusted: 2, ephemeral: 1, unknown: 3, searched: true };

function run(correlationId: string, overrides: Partial<StartTraceInput> = {}): StartTraceInput {
  return {
    correlationId,
    model: 'test-model',
    knowledge: KNOWLEDGE,
    startedAt: '2026-07-25T00:00:00.000Z',
    ...overrides
  };
}

function completedStage(
  stage: CompleteStageInput['stage'],
  overrides: Partial<CompleteStageInput> = {}
): CompleteStageInput {
  return {
    stage,
    rawOutput: '{"ok":true}',
    tools: [],
    citationIds: [],
    usage: ZERO_USAGE,
    durationMs: 12,
    ...overrides
  };
}

describe('AgentRunTraceStore lifecycle', () => {
  it('replaces every field from the previous run when a new run starts', () => {
    const store = new AgentRunTraceStore();
    store.start(run('one'));
    store.startStage('one', { stage: 'compose', inputSummary: 'old-input' });
    store.completeStage('one', completedStage('compose', { rawOutput: 'old raw model output' }));
    store.finish('one', { finalSource: 'smart-service' });

    store.start(run('two', { model: 'new-model' }));

    expect(store.latest()).toMatchObject({
      correlationId: 'two',
      model: 'new-model',
      status: 'running',
      stages: []
    });
    expect(JSON.stringify(store.latest())).not.toContain('one');
    expect(JSON.stringify(store.latest())).not.toContain('old raw model output');
  });

  it('ignores stale correlations and every write after a terminal state', () => {
    const store = new AgentRunTraceStore();
    store.start(run('old'));
    store.start(run('current'));
    store.startStage('old', { stage: 'compose', inputSummary: 'stale' });
    store.startStage('current', { stage: 'compose', inputSummary: 'current' });
    store.completeStage('old', completedStage('compose', { rawOutput: 'stale raw' }));
    store.completeStage('current', completedStage('compose', { rawOutput: 'current raw' }));
    store.finish('old', {
      finalSource: 'blocked',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'stale failure',
        retryable: true
      }
    });
    store.finish('current', { finalSource: 'smart-service' });
    const terminal = store.latest();

    store.startStage('current', { stage: 'explain', inputSummary: 'late start' });
    store.failStage('current', {
      stage: 'compose',
      rawOutput: 'late failure',
      tools: [],
      citationIds: [],
      usage: ZERO_USAGE,
      failure: {
        code: 'VALIDATION_FAILED',
        message: 'late',
        retryable: false
      }
    });
    store.finish('current', {
      finalSource: 'blocked',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'duplicate finish',
        retryable: false
      }
    });

    expect(store.latest()).toEqual(terminal);
  });

  it('rejects unmatched and duplicate stage terminals without mutating the run', () => {
    const store = new AgentRunTraceStore();
    store.start(run('run'));
    const before = store.latest();
    store.completeStage('run', completedStage('compose'));
    expect(store.latest()).toEqual(before);

    store.startStage('run', { stage: 'compose', inputSummary: 'one' });
    store.completeStage('run', completedStage('compose'));
    const completed = store.latest();
    store.completeStage('run', completedStage('compose', { rawOutput: 'duplicate' }));
    store.failStage('run', {
      stage: 'compose',
      rawOutput: 'duplicate failure',
      tools: [],
      citationIds: [],
      usage: ZERO_USAGE,
      failure: {
        code: 'AGENT_OUTPUT_INVALID',
        message: 'duplicate',
        retryable: false
      }
    });
    expect(store.latest()).toEqual(completed);
  });

  it('returns a structured clone that cannot mutate internal state', () => {
    const store = new AgentRunTraceStore();
    store.start(run('clone'));
    store.startStage('clone', { stage: 'compose', inputSummary: 'safe' });
    const external = store.latest();
    if (!external) throw new Error('Expected trace');
    external.stages[0]!.inputSummary = 'mutated';
    external.knowledge.trusted = 999;

    expect(store.latest()).toMatchObject({
      knowledge: { trusted: 2 },
      stages: [{ inputSummary: 'safe' }]
    });
  });

  it('records skipped stages and produces schema-valid completed and failed traces', () => {
    const store = new AgentRunTraceStore();
    store.start(run('completed'));
    store.skipStage('completed', { stage: 'repair-1', inputSummary: 'not required' });
    store.finish('completed', {
      finalSource: 'local-rules',
      finishedAt: '2026-07-25T00:00:01.000Z'
    });
    expect(agentRunTraceSchema.safeParse(store.latest()).success).toBe(true);
    expect(store.latest()).toMatchObject({
      status: 'completed',
      finalSource: 'local-rules',
      stages: [{ stage: 'repair-1', status: 'skipped' }]
    });

    store.start(run('failed'));
    store.finish('failed', {
      finalSource: 'blocked',
      failure: {
        code: 'AGENT_ABORTED',
        message: 'cancelled',
        retryable: true
      }
    });
    expect(agentRunTraceSchema.safeParse(store.latest()).success).toBe(true);
    expect(store.latest()).toMatchObject({
      status: 'failed',
      finalSource: 'blocked',
      failure: { code: 'AGENT_ABORTED' }
    });
  });
});

describe('AgentRunTraceStore privacy boundary', () => {
  it('keeps safe model text verbatim while explicitly marking redacted sensitive text', () => {
    const store = new AgentRunTraceStore();
    const safeRaw = '这套阵容先水后草，循环稳定。';
    store.start(
      run('privacy', {
        sensitiveValues: ['naked-provider-secret', 'PRIVATE-NICKNAME']
      })
    );
    store.startStage('privacy', { stage: 'compose', inputSummary: safeRaw });
    store.completeStage(
      'privacy',
      completedStage('compose', {
        rawOutput:
          `${safeRaw}\nUID: 123456789\nCookie: ltoken_v2=secret-cookie\n` +
          'Authorization: Bearer bearer-secret\napiKey=sk-private\n' +
          'nickname: PRIVATE-NICKNAME\nnaked-provider-secret',
        tools: [
          {
            name: 'mcp__genshin__read_profile_cache',
            status: 'completed',
            inputSummary: JSON.stringify({
              uid: '123456789',
              Authorization: 'Bearer bearer-secret'
            })
          }
        ]
      })
    );

    const trace = store.latest();
    const serialized = JSON.stringify(trace);
    expect(trace?.stages[0]?.inputSummary).toBe(safeRaw);
    expect(trace?.stages[0]?.rawOutput).toContain(safeRaw);
    expect(trace?.stages[0]?.truncated).toBe(true);
    expect(trace?.stages[0]?.tools[0]?.truncated).toBe(true);
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('secret-cookie');
    expect(serialized).not.toContain('bearer-secret');
    expect(serialized).not.toContain('sk-private');
    expect(serialized).not.toContain('PRIVATE-NICKNAME');
    expect(serialized).not.toContain('naked-provider-secret');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts correlation, model, failure, and citation fields at the same store boundary', () => {
    const store = new AgentRunTraceStore();
    store.start(
      run('uid-123456789', {
        model: 'model Cookie=private-cookie',
        sensitiveValues: ['private-cookie']
      })
    );
    const publicCorrelationId = store.latest()!.correlationId;
    store.startStage('uid-123456789', {
      stage: 'compose',
      citationIds: ['uid-987654321']
    });
    store.failStage('uid-123456789', {
      stage: 'compose',
      rawOutput: 'safe raw',
      tools: [],
      citationIds: ['uid-987654321'],
      usage: ZERO_USAGE,
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'Authorization: Bearer failure-secret',
        retryable: true,
        details: { account: 'nickname: PRIVATE' }
      }
    });
    store.finish('uid-123456789', {
      finalSource: 'blocked',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'Cookie=private-cookie',
        retryable: true
      }
    });

    const serialized = JSON.stringify(store.latest());
    expect(publicCorrelationId).not.toContain('123456789');
    expect(serialized).not.toContain('987654321');
    expect(serialized).not.toContain('private-cookie');
    expect(serialized).not.toContain('failure-secret');
    expect(serialized).not.toContain('PRIVATE');
    expect(agentRunTraceSchema.safeParse(store.latest()).success).toBe(true);
  });
});

describe('AgentRunTraceStore UTF-8 budget', () => {
  it('keeps UTF-8-safe head and tail for a single oversized CJK and emoji stage', () => {
    const store = new AgentRunTraceStore({ maxBytes: 8_000 });
    const raw = `HEAD-${'原神🙂'.repeat(5_000)}-TAIL`;
    store.start(run('large'));
    store.startStage('large', { stage: 'compose', inputSummary: 'input' });
    store.completeStage('large', completedStage('compose', { rawOutput: raw }));

    const trace = store.latest();
    const output = trace?.stages[0]?.rawOutput ?? '';
    expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeLessThanOrEqual(8_000);
    expect(output.startsWith('HEAD-')).toBe(true);
    expect(output.endsWith('-TAIL')).toBe(true);
    expect(output).toContain('[TRUNCATED]');
    expect(output).not.toContain('\uFFFD');
    expect(trace?.stages[0]?.truncated).toBe(true);
    expect(agentRunTraceSchema.safeParse(trace).success).toBe(true);
  });

  it('enforces the aggregate budget across stages while retaining stage metadata', () => {
    const store = new AgentRunTraceStore({ maxBytes: 12_000 });
    store.start(run('aggregate'));
    for (const stage of ['compose', 'repair-1', 'critique', 'rotation', 'explain'] as const) {
      store.startStage('aggregate', { stage, inputSummary: `${stage}-${'输入'.repeat(1_000)}` });
      store.completeStage(
        'aggregate',
        completedStage(stage, { rawOutput: `${stage}-${'输出🙂'.repeat(1_500)}-${stage}` })
      );
    }

    const trace = store.latest();
    expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeLessThanOrEqual(12_000);
    expect(trace?.stages.map(({ stage }) => stage)).toEqual([
      'compose',
      'repair-1',
      'critique',
      'rotation',
      'explain'
    ]);
    expect(trace?.stages.every(({ usage }) => usage.inputTokens === 0)).toBe(true);
    expect(trace?.stages.some(({ truncated }) => truncated === true)).toBe(true);
  });

  it('retains failure, tool outcome, and token usage when compacting text', () => {
    const store = new AgentRunTraceStore({ maxBytes: 7_000 });
    store.start(run('failure-budget'));
    store.startStage('failure-budget', {
      stage: 'compose',
      inputSummary: '输入'.repeat(4_000)
    });
    store.failStage('failure-budget', {
      stage: 'compose',
      rawOutput: `head-${'原文🙂'.repeat(4_000)}-tail`,
      tools: [
        {
          name: 'mcp__genshin__query_enemy_data',
          status: 'failed',
          inputSummary: '参数'.repeat(2_000),
          failure: {
            code: 'TOOL_REQUIREMENT_FAILED',
            message: 'tool failed',
            retryable: false
          }
        }
      ],
      citationIds: [],
      usage: { inputTokens: 321, outputTokens: 123 },
      failure: {
        code: 'AGENT_OUTPUT_INVALID',
        message: 'schema invalid',
        retryable: false
      }
    });

    const trace = store.latest();
    expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeLessThanOrEqual(7_000);
    expect(trace?.stages[0]).toMatchObject({
      status: 'failed',
      usage: { inputTokens: 321, outputTokens: 123 },
      failure: { code: 'AGENT_OUTPUT_INVALID' },
      tools: [
        {
          name: 'mcp__genshin__query_enemy_data',
          status: 'failed',
          failure: { code: 'TOOL_REQUIREMENT_FAILED' }
        }
      ]
    });
  });
});

describe('AgentRunTraceStore persistence boundary', () => {
  it('does not import filesystem, Electron storage, or history persistence', () => {
    const sourcePath = fileURLToPath(
      new URL('../../../src/main/services/agent-run-trace-store.ts', import.meta.url)
    );
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/from ['"]node:fs/u);
    expect(source).not.toMatch(/from ['"]electron-store/u);
    expect(source).not.toMatch(/HistoryStore|history-store/u);
    expect(source).not.toMatch(/setInterval|setTimeout/u);
  });
});
