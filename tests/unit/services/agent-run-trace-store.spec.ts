import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AgentRunTraceStore,
  MIN_AGENT_RUN_TRACE_BYTES,
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
    const firstLease = store.start(run('one'));
    store.startStage(firstLease, { stage: 'compose', inputSummary: 'old-input' });
    store.completeStage(
      firstLease,
      completedStage('compose', { rawOutput: 'old raw model output' })
    );
    store.finish(firstLease, { finalSource: 'smart-service' });

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
    const staleLease = store.start(run('old'));
    const currentLease = store.start(run('current'));
    store.startStage(staleLease, { stage: 'compose', inputSummary: 'stale' });
    store.startStage(currentLease, { stage: 'compose', inputSummary: 'current' });
    store.completeStage(staleLease, completedStage('compose', { rawOutput: 'stale raw' }));
    store.completeStage(currentLease, completedStage('compose', { rawOutput: 'current raw' }));
    store.finish(staleLease, {
      finalSource: 'blocked',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'stale failure',
        retryable: true
      }
    });
    store.finish(currentLease, { finalSource: 'smart-service' });
    const terminal = store.latest();

    store.startStage(currentLease, { stage: 'explain', inputSummary: 'late start' });
    store.failStage(currentLease, {
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
    store.finish(currentLease, {
      finalSource: 'blocked',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'duplicate finish',
        retryable: false
      }
    });

    expect(store.latest()).toEqual(terminal);
  });

  it('uses an opaque per-start lease when the same correlation ID is reused', () => {
    const store = new AgentRunTraceStore();
    const oldLease = store.start(run('same-correlation'));
    store.startStage(oldLease, { stage: 'compose', inputSummary: 'old input' });

    const currentLease = store.start(run('same-correlation'));
    store.startStage(currentLease, { stage: 'compose', inputSummary: 'current input' });
    store.completeStage(oldLease, completedStage('compose', { rawOutput: 'stale async output' }));
    store.completeStage(currentLease, completedStage('compose', { rawOutput: 'current output' }));
    store.finish(oldLease, {
      finalSource: 'blocked',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'stale terminal',
        retryable: true
      }
    });
    store.finish(currentLease, { finalSource: 'smart-service' });

    expect(store.latest()).toMatchObject({
      correlationId: 'same-correlation',
      status: 'completed',
      stages: [
        {
          stage: 'compose',
          status: 'completed',
          inputSummary: 'current input',
          rawOutput: 'current output'
        }
      ]
    });
    expect(JSON.stringify(store.latest())).not.toContain('stale async output');
  });

  it('rejects unmatched and duplicate stage terminals without mutating the run', () => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('run'));
    const before = store.latest();
    store.completeStage(lease, completedStage('compose'));
    expect(store.latest()).toEqual(before);

    store.startStage(lease, { stage: 'compose', inputSummary: 'one' });
    store.completeStage(lease, completedStage('compose'));
    const completed = store.latest();
    store.completeStage(lease, completedStage('compose', { rawOutput: 'duplicate' }));
    store.failStage(lease, {
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
    const lease = store.start(run('clone'));
    store.startStage(lease, { stage: 'compose', inputSummary: 'safe' });
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
    const completedLease = store.start(run('completed'));
    store.skipStage(completedLease, { stage: 'repair-1', inputSummary: 'not required' });
    store.finish(completedLease, {
      finalSource: 'local-rules',
      finishedAt: '2026-07-25T00:00:01.000Z'
    });
    expect(agentRunTraceSchema.safeParse(store.latest()).success).toBe(true);
    expect(store.latest()).toMatchObject({
      status: 'completed',
      finalSource: 'local-rules',
      stages: [{ stage: 'repair-1', status: 'skipped' }]
    });

    const failedLease = store.start(run('failed'));
    store.finish(failedLease, {
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

  it('keeps the previous trace, lease, and secret registry when a replacement start is invalid', () => {
    const store = new AgentRunTraceStore();
    const lease = store.start(
      run('stable-run', {
        sensitiveValues: ['stable-secret']
      })
    );
    const before = store.latest();

    expect(() =>
      store.start(
        run('invalid-run', {
          startedAt: 'not-an-iso-timestamp',
          sensitiveValues: ['replacement-secret']
        })
      )
    ).toThrow(TypeError);
    expect(store.latest()).toEqual(before);

    store.startStage(lease, { stage: 'compose' });
    store.completeStage(
      lease,
      completedStage('compose', { rawOutput: 'stable-secret replacement-secret' })
    );
    expect(store.latest()?.stages[0]?.rawOutput).toBe('[REDACTED] replacement-secret');
  });
});

describe('AgentRunTraceStore privacy boundary', () => {
  it('keeps safe model text verbatim while explicitly marking redacted sensitive text', () => {
    const store = new AgentRunTraceStore();
    const safeRaw = '这套阵容先水后草，循环稳定。';
    const lease = store.start(
      run('privacy', {
        sensitiveValues: ['naked-provider-secret', 'PRIVATE-NICKNAME']
      })
    );
    store.startStage(lease, { stage: 'compose', inputSummary: safeRaw });
    store.completeStage(
      lease,
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
    const lease = store.start(
      run('uid-123456789', {
        model: 'model Cookie=private-cookie',
        sensitiveValues: ['private-cookie']
      })
    );
    const publicCorrelationId = store.latest()!.correlationId;
    store.startStage(lease, {
      stage: 'compose',
      citationIds: ['uid-987654321']
    });
    store.failStage(lease, {
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
    store.finish(lease, {
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

  it('keeps ordinary large gameplay numbers verbatim while redacting a registered UID', () => {
    const store = new AgentRunTraceStore();
    const lease = store.start(
      run('numeric-context', {
        sensitiveValues: ['123456789']
      })
    );
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(
      lease,
      completedStage('compose', {
        rawOutput: '伤害 1234567890，累计 9876543210；UID: 123456789'
      })
    );

    const raw = store.latest()?.stages[0]?.rawOutput;
    expect(raw).toContain('1234567890');
    expect(raw).toContain('9876543210');
    expect(raw).not.toContain('UID: 123456789');
    expect(raw).toContain('UID: [REDACTED]');
  });

  it.each([
    {
      name: 'fullwidth UID after an ASCII UID',
      raw: 'UID: 234567890\nＵＩＤ：３４５６７８９０１'
    },
    {
      name: 'zero-width UID after an ASCII UID',
      raw: 'UID: 234567890\nU\u200bID:456789012'
    },
    {
      name: 'percent-encoded UID after an ASCII UID',
      raw: 'UID: 234567890\nUID%3A%20567890123'
    },
    {
      name: 'percent-encoded UID mixed with an unrelated literal percent sign',
      raw: '100% uptime\nUID: 234567890\nUID%3A%20678901234'
    },
    {
      name: 'ASCII UID after a hidden UID',
      raw: 'ＵＩＤ：３４５６７８９０１\nUID: 234567890'
    },
    {
      name: 'multiple hidden UIDs mixed with an ASCII UID',
      raw: 'U\u200bID:456789012\nUID: 234567890\nUID%253A%2520567890123\nＵＩＤ：３４５６７８９０１'
    },
    {
      name: 'hidden credential semantics after an ASCII credential',
      raw: 'apiKey=plain-secret\nＡＰＩＫｅｙ：hidden-secret'
    }
  ])('fails closed for $name', ({ raw }) => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('mixed-obfuscated-uid'));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(lease, completedStage('compose', { rawOutput: raw }));

    expect(store.latest()?.stages[0]?.rawOutput).toBe('[REDACTED]');
  });

  it('redacts multiple ordinary ASCII UID fields without hiding unrelated large numbers', () => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('ordinary-uid-fields'));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(
      lease,
      completedStage('compose', {
        rawOutput: '伤害 1234567890\nUID: 234567890\n累计 9876543210\ngame_uid=345678901'
      })
    );

    expect(store.latest()?.stages[0]?.rawOutput).toBe(
      '伤害 1234567890\nUID: [REDACTED]\n累计 9876543210\ngame_uid=[REDACTED]'
    );
  });

  it.each([
    {
      name: 'fullwidth UID marker followed by digits',
      raw: 'ＵＩＤ：[REDACTED] 345678901'
    },
    {
      name: 'fullwidth apiKey marker followed by text',
      raw: 'ａｐｉＫｅｙ：[REDACTED] second-secret'
    },
    {
      name: 'fullwidth nickname marker followed by text',
      raw: 'Ｎｉｃｋｎａｍｅ：[REDACTED] private-tail'
    },
    {
      name: 'fullwidth Authorization marker followed by text',
      raw: 'Ａｕｔｈｏｒｉｚａｔｉｏｎ：[REDACTED] bearer-tail'
    },
    {
      name: 'fullwidth Cookie marker followed by text',
      raw: 'Ｃｏｏｋｉｅ：[REDACTED] session-tail'
    },
    {
      name: 'percent-encoded marker followed by digits',
      raw: 'UID%3A%20%5BREDACTED%5D%20345678901'
    },
    {
      name: 'zero-width UID marker followed by digits',
      raw: 'U\u200bID:[REDACTED] 345678901'
    },
    {
      name: 'mixed ASCII UID and hidden marker tail',
      raw: 'UID: 234567890\nＵＩＤ：[REDACTED] 345678901'
    },
    {
      name: 'marker followed by a second marker',
      raw: 'ＵＩＤ：[REDACTED] [REDACTED]'
    }
  ])('rejects canonical sensitive marker prefixes for $name', ({ raw }) => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('marker-prefix'));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(lease, completedStage('compose', { rawOutput: raw }));

    expect(store.latest()?.stages[0]?.rawOutput).toBe('[REDACTED]');
  });

  it('redacts the full unquoted credential value instead of leaving a second token', () => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('credential-tail'));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(
      lease,
      completedStage('compose', {
        rawOutput: 'apiKey=first-secret second-secret'
      })
    );

    expect(store.latest()?.stages[0]?.rawOutput).toBe('apiKey=[REDACTED]');
  });

  it('keeps JSON, comma, and newline fields outside credential value boundaries', () => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('credential-boundaries'));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(
      lease,
      completedStage('compose', {
        rawOutput: [
          '{"apiKey":"json secret","safe":"keep-json"}',
          'apiKey=first second, safe=keep-comma',
          'Cookie=session secret',
          'safe-line=keep-newline',
          'UID:[REDACTED]'
        ].join('\n')
      })
    );

    expect(store.latest()?.stages[0]?.rawOutput).toBe(
      [
        '{"apiKey":"[REDACTED]","safe":"keep-json"}',
        'apiKey=[REDACTED], safe=keep-comma',
        'Cookie=[REDACTED]',
        'safe-line=keep-newline',
        'UID:[REDACTED]'
      ].join('\n')
    );
  });

  it.each([
    {
      name: 'plain Cookie comma boundary',
      raw: 'Cookie: first-secret, safe=keep-comma',
      expected: 'Cookie: [REDACTED], safe=keep-comma'
    },
    {
      name: 'plain Authorization comma boundary',
      raw: 'Authorization: Bearer first-secret, safe=keep-comma',
      expected: 'Authorization: [REDACTED], safe=keep-comma'
    },
    {
      name: 'Cookie semicolon chain before a comma',
      raw: 'Cookie: first=one; second=two, safe=keep-comma',
      expected: 'Cookie: [REDACTED], safe=keep-comma'
    },
    {
      name: 'multiple credentials and a safe field on one line',
      raw: 'Cookie: first=one; second=two, Authorization: Bearer auth-secret, safe=keep',
      expected: 'Cookie: [REDACTED], Authorization: [REDACTED], safe=keep'
    },
    {
      name: 'newline boundary',
      raw: 'Authorization: Bearer auth-secret\nsafe=keep-newline',
      expected: 'Authorization: [REDACTED]\nsafe=keep-newline'
    },
    {
      name: 'object closing boundary',
      raw: '{Cookie: first=one; second=two} safe=keep-object',
      expected: '{Cookie: [REDACTED]} safe=keep-object'
    },
    {
      name: 'quoted JSON fields',
      raw: '{"Cookie":"json-secret","Authorization":"Bearer auth-secret","safe":"keep-json"}',
      expected: '{"Cookie":"[REDACTED]","Authorization":"[REDACTED]","safe":"keep-json"}'
    }
  ])('preserves safe fields at $name', ({ raw, expected }) => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('plain-credential-boundary'));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(lease, completedStage('compose', { rawOutput: raw }));

    expect(store.latest()?.stages[0]?.rawOutput).toBe(expected);
  });

  it('redacts more than 32 production-sized secrets without exposing the registry', () => {
    const secrets = Array.from(
      { length: 40 },
      (_, index) => `stage-secret-${String(index).padStart(3, '0')}-${'x'.repeat(580)}`
    );
    const store = new AgentRunTraceStore();
    const lease = store.start(run('many-secrets', { sensitiveValues: secrets }));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(
      lease,
      completedStage('compose', {
        rawOutput: secrets.join('\n')
      })
    );

    const serialized = JSON.stringify(store.latest());
    secrets.forEach((secret) => expect(serialized).not.toContain(secret));
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('sensitiveValues');
  });

  it.each([
    {
      name: 'a single value exceeds the per-secret limit',
      secrets: [`api-${'z'.repeat(4_094)}`]
    },
    {
      name: 'the registry exceeds the maximum secret count',
      secrets: Array.from({ length: 65 }, (_, index) => `secret-${index}`)
    },
    {
      name: 'the registry exceeds the aggregate character limit',
      secrets: Array.from({ length: 17 }, (_, index) => `aggregate-${index}-${'a'.repeat(3_990)}`)
    }
  ])('fails closed when $name', ({ secrets }) => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('unsafe-registry', { sensitiveValues: secrets }));
    store.startStage(lease, {
      stage: 'compose',
      inputSummary: 'otherwise safe input'
    });
    store.completeStage(
      lease,
      completedStage('compose', {
        rawOutput: `safe-looking text ${secrets[0]}`
      })
    );

    const trace = store.latest();
    expect(JSON.stringify(trace)).not.toContain(secrets[0]);
    expect(trace?.model).toBe('[REDACTED]');
    expect(trace?.stages[0]).toMatchObject({
      inputSummary: '[REDACTED]',
      rawOutput: '[REDACTED]',
      truncated: true
    });
  });

  it('re-sanitizes earlier trace text when a stage registers a secret late', () => {
    const lateSecret = `late-${'s'.repeat(595)}`;
    const store = new AgentRunTraceStore();
    const lease = store.start(run('late-registration'));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(
      lease,
      completedStage('compose', { rawOutput: `earlier output ${lateSecret}` })
    );
    expect(JSON.stringify(store.latest())).toContain(lateSecret);

    store.startStage(lease, {
      stage: 'critique',
      sensitiveValues: [lateSecret]
    });

    const trace = store.latest();
    expect(JSON.stringify(trace)).not.toContain(lateSecret);
    expect(trace?.stages[0]).toMatchObject({ truncated: true });
    expect(trace?.stages[1]).toMatchObject({ stage: 'critique', status: 'started' });
  });

  it('re-sanitizes an encoded earlier secret when a later stage registers its canonical value', () => {
    const store = new AgentRunTraceStore();
    const lease = store.start(run('late-canonical-registration'));
    store.startStage(lease, { stage: 'compose' });
    store.completeStage(
      lease,
      completedStage('compose', {
        rawOutput: 'earlier token %2573%256B%252D%2541%2570%2569%255F%254F%256E%2565'
      })
    );

    store.startStage(lease, {
      stage: 'critique',
      sensitiveValues: ['sk-Api_One']
    });

    expect(store.latest()?.stages[0]?.rawOutput).toBe('[REDACTED]');
  });
});

describe('AgentRunTraceStore UTF-8 budget', () => {
  it('keeps UTF-8-safe head and tail for a single oversized CJK and emoji stage', () => {
    const store = new AgentRunTraceStore({ maxBytes: MIN_AGENT_RUN_TRACE_BYTES });
    const raw = `HEAD-${'原神🙂'.repeat(5_000)}-TAIL`;
    const lease = store.start(run('large'));
    store.startStage(lease, { stage: 'compose', inputSummary: 'input' });
    store.completeStage(lease, completedStage('compose', { rawOutput: raw }));

    const trace = store.latest();
    const output = trace?.stages[0]?.rawOutput ?? '';
    expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeLessThanOrEqual(
      MIN_AGENT_RUN_TRACE_BYTES
    );
    expect(output.startsWith('HEAD-')).toBe(true);
    expect(output.endsWith('-TAIL')).toBe(true);
    expect(output).toContain('[TRUNCATED]');
    expect(output).not.toContain('\uFFFD');
    expect(trace?.stages[0]?.truncated).toBe(true);
    expect(agentRunTraceSchema.safeParse(trace).success).toBe(true);
  });

  it('enforces the aggregate budget across stages while retaining stage metadata', () => {
    const store = new AgentRunTraceStore({ maxBytes: MIN_AGENT_RUN_TRACE_BYTES });
    const lease = store.start(run('aggregate'));
    for (const stage of ['compose', 'repair-1', 'critique', 'rotation', 'explain'] as const) {
      store.startStage(lease, { stage, inputSummary: `${stage}-${'输入'.repeat(1_000)}` });
      store.completeStage(
        lease,
        completedStage(stage, { rawOutput: `${stage}-${'输出🙂'.repeat(1_500)}-${stage}` })
      );
    }

    const trace = store.latest();
    expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeLessThanOrEqual(
      MIN_AGENT_RUN_TRACE_BYTES
    );
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
    const store = new AgentRunTraceStore({ maxBytes: MIN_AGENT_RUN_TRACE_BYTES });
    const lease = store.start(run('failure-budget'));
    store.startStage(lease, {
      stage: 'compose',
      inputSummary: '输入'.repeat(4_000)
    });
    store.failStage(lease, {
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
    expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeLessThanOrEqual(
      MIN_AGENT_RUN_TRACE_BYTES
    );
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

  it('rejects budgets below the defensible minimum', () => {
    expect(
      () => new AgentRunTraceStore({ maxBytes: MIN_AGENT_RUN_TRACE_BYTES - 1 })
    ).toThrow(RangeError);
  });

  it('always commits a valid terminal trace at the minimum budget with the maximum tool count', () => {
    const store = new AgentRunTraceStore({ maxBytes: MIN_AGENT_RUN_TRACE_BYTES });
    const lease = store.start(run('fixed-overhead'));
    store.startStage(lease, {
      stage: 'compose',
      inputSummary: 'bounded input'
    });
    store.failStage(lease, {
      stage: 'compose',
      rawOutput: 'model output',
      tools: Array.from({ length: 64 }, (_, index) => ({
        name: `${String(index).padStart(2, '0')}-${'x'.repeat(125)}`,
        status: 'completed' as const,
        inputSummary: `input-${index}-${'y'.repeat(200)}`
      })),
      citationIds: Array.from({ length: 64 }, (_, index) => `citation-${index}`),
      usage: { inputTokens: 987, outputTokens: 654 },
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'provider failed',
        retryable: true
      }
    });
    store.finish(lease, {
      finalSource: 'blocked',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'provider failed',
        retryable: true
      }
    });

    const trace = store.latest();
    expect(agentRunTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace).toMatchObject({
      status: 'failed',
      failure: { code: 'PROVIDER_ERROR', retryable: true },
      usage: { inputTokens: 987, outputTokens: 654 }
    });
    expect(trace?.stages[0]).toMatchObject({
      stage: 'compose',
      status: 'failed',
      truncated: true,
      failure: { code: 'PROVIDER_ERROR', retryable: true },
      usage: { inputTokens: 987, outputTokens: 654 }
    });
    expect(trace?.stages[0]?.tools.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeLessThanOrEqual(
      MIN_AGENT_RUN_TRACE_BYTES
    );
  });

  it('preserves all 16 failed stages, representative tools, and usage at the minimum budget', () => {
    const store = new AgentRunTraceStore({ maxBytes: MIN_AGENT_RUN_TRACE_BYTES });
    const lease = store.start(run('many-stages'));
    const stages = Array.from({ length: 16 }, (_, index) =>
      index === 0
        ? ('compose' as const)
        : index % 2 === 0
          ? ('critique' as const)
          : ('rotation' as const)
    );
    stages.forEach((stage, index) => {
      store.startStage(lease, {
        stage,
        inputSummary: `input-${index}-${'x'.repeat(1_000)}`
      });
      store.failStage(lease, {
        stage,
        rawOutput: `raw-${index}-${'原文'.repeat(1_000)}`,
        tools: [
          {
            name: `tool-${index}`,
            status: 'failed',
            inputSummary: 'x'.repeat(4_000),
            outputSummary: 'y'.repeat(4_000),
            failure: {
              code: 'TOOL_REQUIREMENT_FAILED',
              message: 'tool failed',
              retryable: false
            }
          }
        ],
        citationIds: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        failure: {
          code: 'VALIDATION_FAILED',
          message: `validation-${index}-${'detail'.repeat(100)}`,
          retryable: false
        }
      });
    });
    store.finish(lease, {
      finalSource: 'blocked',
      failure: {
        code: 'VALIDATION_FAILED',
        message: 'all attempts failed',
        retryable: false
      }
    });

    const trace = store.latest();
    expect(agentRunTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace).toMatchObject({
      status: 'failed',
      failure: { code: 'VALIDATION_FAILED', retryable: false },
      usage: { inputTokens: 160, outputTokens: 80 }
    });
    expect(trace?.stages).toHaveLength(16);
    expect(trace?.stages.every(({ status }) => status === 'failed')).toBe(true);
    expect(trace?.stages.every(({ tools }) => tools.length >= 1)).toBe(true);
    expect(
      trace?.stages.every(({ tools }) => tools[0]?.failure?.code === 'TOOL_REQUIREMENT_FAILED')
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeLessThanOrEqual(
      MIN_AGENT_RUN_TRACE_BYTES
    );
  });

  it('compacts adversarial tool payloads in bounded time', () => {
    const store = new AgentRunTraceStore({ maxBytes: MIN_AGENT_RUN_TRACE_BYTES });
    const lease = store.start(run('bounded-work'));
    store.startStage(lease, { stage: 'compose' });
    const large = 'x'.repeat(32 * 1024);
    const started = performance.now();
    store.failStage(lease, {
      stage: 'compose',
      tools: Array.from({ length: 64 }, (_, index) => ({
        name: `tool-${index}`,
        status: 'failed' as const,
        inputSummary: large,
        outputSummary: large,
        failure: {
          code: 'TOOL_REQUIREMENT_FAILED' as const,
          message: large,
          retryable: false,
          details: Object.fromEntries(
            Array.from({ length: 31 }, (__, detail) => [`detail-${detail}`, large])
          )
        }
      })),
      citationIds: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      failure: {
        code: 'VALIDATION_FAILED',
        message: 'failed',
        retryable: false
      }
    });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    expect(agentRunTraceSchema.safeParse(store.latest()).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(store.latest()), 'utf8')).toBeLessThanOrEqual(
      MIN_AGENT_RUN_TRACE_BYTES
    );
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
