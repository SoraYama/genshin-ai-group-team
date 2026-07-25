import { describe, expect, it } from 'vitest';

import {
  AGENT_GATE_FAILURE_CODES,
  evaluateAgentGate,
  gateExitCode,
  type AgentGateEvaluationInput
} from '../../../src/main/gates/agent-saved-gate.js';

const successfulTurn: Extract<AgentGateEvaluationInput, { kind: 'turn' }> = {
  kind: 'turn',
  model: 'claude-test',
  rawText: 'agent gate ok',
  usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 },
  latencyMs: 25,
  sensitiveValues: []
};

describe('evaluateAgentGate', () => {
  it('fails when a real agent turn has no raw text or usage', () => {
    expect(
      evaluateAgentGate({
        ...successfulTurn,
        rawText: '',
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      })
    ).toMatchObject({ status: 'failed', code: 'EMPTY_AGENT_RESULT' });
  });

  it('returns bounded trace-level redacted model text and no cost detail', () => {
    const output = evaluateAgentGate({
      ...successfulTurn,
      rawText:
        'agent gate ok; api-secret; custom-secret; Authorization: Bearer provider-token ' +
        'x'.repeat(12_000),
      sensitiveValues: ['api-secret', 'custom-secret']
    });

    expect(output).toMatchObject({
      gate: 'agent-saved',
      status: 'passed',
      model: 'claude-test',
      usage: { inputTokens: 12, outputTokens: 4 },
      latencyMs: 25
    });
    expect(output).not.toHaveProperty('usage.estimatedCostUsd');
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('api-secret');
    expect(serialized).not.toContain('custom-secret');
    expect(serialized).not.toContain('provider-token');
    expect(
      Buffer.byteLength(output.status === 'passed' ? output.rawText : '', 'utf8')
    ).toBeLessThanOrEqual(4_096);
    expect(gateExitCode(output)).toBe(0);
  });

  it('covers every stable agent gate failure code', () => {
    const cases: Array<[string, AgentGateEvaluationInput]> = [
      ['MISSING_SAVED_API_KEY', { kind: 'unavailable', code: 'MISSING_SAVED_API_KEY' }],
      ['SAVED_KEY_DECRYPT_FAILED', { kind: 'unavailable', code: 'SAVED_KEY_DECRYPT_FAILED' }],
      ['SAFE_STORAGE_UNAVAILABLE', { kind: 'unavailable', code: 'SAFE_STORAGE_UNAVAILABLE' }],
      [
        'AGENT_TIMEOUT',
        { kind: 'provider-error', timedOut: true, sdkCode: 'AGENT_TURN_CANCELLED' }
      ],
      [
        'PROVIDER_ERROR',
        {
          kind: 'provider-error',
          timedOut: false,
          sdkCode: 'AGENT_TURN_RESULT_ERROR',
          httpStatus: 429
        }
      ],
      ['EMPTY_AGENT_RESULT', { ...successfulTurn, rawText: '   ' }],
      [
        'AGENT_INPUT_USAGE_MISSING',
        { ...successfulTurn, usage: { ...successfulTurn.usage, inputTokens: 0 } }
      ],
      [
        'AGENT_OUTPUT_USAGE_MISSING',
        { ...successfulTurn, usage: { ...successfulTurn.usage, outputTokens: 0 } }
      ],
      ['AGENT_MODEL_MISSING', { ...successfulTurn, model: ' ' }],
      ['AGENT_LATENCY_INVALID', { ...successfulTurn, latencyMs: Number.NaN }]
    ];

    expect(cases.map(([code]) => code)).toEqual([...AGENT_GATE_FAILURE_CODES]);
    for (const [code, input] of cases) {
      const output = evaluateAgentGate(input);
      expect(output).toMatchObject({ gate: 'agent-saved', status: 'failed', code });
      expect(gateExitCode(output)).toBe(1);
    }
    expect(evaluateAgentGate(cases[4]![1])).toEqual({
      gate: 'agent-saved',
      status: 'failed',
      code: 'PROVIDER_ERROR',
      sdkCode: 'AGENT_TURN_RESULT_ERROR',
      httpStatus: 429
    });
  });
});
