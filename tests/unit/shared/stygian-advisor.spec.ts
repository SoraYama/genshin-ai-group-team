import { describe, expect, it } from 'vitest';

import {
  stygianAdvisorPlanInputSchema,
  stygianAdvisorResultSchema,
  stygianScenarioViewSchema
} from '../../../src/shared/stygian-advisor.js';
import {
  developmentStygianScenario,
  stygianInput,
  validStygianPlan
} from '../services/stygian-test-fixtures.js';

describe('stygian advisor contracts', () => {
  it('normalizes the three player-facing reward goals at the strict IPC boundary', () => {
    expect(stygianAdvisorPlanInputSchema.parse(stygianInput({ target: '拿原石即可' })).target).toBe(
      'primogems'
    );
    expect(stygianAdvisorPlanInputSchema.parse(stygianInput({ target: '冲高难奖励' })).target).toBe(
      'high-reward'
    );
    expect(stygianAdvisorPlanInputSchema.parse(stygianInput({ target: '挑战 Dire' })).target).toBe(
      'dire-challenge'
    );
  });

  it('rejects non-canonical numeric character identifiers and lock/exclude conflicts', () => {
    expect(
      stygianAdvisorPlanInputSchema.safeParse(stygianInput({ lockedCharacterIds: ['01001'] }))
        .success
    ).toBe(false);
    expect(
      stygianAdvisorPlanInputSchema.safeParse(
        stygianInput({ lockedCharacterIds: ['1001'], excludedCharacterIds: ['1001'] })
      ).success
    ).toBe(false);
  });

  it('accepts a strict six-difficulty three-phase development scenario view', () => {
    const view = stygianScenarioViewSchema.parse({
      status: 'ready',
      trust: 'development-sample',
      notCurrent: true,
      freshness: 'stale',
      checkedAt: '2026-07-23T00:00:00.000Z',
      scenario: developmentStygianScenario()
    });
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') throw new Error('Expected ready view');
    expect(view.scenario.phases).toHaveLength(3);
  });

  it('accepts planned guidance while keeping the M0 StygianPlan as the plan payload', () => {
    const parsed = stygianAdvisorResultSchema.parse({
      status: 'planned',
      source: 'local-rules',
      issues: [],
      warnings: [],
      assumptions: [],
      plan: validStygianPlan(),
      phaseGuidance: [1, 2, 3].map((phase) => ({
        phase,
        mechanismBasis: ['先处理首领硬机制。'],
        risks: ['实战时间受操作与练度影响。']
      })),
      difficultyAssessment: {
        recommendation: 'proceed-with-caution',
        evidence: ['角色资料覆盖有限。'],
        suggestedDifficultyId: 'difficulty-5'
      }
    });
    expect(parsed.status).toBe('planned');
    if (parsed.status !== 'planned') throw new Error('Expected planned result');
    expect(parsed.plan.mode).toBe('stygian-onslaught');
  });

  it('rejects non-canonical character identifiers at the result contract boundary', () => {
    const plan = validStygianPlan();
    plan.phases[0]!.team.characterIds[0] = '01001';
    expect(
      stygianAdvisorResultSchema.safeParse({
        status: 'planned',
        source: 'local-rules',
        issues: [],
        warnings: [],
        assumptions: [],
        plan,
        phaseGuidance: [1, 2, 3].map((phase) => ({
          phase,
          mechanismBasis: ['已确认机制。'],
          risks: []
        })),
        difficultyAssessment: {
          recommendation: 'proceed',
          evidence: ['资料已检查。']
        }
      }).success
    ).toBe(false);
  });

  it('rejects raw technical identifiers from all player-facing result text', () => {
    expect(
      stygianAdvisorResultSchema.safeParse({
        status: 'planned',
        source: 'smart-service',
        issues: [],
        warnings: ['mcp__genshin__query_stygian_phase 返回 fallback。'],
        assumptions: [],
        plan: validStygianPlan(),
        phaseGuidance: [1, 2, 3].map((phase) => ({
          phase,
          mechanismBasis: ['已确认机制。'],
          risks: []
        })),
        difficultyAssessment: { recommendation: 'proceed', evidence: ['资料已检查。'] }
      }).success
    ).toBe(false);
  });

  it('allows normal E/Q rotation notation while rejecting technical identifiers', () => {
    const plan = validStygianPlan();
    plan.phases[0]!.team.rotationNotes = ['班尼特 E-Q 后切香菱，先 E-Q-E 再输出。'];

    const result = {
      status: 'planned' as const,
      source: 'smart-service' as const,
      issues: [],
      warnings: [],
      assumptions: [],
      plan,
      phaseGuidance: [1, 2, 3].map((phase) => ({
        phase,
        mechanismBasis: ['已确认机制。'],
        risks: []
      })),
      difficultyAssessment: { recommendation: 'proceed' as const, evidence: ['资料已检查。'] }
    };

    expect(stygianAdvisorResultSchema.safeParse(result).success).toBe(true);

    for (const rawText of [
      'mcp__genshin__query_stygian_phase',
      'query_stygian_phase',
      'internal-phase-key'
    ]) {
      result.plan.phases[0]!.team.rotationNotes = [rawText];
      expect(stygianAdvisorResultSchema.safeParse(result).success).toBe(false);
    }
  });
});
