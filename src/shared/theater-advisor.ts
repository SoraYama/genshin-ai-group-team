import { z } from 'zod';

import {
  imaginariumTheaterScenarioSchema,
  playerPreferencesSchema,
  publishedScenarioFieldPathSchema,
  theaterPlanSchema,
  type ImaginariumTheaterScenario,
  type TheaterPlan
} from './scenario-v2.js';

export const canonicalTheaterCharacterIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Character IDs must be canonical positive decimal strings')
  .refine((value) => Number.isSafeInteger(Number(value)), 'Character ID exceeds the safe range')
  .refine(
    (value) => String(Number(value)) === value,
    'Character ID must round-trip through number'
  );

const externalCastIdSchema = z.string().trim().min(1).max(128);
const uniqueOwnedIdsSchema = z
  .array(canonicalTheaterCharacterIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, 'Character IDs must be unique');
const uniqueCastIdsSchema = z
  .array(externalCastIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, 'Cast IDs must be unique');
const playerTextSchema = z.string().trim().min(1).max(500);

const TARGET_ALIASES: Record<string, 'eligibility-check' | 'safe-clear' | 'explore-hard'> = {
  'eligibility-check': 'eligibility-check',
  资格检查: 'eligibility-check',
  'safe-clear': 'safe-clear',
  稳妥通关: 'safe-clear',
  'explore-hard': 'explore-hard',
  探索高难: 'explore-hard'
};

export const theaterObjectiveSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (TARGET_ALIASES[value.trim()] ?? value.trim()) : value),
  z.enum(['eligibility-check', 'safe-clear', 'explore-hard'])
);

export const theaterAdvisorPlanInputSchema = z
  .object({
    correlationId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    uid: z.string().regex(/^\d{9}$/),
    scenarioId: z.string().trim().min(1),
    dataVersion: z.string().trim().min(1),
    act: z.number().int().min(1).max(10).optional(),
    target: theaterObjectiveSchema,
    preferences: playerPreferencesSchema,
    selectedCharacterIds: uniqueOwnedIdsSchema.default([]),
    excludedCharacterIds: uniqueOwnedIdsSchema.default([]),
    selectedOpeningCharacterIds: uniqueCastIdsSchema.default([]),
    selectedTrialCharacterIds: uniqueCastIdsSchema.default([]),
    selectedSpecialGuestCharacterIds: uniqueCastIdsSchema.default([]),
    selectedSupportCharacterIds: uniqueCastIdsSchema.default([])
  })
  .strict()
  .superRefine(({ selectedCharacterIds, excludedCharacterIds }, context) => {
    const excluded = new Set(excludedCharacterIds);
    selectedCharacterIds.forEach((id, index) => {
      if (excluded.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['selectedCharacterIds', index],
          message: 'Selected owned characters cannot also be excluded'
        });
      }
    });
  });

const developmentTheaterScenarioSchema = z
  .object({
    mode: imaginariumTheaterScenarioSchema.shape.mode,
    id: imaginariumTheaterScenarioSchema.shape.id,
    meta: z
      .object({
        schemaVersion: z.literal(2),
        dataVersion: z.string().trim().min(1),
        effectiveFrom: z.iso.datetime({ offset: true }),
        effectiveTo: z.iso.datetime({ offset: true }).optional(),
        reviewedAt: z.iso.datetime({ offset: true }),
        reviewedBy: z.string().trim().min(1),
        syntheticProvenance: z
          .object({
            kind: z.literal('synthetic-development-data'),
            disclaimer: z.string().trim().min(1),
            fields: z
              .array(
                z
                  .object({
                    fieldPath: publishedScenarioFieldPathSchema,
                    note: z.string().trim().min(1)
                  })
                  .strict()
              )
              .min(1)
          })
          .strict()
      })
      .strict(),
    eligibility: imaginariumTheaterScenarioSchema.shape.eligibility,
    pools: imaginariumTheaterScenarioSchema.shape.pools,
    vigor: imaginariumTheaterScenarioSchema.shape.vigor,
    acts: imaginariumTheaterScenarioSchema.shape.acts,
    arcanaNodes: imaginariumTheaterScenarioSchema.shape.arcanaNodes
  })
  .strict();

const unavailableScenarioViewSchema = z
  .object({
    status: z.literal('unavailable'),
    reason: z.enum([
      'production-source-not-configured',
      'production-config-invalid',
      'production-data-unavailable',
      'development-sample-invalid'
    ]),
    message: playerTextSchema
  })
  .strict();

const productionScenarioViewSchema = z
  .object({
    status: z.literal('ready'),
    trust: z.literal('production'),
    snapshotStatus: z.enum(['ready', 'last-known-good']),
    refreshErrorCode: z.string().trim().min(1).optional(),
    notCurrent: z.boolean(),
    usableForRecommendation: z.boolean(),
    refreshWarning: playerTextSchema.optional(),
    freshness: z.enum(['fresh', 'expiring', 'stale', 'unknown']),
    checkedAt: z.iso.datetime({ offset: true }),
    scenario: imaginariumTheaterScenarioSchema
  })
  .strict();

const developmentScenarioViewSchema = z
  .object({
    status: z.literal('ready'),
    trust: z.literal('development-sample'),
    notCurrent: z.literal(true),
    freshness: z.enum(['stale', 'unknown']),
    checkedAt: z.iso.datetime({ offset: true }),
    scenario: developmentTheaterScenarioSchema
  })
  .strict();

export const theaterScenarioViewSchema = z.union([
  unavailableScenarioViewSchema,
  productionScenarioViewSchema,
  developmentScenarioViewSchema
]);

export const theaterPlanIssueCodeSchema = z.enum([
  'INPUT_INVALID',
  'SCENARIO_MISMATCH',
  'DATA_VERSION_MISMATCH',
  'ACT_NOT_FOUND',
  'ROSTER_INSUFFICIENT',
  'CHARACTER_NOT_OWNED',
  'CHARACTER_EXCLUDED',
  'CAST_ELIGIBILITY_INVALID',
  'CAST_SOURCE_MISMATCH',
  'CAST_DUPLICATE',
  'ACT_COVERAGE_INVALID',
  'CANDIDATE_NOT_IN_CAST',
  'VIGOR_BUDGET_INVALID',
  'PATH_CHOICE_INVALID',
  'MECHANIC_COVERAGE_INVALID',
  'PLAN_SCHEMA_INVALID',
  'AGENT_OUTPUT_INVALID'
]);

export const theaterPlanIssueSchema = z
  .object({
    code: theaterPlanIssueCodeSchema,
    path: z.array(z.union([z.string(), z.number()])),
    message: playerTextSchema,
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

const ineligibleOwnedSchema = z
  .object({
    characterId: canonicalTheaterCharacterIdSchema,
    reasons: z.array(z.enum(['element', 'level'])).min(1),
    level: z.number().int().nonnegative().optional(),
    element: z.string().trim().min(1)
  })
  .strict();

const poolQualificationSchema = z
  .object({
    id: externalCastIdSchema,
    source: z.enum(['opening', 'trial', 'special-guest', 'support']),
    qualification: z.enum(['qualified', 'unqualified', 'unknown']),
    countsTowardRequirement: z.boolean(),
    owned: z.boolean(),
    note: playerTextSchema
  })
  .strict();

const constructionAdviceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('raise-level'),
      characterId: canonicalTheaterCharacterIdSchema,
      targetLevel: z.number().int().positive(),
      note: playerTextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('capability-gap'),
      capability: z.string().trim().min(1),
      note: playerTextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('headcount-gap'),
      missing: z.number().int().positive(),
      note: playerTextSchema
    })
    .strict()
]);

export const theaterEligibilityReportSchema = z
  .object({
    status: z.enum(['eligible', 'blocked']),
    requiredHeadcount: z.number().int().positive(),
    eligibleOwnedCount: z.number().int().nonnegative(),
    hardQualifiedCount: z.number().int().nonnegative(),
    shortage: z.number().int().nonnegative(),
    eligibleOwnedCharacterIds: uniqueOwnedIdsSchema,
    ineligibleOwned: z.array(ineligibleOwnedSchema),
    pools: z.array(poolQualificationSchema),
    constructionAdvice: z.array(constructionAdviceSchema)
  })
  .strict();

const vigorBudgetSchema = z
  .array(
    z
      .object({
        act: z.number().int().min(1).max(10),
        characterId: externalCastIdSchema,
        before: z.number().int().nonnegative(),
        spent: z.number().int().nonnegative(),
        after: z.number().int().nonnegative()
      })
      .strict()
  )
  .refine(
    (items) =>
      new Set(items.map(({ act, characterId }) => `${act}:${characterId}`)).size === items.length,
    'Vigor ledger entries must be unique per act and actor'
  );

const routeGuidanceSchema = z
  .object({
    preserveCharacterIds: uniqueOwnedIdsSchema,
    arcanaPriorityIds: uniqueCastIdsSchema,
    notes: z.array(playerTextSchema).min(1)
  })
  .strict();

const resultCommonShape = {
  correlationId: z.string().trim().min(1).max(128),
  source: z.enum(['smart-service', 'local-rules']),
  scenarioTrust: z.enum(['production', 'development-sample']),
  scenarioFreshness: z.enum(['fresh', 'expiring', 'stale', 'unknown']),
  issues: z.array(theaterPlanIssueSchema),
  warnings: z.array(playerTextSchema),
  assumptions: z.array(playerTextSchema),
  eligibility: theaterEligibilityReportSchema
};

export const theaterAdvisorResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('planned'),
      ...resultCommonShape,
      plan: theaterPlanSchema,
      vigorBudget: vigorBudgetSchema,
      routeGuidance: routeGuidanceSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('blocked'),
      ...resultCommonShape
    })
    .strict()
]);

export const theaterAdvisorProgressStepSchema = z.enum([
  'reading-roster',
  'checking-eligibility',
  'planning-cast',
  'budgeting-vigor',
  'writing-route'
]);

export type TheaterAdvisorPlanInput = z.infer<typeof theaterAdvisorPlanInputSchema>;
export type TheaterObjective = z.infer<typeof theaterObjectiveSchema>;
export type TheaterPlanIssue = z.infer<typeof theaterPlanIssueSchema>;
export type TheaterEligibilityReport = z.infer<typeof theaterEligibilityReportSchema>;
export type TheaterRouteGuidance = z.infer<typeof routeGuidanceSchema>;
export type TheaterVigorBudgetItem = z.infer<typeof vigorBudgetSchema>[number];
export type TheaterScenarioView = z.infer<typeof theaterScenarioViewSchema>;
export type TheaterAdvisorResult = z.infer<typeof theaterAdvisorResultSchema>;
export type TheaterAdvisorProgressStep = z.infer<typeof theaterAdvisorProgressStepSchema>;
export type TheaterAdvisorProgressEvent = {
  correlationId: string;
  step: TheaterAdvisorProgressStep;
};
export type TheaterAdvisorEvent = { type: 'progress' } & TheaterAdvisorProgressEvent;
export type DevelopmentTheaterScenario = z.infer<typeof developmentTheaterScenarioSchema>;
export type TheaterScenario = ImaginariumTheaterScenario | DevelopmentTheaterScenario;
export type TheaterPlanOutput = TheaterPlan;
