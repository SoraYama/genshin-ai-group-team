import { describe, expect, it } from 'vitest';

import {
  abyssAdvisorPlanInputSchema,
  abyssAdvisorProgressStepSchema,
  abyssAdvisorResultSchema,
  abyssScenarioViewSchema
} from '../../../src/shared/abyss-advisor.js';
import { validAbyssPlan } from '../services/abyss-test-fixtures.js';

const preferences = {
  comfort: 'high',
  survival: 'medium',
  lowInvestment: 'low',
  noBuildChange: true
} as const;

describe('abyss advisor v2 contracts', () => {
  it('accepts a scenario-bound request with explicit player interventions', () => {
    const parsed = abyssAdvisorPlanInputSchema.parse({
      correlationId: 'contract-test-request',
      uid: '123456789',
      scenarioId: 'abyss.2026-07',
      dataVersion: '2026.07.1',
      floor: 12,
      chamber: 1,
      preferences,
      lockedCharacterIds: ['1001'],
      excludedCharacterIds: ['1009']
    });

    expect(parsed.lockedCharacterIds).toEqual(['1001']);
    expect(parsed.excludedCharacterIds).toEqual(['1009']);
  });

  it('rejects conflicting or non-canonical numeric character ids', () => {
    expect(() =>
      abyssAdvisorPlanInputSchema.parse({
        uid: '123456789',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1',
        floor: 12,
        preferences,
        lockedCharacterIds: ['01001'],
        excludedCharacterIds: []
      })
    ).toThrow();

    expect(() =>
      abyssAdvisorPlanInputSchema.parse({
        uid: '123456789',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1',
        floor: 12,
        preferences,
        lockedCharacterIds: ['1001'],
        excludedCharacterIds: ['1001']
      })
    ).toThrow();
  });

  it('accepts partial recompute only when the prior plan and target half are provided together', () => {
    const base = {
      correlationId: 'contract-partial-request',
      uid: '123456789',
      scenarioId: 'abyss.2026-07',
      dataVersion: '2026.07.1',
      floor: 12,
      preferences,
      lockedCharacterIds: [],
      excludedCharacterIds: []
    };

    expect(
      abyssAdvisorPlanInputSchema.parse({
        ...base,
        priorPlan: validAbyssPlan(),
        recomputeHalf: 'firstHalf'
      }).recomputeHalf
    ).toBe('firstHalf');
    expect(() =>
      abyssAdvisorPlanInputSchema.parse({ ...base, priorPlan: validAbyssPlan() })
    ).toThrow();
    expect(() =>
      abyssAdvisorPlanInputSchema.parse({ ...base, recomputeHalf: 'secondHalf' })
    ).toThrow();
  });

  it('keeps production unavailable distinct from an explicitly non-current development sample', () => {
    expect(
      abyssScenarioViewSchema.parse({
        status: 'unavailable',
        reason: 'production-source-not-configured',
        message: '暂时没有可验证的深境螺旋资料。'
      })
    ).toMatchObject({ status: 'unavailable' });

    const development = abyssScenarioViewSchema.parse({
      status: 'ready',
      trust: 'development-sample',
      notCurrent: true,
      freshness: 'stale',
      checkedAt: '2026-07-23T00:00:00.000Z',
      scenario: {
        mode: 'spiral-abyss',
        id: 'development.abyss',
        meta: {
          schemaVersion: 2,
          dataVersion: 'development.1',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: '2026-02-01T00:00:00.000Z',
          reviewedAt: '2026-01-01T01:00:00.000Z',
          reviewedBy: 'development-reviewer',
          syntheticProvenance: {
            kind: 'synthetic-development-data',
            disclaimer: 'Fictional fixture; no production provenance.',
            fields: [
              { fieldPath: 'meta.effectiveRange', note: 'Synthetic interval' },
              { fieldPath: 'scenario.floors', note: 'Synthetic encounters' },
              { fieldPath: 'scenario.blessing', note: 'Synthetic blessing' }
            ]
          }
        },
        blessing: { id: 'demo', description: '演练祝福' },
        floors: [
          {
            floor: 12,
            chambers: [
              {
                chamber: 1,
                firstHalf: {
                  waves: [
                    {
                      id: 'wave-a',
                      enemies: [
                        {
                          enemy: { id: 'enemy-a', names: { 'zh-CN': '训练灵体' } },
                          level: 100,
                          count: 1,
                          mechanics: {
                            shields: [],
                            resistances: [],
                            immunities: [],
                            tags: []
                          }
                        }
                      ]
                    }
                  ]
                },
                secondHalf: {
                  waves: [
                    {
                      id: 'wave-b',
                      enemies: [
                        {
                          enemy: { id: 'enemy-b', names: { 'zh-CN': '石铸哨卫' } },
                          level: 100,
                          count: 1,
                          mechanics: {
                            shields: [],
                            resistances: [],
                            immunities: [],
                            tags: []
                          }
                        }
                      ]
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    });
    expect(development).toMatchObject({ trust: 'development-sample', notCurrent: true });
  });

  it('requires structured blocked issues instead of an invalid plan', () => {
    const withoutKnowledgeSummary = {
      status: 'blocked',
      source: 'local-rules',
      issues: [
        {
          code: 'ROSTER_INSUFFICIENT',
          path: ['profile', 'characters'],
          message: '可用角色不足 8 名。',
          details: { required: 8, available: 7 }
        }
      ],
      warnings: [],
      assumptions: []
    };
    expect(abyssAdvisorResultSchema.safeParse(withoutKnowledgeSummary).success).toBe(false);

    const result = abyssAdvisorResultSchema.parse({
      ...withoutKnowledgeSummary,
      knowledgeSummary: { trusted: 0, ephemeral: 0, unknown: 7, searched: false }
    });
    expect(result.status).toBe('blocked');
    expect('plan' in result).toBe(false);
  });

  it('exposes build interpretation and knowledge research progress steps', () => {
    expect(
      [
        'interpreting-builds',
        'checking-knowledge',
        'researching-guides'
      ].map((step) => abyssAdvisorProgressStepSchema.parse(step))
    ).toEqual(['interpreting-builds', 'checking-knowledge', 'researching-guides']);
  });
});
