import { describe, expect, it } from 'vitest';

import {
  agentRunTraceSchema,
  agentStageTraceSchema,
  MAX_TRACE_TEXT_INPUT_CHARS,
  MAX_TRACE_TEXT_MAX_BYTES,
  sanitizeTraceText
} from '../../../src/shared/agent-run-trace.js';

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

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
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

  it.each([
    {
      name: 'apiKey multi-token value before an ASCII comma',
      raw: 'apiKey=first-secret second-secret, safe=keep-comma',
      expected: 'apiKey=[REDACTED], safe=keep-comma'
    },
    {
      name: 'auth token multi-token value before a Chinese comma',
      raw: 'ANTHROPIC_AUTH_TOKEN=first-secret second-secret，safe=keep-comma',
      expected: 'ANTHROPIC_AUTH_TOKEN=[REDACTED]，safe=keep-comma'
    },
    {
      name: 'apiKey value before a semicolon',
      raw: 'apiKey=first-secret second-secret; safe=keep-semicolon',
      expected: 'apiKey=[REDACTED]; safe=keep-semicolon'
    },
    {
      name: 'auth token value before an object close',
      raw: '{ANTHROPIC_AUTH_TOKEN=first-secret second-secret} safe=keep-object',
      expected: '{ANTHROPIC_AUTH_TOKEN=[REDACTED]} safe=keep-object'
    },
    {
      name: 'apiKey value before a newline',
      raw: 'apiKey=first-secret second-secret\nsafe=keep-newline',
      expected: 'apiKey=[REDACTED]\nsafe=keep-newline'
    },
    {
      name: 'quoted JSON credential',
      raw: '{"apiKey":"first secret","safe":"keep-json"}',
      expected: '{"apiKey":"[REDACTED]","safe":"keep-json"}'
    },
    {
      name: 'multiple credentials on one line',
      raw: 'apiKey=first one, ANTHROPIC_AUTH_TOKEN=second two, safe=keep-multiple',
      expected: 'apiKey=[REDACTED], ANTHROPIC_AUTH_TOKEN=[REDACTED], safe=keep-multiple'
    }
  ])('preserves shared sanitizer boundaries for $name', ({ raw, expected }) => {
    expect(sanitizeTraceText(raw).text).toBe(expected);
  });

  it('redacts recognized fields before colliding custom values', () => {
    const sanitized = sanitizeTraceText('apiKey="collision-secret"', {
      customHeaderValues: ['apiKey']
    });

    expect(sanitized.text).not.toContain('collision-secret');
  });

  it('caps input work and marks input-prefix truncation', () => {
    const sanitized = sanitizeTraceText('x'.repeat(100_000), {
      maxBytes: MAX_TRACE_TEXT_MAX_BYTES
    });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text.length).toBeLessThanOrEqual(MAX_TRACE_TEXT_INPUT_CHARS);
  });

  it('rejects output budgets above the production maximum', () => {
    expect(() => sanitizeTraceText('safe', { maxBytes: MAX_TRACE_TEXT_MAX_BYTES + 1 })).toThrow(
      RangeError
    );
  });

  it('supports production-sized custom secrets and bounds unsafe registry growth', () => {
    const mediumSecret = `secret-${'m'.repeat(593)}`;
    const maximumSecret = `secret-${'x'.repeat(4_089)}`;
    expect(
      sanitizeTraceText(`${mediumSecret}\n${maximumSecret}`, {
        customHeaderValues: [mediumSecret, maximumSecret]
      }).text
    ).not.toMatch(/secret-/u);

    expect(() =>
      sanitizeTraceText('safe', {
        customHeaderValues: Array.from({ length: 65 }, (_, index) => `secret-${index}`)
      })
    ).toThrow(RangeError);
    expect(() =>
      sanitizeTraceText('safe', {
        customHeaderValues: ['x'.repeat(4_097)]
      })
    ).toThrow(RangeError);
    expect(() =>
      sanitizeTraceText('safe', {
        customHeaderValues: Array.from(
          { length: 17 },
          (_, index) => `aggregate-${index}-${'x'.repeat(3_990)}`
        )
      })
    ).toThrow(RangeError);
  });

  it('redacts an unterminated quoted secret cut by the input boundary', () => {
    const input = `${'x'.repeat(32_736)}\napiKey="${'boundary-secret '.repeat(20)}`;
    const sanitized = sanitizeTraceText(input, { maxBytes: MAX_TRACE_TEXT_MAX_BYTES });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).not.toContain('boundary-secret');
  });

  it('redacts repeated and overlapping custom values in one non-amplifying pass', () => {
    const sanitized = sanitizeTraceText('E RE DACT E', {
      maxBytes: MAX_TRACE_TEXT_MAX_BYTES,
      customHeaderValues: ['E', 'e', 'RE', 'DACT', 'E']
    });

    expect(sanitized).toEqual({
      text: '[REDACTED] [REDACTED] [REDACTED] [REDACTED]',
      truncated: false
    });
  });

  it('redacts a maximum-length custom secret that crosses the bounded scan edge', () => {
    const customSecret = `cust${'x'.repeat(4_092)}`;
    const input = `${'a'.repeat(MAX_TRACE_TEXT_INPUT_CHARS - 4)}${customSecret}tail`;
    const sanitized = sanitizeTraceText(input, {
      maxBytes: MAX_TRACE_TEXT_MAX_BYTES,
      customHeaderValues: [customSecret]
    });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).not.toContain('cust');
    expect(sanitized.text.length).toBeLessThanOrEqual(32_768);
  });

  it('redacts a trailing custom-secret prefix cut by the overlap scan edge', () => {
    const customSecret = `cust${'x'.repeat(508)}`;
    const scanLimit = MAX_TRACE_TEXT_INPUT_CHARS + customSecret.length - 1;
    const compressiblePrefix = `apiKey="${'q'.repeat(4_096)}"\n`;
    const input = `${compressiblePrefix}${'a'.repeat(
      scanLimit - compressiblePrefix.length - 4
    )}${customSecret}tail`;
    const sanitized = sanitizeTraceText(input, {
      maxBytes: MAX_TRACE_TEXT_MAX_BYTES,
      customHeaderValues: [customSecret]
    });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).not.toContain('cust');
    expect(sanitized.text).toContain('[REDACTED]');
  });

  it('treats a self-overlapping custom secret ending at the scan edge as a full match', () => {
    const customSecret = `S${'x'.repeat(510)}S`;
    const scanLimit = MAX_TRACE_TEXT_INPUT_CHARS + customSecret.length - 1;
    const compressiblePrefix = `apiKey="${'q'.repeat(4_096)}"\n`;
    const input = `${compressiblePrefix}${'a'.repeat(
      scanLimit - compressiblePrefix.length - customSecret.length
    )}${customSecret}tail`;
    const sanitized = sanitizeTraceText(input, {
      maxBytes: MAX_TRACE_TEXT_MAX_BYTES,
      customHeaderValues: [customSecret]
    });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).not.toContain(customSecret.slice(0, -1));
  });

  it('fully redacts a complete edge secret whose suffix prefixes another secret', () => {
    const completeSecret = 'alpha-END';
    const overlappingSecret = `END${'z'.repeat(509)}`;
    const scanLimit = MAX_TRACE_TEXT_INPUT_CHARS + overlappingSecret.length - 1;
    const compressiblePrefix = `apiKey="${'q'.repeat(4_096)}"\n`;
    const input = `${compressiblePrefix}${'a'.repeat(
      scanLimit - compressiblePrefix.length - completeSecret.length
    )}${completeSecret}tail`;
    const sanitized = sanitizeTraceText(input, {
      maxBytes: MAX_TRACE_TEXT_MAX_BYTES,
      customHeaderValues: [completeSecret, overlappingSecret]
    });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).not.toContain('alpha-');
  });

  it('prefers a longer genuine secret prefix over a shorter complete suffix', () => {
    const completeSecret = 'END';
    const boundaryPrefix = 'prefix-END';
    const overlappingSecret = `${boundaryPrefix}${'z'.repeat(512 - boundaryPrefix.length)}`;
    const scanLimit = MAX_TRACE_TEXT_INPUT_CHARS + overlappingSecret.length - 1;
    const compressiblePrefix = `apiKey="${'q'.repeat(4_096)}"\n`;
    const input = `${compressiblePrefix}${'a'.repeat(
      scanLimit - compressiblePrefix.length - boundaryPrefix.length
    )}${overlappingSecret}tail`;
    const sanitized = sanitizeTraceText(input, {
      maxBytes: MAX_TRACE_TEXT_MAX_BYTES,
      customHeaderValues: [completeSecret, overlappingSecret]
    });

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).not.toContain('prefix-');
  });

  it('does not split Unicode surrogate pairs at bounded prefixes or final output', () => {
    const input = `${'x'.repeat(MAX_TRACE_TEXT_INPUT_CHARS - 1)}😀tail`;
    const sanitized = sanitizeTraceText(input, { maxBytes: MAX_TRACE_TEXT_MAX_BYTES });

    expect(sanitized.truncated).toBe(true);
    expect(containsLoneSurrogate(sanitized.text)).toBe(false);
  });

  it('always produces raw output accepted by the stage trace schema', () => {
    const sanitized = sanitizeTraceText('E'.repeat(MAX_TRACE_TEXT_INPUT_CHARS), {
      maxBytes: MAX_TRACE_TEXT_MAX_BYTES,
      customHeaderValues: ['E']
    });

    expect(sanitized.text.length).toBeLessThanOrEqual(32_768);
    expect(
      agentStageTraceSchema.safeParse({
        stage: 'compose',
        status: 'completed',
        rawOutput: sanitized.text,
        tools: [],
        citationIds: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        truncated: sanitized.truncated
      }).success
    ).toBe(true);
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
