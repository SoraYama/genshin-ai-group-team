import { z } from 'zod';

import {
  abyssPlanSchema,
  playerPreferencesSchema,
  publishedScenarioFieldPathSchema,
  spiralAbyssScenarioSchema,
  type AbyssPlan,
  type PlayerIntervention,
  type SpiralAbyssScenario
} from './scenario-v2.js';

const canonicalCharacterIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Character IDs must be canonical positive decimal strings')
  .refine(
    (value) => Number.isSafeInteger(Number(value)),
    'Character ID exceeds the safe integer range'
  )
  .refine(
    (value) => String(Number(value)) === value,
    'Character ID must round-trip through number'
  );

const uniqueCharacterIdsSchema = z
  .array(canonicalCharacterIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, 'Character IDs must be unique');

export const abyssAdvisorPlanInputSchema = z
  .object({
    correlationId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/, 'Correlation ID contains unsupported characters'),
    uid: z.string().regex(/^\d{9}$/, 'UID must contain exactly 9 digits'),
    scenarioId: z.string().trim().min(1),
    dataVersion: z.string().trim().min(1),
    floor: z.number().int().positive(),
    chamber: z.number().int().positive().optional(),
    preferences: playerPreferencesSchema,
    lockedCharacterIds: uniqueCharacterIdsSchema.default([]),
    excludedCharacterIds: uniqueCharacterIdsSchema.default([]),
    priorPlan: abyssPlanSchema.optional(),
    recomputeHalf: z.enum(['firstHalf', 'secondHalf']).optional()
  })
  .strict()
  .superRefine(
    ({ lockedCharacterIds, excludedCharacterIds, priorPlan, recomputeHalf }, context) => {
      const excluded = new Set(excludedCharacterIds);
      lockedCharacterIds.forEach((id, index) => {
        if (excluded.has(id)) {
          context.addIssue({
            code: 'custom',
            message: `Character cannot be both locked and excluded: ${id}`,
            path: ['lockedCharacterIds', index]
          });
        }
      });
      if ((priorPlan === undefined) !== (recomputeHalf === undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'priorPlan and recomputeHalf must be provided together',
          path: [priorPlan === undefined ? 'priorPlan' : 'recomputeHalf']
        });
      }
    }
  );

export const abyssPlanIssueCodeSchema = z.enum([
  'INPUT_INVALID',
  'SCENARIO_MISMATCH',
  'DATA_VERSION_MISMATCH',
  'TARGET_NOT_FOUND',
  'ROSTER_INSUFFICIENT',
  'LOCK_LIMIT_EXCEEDED',
  'LOCK_EXCLUDE_CONFLICT',
  'CHARACTER_NOT_OWNED',
  'CHARACTER_EXCLUDED',
  'LOCKED_CHARACTER_MISSING',
  'TEAM_SIZE_INVALID',
  'TEAM_DUPLICATE',
  'CROSS_TEAM_DUPLICATE',
  'CHAMBER_COVERAGE_INVALID',
  'TACTICS_MISSING',
  'MECHANIC_COVERAGE_INVALID',
  'PRESERVED_HALF_CONFLICT',
  'PRESERVED_HALF_CHANGED',
  'PLAN_SCHEMA_INVALID',
  'AGENT_OUTPUT_INVALID'
]);

export const abyssPlanIssueSchema = z
  .object({
    code: abyssPlanIssueCodeSchema,
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string().trim().min(1),
    details: z.record(z.string(), z.unknown()).optional()
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
    message: z.string().trim().min(1)
  })
  .strict();

const developmentAbyssScenarioSchema = z
  .object({
    mode: spiralAbyssScenarioSchema.shape.mode,
    id: spiralAbyssScenarioSchema.shape.id,
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
      .strict()
      .refine(
        ({ effectiveFrom, effectiveTo }) =>
          effectiveTo === undefined || Date.parse(effectiveTo) >= Date.parse(effectiveFrom),
        {
          message: 'effectiveTo must be greater than or equal to effectiveFrom',
          path: ['effectiveTo']
        }
      ),
    blessing: spiralAbyssScenarioSchema.shape.blessing,
    floors: spiralAbyssScenarioSchema.shape.floors
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
    refreshWarning: z.string().trim().min(1).optional(),
    freshness: z.enum(['fresh', 'expiring', 'stale', 'unknown']),
    checkedAt: z.iso.datetime({ offset: true }),
    scenario: spiralAbyssScenarioSchema
  })
  .strict();

const developmentScenarioViewSchema = z
  .object({
    status: z.literal('ready'),
    trust: z.literal('development-sample'),
    notCurrent: z.literal(true),
    freshness: z.enum(['stale', 'unknown']),
    checkedAt: z.iso.datetime({ offset: true }),
    scenario: developmentAbyssScenarioSchema
  })
  .strict();

export const abyssScenarioViewSchema = z.union([
  unavailableScenarioViewSchema,
  productionScenarioViewSchema,
  developmentScenarioViewSchema
]);

const resultCommonShape = {
  source: z.enum(['smart-service', 'local-rules']),
  issues: z.array(abyssPlanIssueSchema),
  warnings: z.array(z.string().trim().min(1)),
  assumptions: z.array(z.string().trim().min(1))
};

export const abyssAdvisorResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('planned'),
      ...resultCommonShape,
      plan: abyssPlanSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('blocked'),
      ...resultCommonShape
    })
    .strict()
]);

export const abyssAdvisorProgressStepSchema = z.enum([
  'reading-roster',
  'analyzing-rules',
  'generating-teams',
  'checking-conflicts',
  'writing-tactics'
]);

export type AbyssAdvisorPlanInput = z.infer<typeof abyssAdvisorPlanInputSchema>;
export type AbyssPlanIssueCode = z.infer<typeof abyssPlanIssueCodeSchema>;
export type AbyssPlanIssue = z.infer<typeof abyssPlanIssueSchema>;
export type AbyssScenarioView = z.infer<typeof abyssScenarioViewSchema>;
export type AbyssAdvisorResult = z.infer<typeof abyssAdvisorResultSchema>;
export type AbyssAdvisorProgressStep = z.infer<typeof abyssAdvisorProgressStepSchema>;
export type AbyssAdvisorProgressEvent = {
  correlationId: string;
  step: AbyssAdvisorProgressStep;
};
export type AbyssAdvisorEvent = { type: 'progress' } & AbyssAdvisorProgressEvent;
export type DevelopmentAbyssScenario = z.infer<typeof developmentAbyssScenarioSchema>;

// Compile-time anchors documenting the v2 contract reuse expected at IPC boundaries.
export type AbyssPlayerIntervention = PlayerIntervention;
export type AbyssScenario = SpiralAbyssScenario | DevelopmentAbyssScenario;
export type AbyssPlanOutput = AbyssPlan;
