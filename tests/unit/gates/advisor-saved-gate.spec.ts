import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADVISOR_GATE_FAILURE_CODES,
  createNoopAdvisorGateHistory,
  evaluateAdvisorGate,
  runAdvisorGateWithDeadline,
  selectAuthoritativeOwnedCharacters,
  type AdvisorGateEvaluationInput
} from '../../../src/main/gates/advisor-saved-gate.js';

const knowledge = { trusted: 8, ephemeral: 0, unknown: 0, searched: false };
const requiredStages = ['compose', 'critique', 'rotation', 'explain'] as const;

function successfulRun(): Extract<AdvisorGateEvaluationInput, { kind: 'run' }> {
  return {
    kind: 'run',
    latencyMs: 4_200,
    ownedCharacterIds: ['1', '2', '3', '4', '5', '6', '7', '8'],
    result: {
      status: 'planned',
      source: 'smart-service',
      knowledgeSummary: knowledge,
      plan: {
        scenarioId: 'abyss.production',
        dataVersion: '2026.07.1',
        firstHalfTeam: { characterIds: ['1', '2', '3', '4'] },
        secondHalfTeam: { characterIds: ['5', '6', '7', '8'] }
      }
    },
    trace: {
      status: 'completed',
      finalSource: 'smart-service',
      model: 'claude-test',
      knowledge,
      usage: { inputTokens: 120, outputTokens: 80 },
      stages: requiredStages.map((stage) => ({
        stage,
        status: 'completed' as const,
        rawOutput: `${stage} raw`,
        usage: { inputTokens: 30, outputTokens: 20 }
      }))
    }
  };
}

describe('evaluateAdvisorGate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires smart-service for the advisor gate', () => {
    const input = successfulRun();
    expect(
      evaluateAdvisorGate({
        ...input,
        result: { ...input.result, source: 'local-rules' }
      })
    ).toMatchObject({ status: 'failed', code: 'ADVISOR_FELL_BACK' });
  });

  it('passes only with four raw stages, positive usage, eight owned members, and matching knowledge', () => {
    const output = evaluateAdvisorGate(successfulRun());

    expect(output).toEqual({
      gate: 'advisor-saved',
      status: 'passed',
      source: 'smart-service',
      model: 'claude-test',
      scenarioId: 'abyss.production',
      dataVersion: '2026.07.1',
      stages: [...requiredStages],
      usage: { inputTokens: 120, outputTokens: 80 },
      ownedTeamMembers: 8,
      knowledgeSummary: knowledge,
      latencyMs: 4_200
    });
    expect(JSON.stringify(output)).not.toContain('compose raw');
    expect(JSON.stringify(output)).not.toContain('characterIds');
  });

  it('treats a completed composer repair as the authoritative compose stage', () => {
    const input = successfulRun();
    input.trace!.stages = [
      ...input.trace!.stages.map((stage) =>
        stage.stage === 'compose'
          ? {
              ...stage,
              status: 'failed' as const,
              rawOutput: '{"teams":',
              failure: { code: 'AGENT_OUTPUT_INVALID' }
            }
          : stage
      ),
      {
        stage: 'repair-1',
        status: 'completed',
        rawOutput: '{"teams":[]}',
        usage: { inputTokens: 40, outputTokens: 10 }
      }
    ];

    expect(evaluateAdvisorGate(input)).toMatchObject({
      gate: 'advisor-saved',
      status: 'passed',
      source: 'smart-service'
    });
  });

  it('rejects a failed compose stage when no repair completes', () => {
    const input = successfulRun();
    input.trace!.stages = input.trace!.stages.map((stage) =>
      stage.stage === 'compose' ? { ...stage, status: 'failed' as const } : stage
    );

    expect(evaluateAdvisorGate(input)).toMatchObject({
      gate: 'advisor-saved',
      status: 'failed',
      code: 'REQUIRED_STAGE_NOT_COMPLETED'
    });
  });

  it('rejects a zero-latency advisor run', () => {
    expect(evaluateAdvisorGate({ ...successfulRun(), latencyMs: 0 })).toEqual({
      gate: 'advisor-saved',
      status: 'failed',
      code: 'ADVISOR_LATENCY_INVALID'
    });
  });

  it('covers every stable advisor gate failure code', () => {
    const base = successfulRun();
    const stage = (name: (typeof requiredStages)[number]) =>
      base.trace?.stages.find(({ stage: stageName }) => stageName === name);
    const cases: Array<[string, AdvisorGateEvaluationInput]> = [
      ['ADVISOR_TIMEOUT', { kind: 'unavailable', code: 'ADVISOR_TIMEOUT' }],
      ['MISSING_SAVED_API_KEY', { kind: 'unavailable', code: 'MISSING_SAVED_API_KEY' }],
      ['SAVED_KEY_DECRYPT_FAILED', { kind: 'unavailable', code: 'SAVED_KEY_DECRYPT_FAILED' }],
      ['SAFE_STORAGE_UNAVAILABLE', { kind: 'unavailable', code: 'SAFE_STORAGE_UNAVAILABLE' }],
      ['ACTIVE_PROFILE_UNAVAILABLE', { kind: 'unavailable', code: 'ACTIVE_PROFILE_UNAVAILABLE' }],
      ['ROSTER_INSUFFICIENT', { kind: 'unavailable', code: 'ROSTER_INSUFFICIENT' }],
      ['SCENARIO_UNAVAILABLE', { kind: 'unavailable', code: 'SCENARIO_UNAVAILABLE' }],
      ['PROVIDER_ERROR', { kind: 'unavailable', code: 'PROVIDER_ERROR' }],
      [
        'ADVISOR_NOT_PLANNED',
        {
          ...base,
          result: {
            status: 'blocked',
            source: 'smart-service',
            knowledgeSummary: knowledge
          }
        }
      ],
      ['ADVISOR_FELL_BACK', { ...base, result: { ...base.result, source: 'local-rules' } }],
      ['TRACE_UNAVAILABLE', { ...base, trace: null }],
      ['TRACE_NOT_COMPLETED', { ...base, trace: { ...base.trace!, status: 'running' } }],
      ['TRACE_SOURCE_MISMATCH', { ...base, trace: { ...base.trace!, finalSource: 'local-rules' } }],
      ['AGENT_MODEL_MISSING', { ...base, trace: { ...base.trace!, model: ' ' } }],
      [
        'REQUIRED_STAGE_MISSING',
        {
          ...base,
          trace: {
            ...base.trace!,
            stages: base.trace!.stages.filter(({ stage: name }) => name !== 'critique')
          }
        }
      ],
      [
        'REQUIRED_STAGE_NOT_COMPLETED',
        {
          ...base,
          trace: {
            ...base.trace!,
            stages: base.trace!.stages.map((entry) =>
              entry.stage === 'critique' ? { ...entry, status: 'failed' } : entry
            )
          }
        }
      ],
      [
        'STAGE_RAW_OUTPUT_MISSING',
        {
          ...base,
          trace: {
            ...base.trace!,
            stages: base.trace!.stages.map((entry) =>
              entry.stage === 'critique' ? { ...entry, rawOutput: ' ' } : entry
            )
          }
        }
      ],
      [
        'STAGE_INPUT_USAGE_MISSING',
        {
          ...base,
          trace: {
            ...base.trace!,
            stages: base.trace!.stages.map((entry) =>
              entry.stage === 'critique'
                ? { ...entry, usage: { ...entry.usage, inputTokens: 0 } }
                : entry
            )
          }
        }
      ],
      [
        'STAGE_OUTPUT_USAGE_MISSING',
        {
          ...base,
          trace: {
            ...base.trace!,
            stages: base.trace!.stages.map((entry) =>
              entry.stage === 'critique'
                ? { ...entry, usage: { ...entry.usage, outputTokens: 0 } }
                : entry
            )
          }
        }
      ],
      [
        'TRACE_INPUT_USAGE_MISSING',
        { ...base, trace: { ...base.trace!, usage: { ...base.trace!.usage, inputTokens: 0 } } }
      ],
      [
        'TRACE_OUTPUT_USAGE_MISSING',
        { ...base, trace: { ...base.trace!, usage: { ...base.trace!.usage, outputTokens: 0 } } }
      ],
      [
        'TEAM_SIZE_INVALID',
        {
          ...base,
          result: {
            ...base.result,
            plan: {
              ...base.result.plan!,
              firstHalfTeam: { characterIds: ['1', '2', '3'] }
            }
          }
        }
      ],
      [
        'CHARACTER_NOT_OWNED',
        {
          ...base,
          result: {
            ...base.result,
            plan: {
              ...base.result.plan!,
              secondHalfTeam: { characterIds: ['5', '6', '7', '9'] }
            }
          }
        }
      ],
      [
        'KNOWLEDGE_SUMMARY_MISMATCH',
        {
          ...base,
          result: {
            ...base.result,
            knowledgeSummary: { ...knowledge, unknown: 1 }
          }
        }
      ],
      ['ADVISOR_LATENCY_INVALID', { ...base, latencyMs: -1 }]
    ];

    expect(stage('compose')).toBeDefined();
    expect(cases.map(([code]) => code)).toEqual([...ADVISOR_GATE_FAILURE_CODES]);
    for (const [code, input] of cases) {
      expect(evaluateAdvisorGate(input)).toMatchObject({
        gate: 'advisor-saved',
        status: 'failed',
        code
      });
    }
  });

  it('keeps only stable sanitized diagnostics from a real failed trace fixture', () => {
    const input = successfulRun();
    input.result = {
      ...input.result,
      source: 'local-rules'
    };
    input.trace = {
      ...input.trace!,
      status: 'failed',
      finalSource: 'local-rules',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'secret provider response body',
        retryable: true,
        details: {
          sdkCode: 'AGENT_TURN_RESULT_ERROR',
          httpStatus: '429',
          providerBody: 'secret raw response'
        }
      },
      stages: input.trace!.stages.map((stage) =>
        stage.stage === 'critique'
          ? {
              ...stage,
              status: 'failed' as const,
              rawOutput: 'secret raw profile and prompt',
              failure: {
                code: 'CRITIQUE_PROVIDER_ERROR',
                message: 'secret stage body',
                retryable: true
              }
            }
          : stage
      )
    };

    const output = evaluateAdvisorGate(input);

    expect(output).toEqual({
      gate: 'advisor-saved',
      status: 'failed',
      code: 'ADVISOR_FELL_BACK',
      failedStage: 'critique',
      traceFailureCode: 'PROVIDER_ERROR',
      sdkCode: 'AGENT_TURN_RESULT_ERROR',
      httpStatus: 429
    });
    expect(JSON.stringify(output)).not.toMatch(/secret|body|raw|profile|prompt/i);
  });

  it('rejects a later invalid duplicate stage even when an earlier occurrence is valid', () => {
    const input = successfulRun();
    input.trace!.stages.push({
      stage: 'critique',
      status: 'completed',
      rawOutput: '{"issues":[]}',
      usage: {
        inputTokens: 0,
        outputTokens: 2
      }
    });

    expect(evaluateAdvisorGate(input)).toEqual({
      gate: 'advisor-saved',
      status: 'failed',
      code: 'STAGE_INPUT_USAGE_MISSING'
    });
  });

  it('accepts multiple completed occurrences when every one has raw output and positive usage', () => {
    const input = successfulRun();
    input.trace!.stages.push({
      stage: 'critique',
      status: 'completed',
      rawOutput: '{"issues":[]}',
      usage: {
        inputTokens: 4,
        outputTokens: 2
      }
    });

    expect(evaluateAdvisorGate(input)).toMatchObject({
      gate: 'advisor-saved',
      status: 'passed'
    });
  });

  it('times out a hanging advisor run, cancels it, clears the timer, and handles late rejection', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let rejectRun: ((reason?: unknown) => void) | undefined;
    const hangingRun = new Promise<never>((_resolve, reject) => {
      rejectRun = reject;
    });

    const outcomePromise = runAdvisorGateWithDeadline({
      run: () => hangingRun,
      cancel,
      timeoutMs: 50
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(outcomePromise).resolves.toEqual({ status: 'timed-out' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    rejectRun?.(new Error('late rejection after timeout'));
    await Promise.resolve();
  });

  it('accepts only MiHoYo roster ownership and keeps Enka as detail enrichment', () => {
    const characters = [
      { id: 1, provenance: { ownership: { source: 'miyoushe-index' } } },
      { id: 2, provenance: { ownership: { source: 'miyoushe-list' } } },
      { id: 3, provenance: { ownership: { source: 'enka' } } },
      { id: 4, provenance: { ownership: { source: 'miyoushe-detail' } } }
    ];

    expect(selectAuthoritativeOwnedCharacters(characters).map(({ id }) => id)).toEqual([1, 2]);
  });

  it('uses a no-op history boundary instead of mutating saved recommendation history', async () => {
    const history = createNoopAdvisorGateHistory();
    expect(history.appendAbyss({} as never)).toBeUndefined();

    const source = await readFile(
      path.resolve(import.meta.dirname, '../../../src/main/gates/advisor-saved-gate.ts'),
      'utf8'
    );
    expect(source).not.toContain("import('../services/history-store.js')");
    expect(source).toContain('history: createNoopAdvisorGateHistory()');
  });

  it('honors an explicit isolated userData directory in both real saved gates', async () => {
    const sources = await Promise.all(
      ['agent-saved-gate.ts', 'advisor-saved-gate.ts'].map((file) =>
        readFile(path.resolve(import.meta.dirname, '../../../src/main/gates', file), 'utf8')
      )
    );

    for (const source of sources) {
      expect(source).toContain(
        'const isolatedUserDataDirectory = process.env.GTA_E2E_USER_DATA_DIR'
      );
      expect(source).toContain("app.setPath('userData', isolatedUserDataDirectory)");
    }
  });

  it('documents usable last-known-good production publications without allowing fixtures', async () => {
    const documentation = await readFile(
      path.resolve(import.meta.dirname, '../../../docs/llm-provider.md'),
      'utf8'
    );

    expect(documentation).toContain(
      '刷新失败时，只要 last-known-good 正式发布仍为 fresh / expiring 且 usable，门禁可以继续'
    );
    expect(documentation).toContain(
      '只有没有可用的 production publication 时才返回 `SCENARIO_UNAVAILABLE`'
    );
    expect(documentation).toContain('绝不改用 development sample');
  });
});
