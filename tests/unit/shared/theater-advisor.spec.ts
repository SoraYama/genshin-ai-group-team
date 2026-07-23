import { describe, expect, it } from 'vitest';

import {
  theaterAdvisorPlanInputSchema,
  theaterAdvisorResultSchema,
  theaterScenarioViewSchema
} from '../../../src/shared/theater-advisor.js';
import {
  theaterInput,
  theaterScenario,
  validTheaterPlan
} from '../services/theater-test-fixtures.js';

describe('theater advisor contracts', () => {
  it('accepts player-language objectives and distinct owned/external interventions', () => {
    const parsed = theaterAdvisorPlanInputSchema.parse(
      theaterInput({
        target: '稳妥通关',
        selectedCharacterIds: ['1001', '1002'],
        selectedTrialCharacterIds: ['trial.1'],
        selectedSupportCharacterIds: ['support.1']
      })
    );

    expect(parsed.target).toBe('safe-clear');
    expect(parsed.selectedCharacterIds).toEqual(['1001', '1002']);
    expect(parsed.selectedTrialCharacterIds).toEqual(['trial.1']);
  });

  it('rejects non-canonical owned IDs and overlapping own interventions', () => {
    expect(
      theaterAdvisorPlanInputSchema.safeParse(theaterInput({ selectedCharacterIds: ['01001'] }))
        .success
    ).toBe(false);
    expect(
      theaterAdvisorPlanInputSchema.safeParse(
        theaterInput({ selectedCharacterIds: ['1001'], excludedCharacterIds: ['1001'] })
      ).success
    ).toBe(false);
  });

  it('keeps production freshness and development rehearsal trust explicit', () => {
    const scenario = theaterScenario();
    expect(
      theaterScenarioViewSchema.safeParse({
        status: 'ready',
        trust: 'production',
        snapshotStatus: 'last-known-good',
        refreshErrorCode: 'NETWORK',
        refreshWarning: '正在使用最近一次已确认的资料。',
        notCurrent: false,
        usableForRecommendation: true,
        freshness: 'expiring',
        checkedAt: '2026-07-23T00:00:00.000Z',
        scenario
      }).success
    ).toBe(true);
    expect(
      theaterScenarioViewSchema.safeParse({
        status: 'ready',
        trust: 'production',
        snapshotStatus: 'ready',
        notCurrent: true,
        usableForRecommendation: false,
        freshness: 'stale',
        checkedAt: '2026-07-23T00:00:00.000Z',
        scenario
      }).success
    ).toBe(true);
  });

  it('requires planned results to carry source, trust, freshness, correlation and eligibility', () => {
    const result = {
      status: 'planned',
      correlationId: 'theater-test-request',
      source: 'local-rules',
      scenarioTrust: 'production',
      scenarioFreshness: 'fresh',
      issues: [],
      warnings: [],
      assumptions: [],
      eligibility: {
        status: 'eligible',
        requiredHeadcount: 8,
        eligibleOwnedCount: 8,
        hardQualifiedCount: 8,
        shortage: 0,
        eligibleOwnedCharacterIds: Array.from({ length: 8 }, (_, index) => String(1001 + index)),
        ineligibleOwned: [],
        pools: [],
        constructionAdvice: []
      },
      plan: validTheaterPlan(),
      vigorBudget: [{ act: 1, characterId: '1001', before: 2, spent: 1, after: 1 }],
      routeGuidance: {
        preserveCharacterIds: ['1001'],
        arcanaPriorityIds: [],
        notes: ['保留稀缺机制角色到对应幕次。']
      }
    };

    expect(theaterAdvisorResultSchema.safeParse(result).success).toBe(true);
    expect(
      theaterAdvisorResultSchema.safeParse({ ...result, correlationId: undefined }).success
    ).toBe(false);
  });
});
