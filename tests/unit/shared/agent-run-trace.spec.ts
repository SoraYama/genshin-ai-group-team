import { describe, expect, it } from 'vitest';

import { agentRunTraceSchema, sanitizeTraceText } from '../../../src/shared/agent-run-trace.js';

const startedAt = '2026-07-24T10:00:00+08:00';
const finishedAt = '2026-07-24T10:00:01+08:00';

function runningTrace() {
  return {
    status: 'running' as const,
    correlationId: 'trace-1',
    startedAt,
    model: 'claude-sonnet-4-6',
    stages: [],
    knowledge: { trusted: 2, ephemeral: 1, unknown: 1, searched: true },
    usage: { inputTokens: 20, outputTokens: 5 }
  };
}

describe('agent run trace contracts', () => {
  it('redacts sensitive headers and values case-insensitively', () => {
    const sanitized = sanitizeTraceText(
      [
        'Authorization: Bearer auth-secret',
        'apiKey=api-secret',
        'Cookie=session=cookie-secret',
        'ANTHROPIC_AUTH_TOKEN=anthropic-secret',
        'bearer loose-secret',
        'X-Custom-Secret: CUSTOM-VALUE-SECRET'
      ].join('\n'),
      {
        maxBytes: 1_024,
        customHeaderValues: ['custom-value-secret']
      }
    );

    expect(sanitized.truncated).toBe(false);
    expect(sanitized.text).not.toMatch(
      /auth-secret|api-secret|cookie-secret|anthropic-secret|loose-secret|custom-value-secret/i
    );
    expect(sanitized.text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('redacts complete quoted Cookie and apiKey values', () => {
    const sanitized = sanitizeTraceText(
      ['Cookie: session="cookie-secret"; theme=dark', 'apiKey="api secret, tail"'].join('\n')
    );

    expect(sanitized.text).not.toMatch(/cookie-secret|theme=dark|api secret, tail/i);
    expect(sanitized.text).toContain('Cookie: [REDACTED]');
    expect(sanitized.text).toContain('apiKey=[REDACTED]');
  });

  it('redacts recognized fields before colliding custom values', () => {
    const sanitized = sanitizeTraceText('apiKey="collision-secret"', {
      customHeaderValues: ['apiKey']
    });

    expect(sanitized.text).not.toContain('collision-secret');
  });

  it('caps input work and marks input-prefix truncation', () => {
    const sanitized = sanitizeTraceText('x'.repeat(100_000), { maxBytes: 65_536 });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text.length).toBeLessThanOrEqual(32_768);
  });

  it('rejects output budgets above the production maximum', () => {
    expect(() => sanitizeTraceText('safe', { maxBytes: 65_537 })).toThrow(RangeError);
  });

  it('bounds custom header value count and length before regex construction', () => {
    expect(() =>
      sanitizeTraceText('safe', {
        customHeaderValues: Array.from({ length: 33 }, (_, index) => `secret-${index}`)
      })
    ).toThrow(RangeError);
    expect(() =>
      sanitizeTraceText('safe', {
        customHeaderValues: ['x'.repeat(513)]
      })
    ).toThrow(RangeError);
  });

  it('redacts an unterminated quoted secret cut by the input boundary', () => {
    const input = `${'x'.repeat(32_736)}\napiKey="${'boundary-secret '.repeat(20)}`;
    const sanitized = sanitizeTraceText(input, { maxBytes: 65_536 });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).not.toContain('boundary-secret');
  });

  it('truncates by UTF-8 bytes without splitting characters and marks truncation', () => {
    const sanitized = sanitizeTraceText('甲乙丙丁', { maxBytes: 7 });

    expect(sanitized).toEqual({ text: '甲乙', truncated: true });
    expect(new TextEncoder().encode(sanitized.text).byteLength).toBeLessThanOrEqual(7);
  });

  it('allows a running trace to omit finalSource', () => {
    expect(agentRunTraceSchema.parse(runningTrace())).not.toHaveProperty('finalSource');
  });

  it('bounds run timestamps', () => {
    const oversizedDatetime = `2026-07-24T10:00:00.${'1'.repeat(100_000)}+08:00`;

    expect(
      agentRunTraceSchema.safeParse({ ...runningTrace(), startedAt: oversizedDatetime }).success
    ).toBe(false);
    expect(
      agentRunTraceSchema.safeParse({
        ...runningTrace(),
        status: 'completed',
        finishedAt: oversizedDatetime,
        finalSource: 'smart-service'
      }).success
    ).toBe(false);
  });

  it('bounds failure detail key cardinality', () => {
    const details = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`detail-${index}`, `value-${index}`])
    );

    expect(
      agentRunTraceSchema.safeParse({
        ...runningTrace(),
        status: 'failed',
        finishedAt,
        finalSource: 'blocked',
        failure: {
          code: 'PROVIDER_ERROR',
          message: 'Provider request failed',
          retryable: true,
          details
        }
      }).success
    ).toBe(false);
  });

  it.each(['completed', 'failed'] as const)('requires finalSource when status is %s', (status) => {
    const terminal = {
      ...runningTrace(),
      status,
      finishedAt,
      ...(status === 'failed'
        ? {
            failure: {
              code: 'PROVIDER_ERROR',
              message: 'Provider request failed',
              retryable: true
            }
          }
        : {})
    };

    expect(agentRunTraceSchema.safeParse(terminal).success).toBe(false);
    expect(
      agentRunTraceSchema.safeParse({
        ...terminal,
        finalSource: status === 'completed' ? 'smart-service' : 'blocked'
      }).success
    ).toBe(true);
  });

  it('accepts bounded stage details with stable failure codes', () => {
    const trace = agentRunTraceSchema.parse({
      ...runningTrace(),
      status: 'failed',
      finishedAt,
      finalSource: 'blocked',
      stages: [
        {
          stage: 'research',
          status: 'failed',
          inputSummary: '查询当前角色攻略',
          rawOutput: 'provider unavailable',
          tools: [
            {
              name: 'search_guides',
              status: 'failed',
              durationMs: 20,
              failure: {
                code: 'SEARCH_UNAVAILABLE',
                message: 'Search provider unavailable',
                retryable: true
              }
            }
          ],
          citationIds: [],
          usage: { inputTokens: 10, outputTokens: 0 },
          durationMs: 25,
          failure: {
            code: 'SEARCH_UNAVAILABLE',
            message: 'Search provider unavailable',
            retryable: true
          },
          truncated: false
        }
      ],
      failure: {
        code: 'SEARCH_UNAVAILABLE',
        message: 'Search provider unavailable',
        retryable: true
      }
    });

    expect(trace.stages[0]).toMatchObject({
      stage: 'research',
      status: 'failed',
      failure: { code: 'SEARCH_UNAVAILABLE' }
    });
  });
});
