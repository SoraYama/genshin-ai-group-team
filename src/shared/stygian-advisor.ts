import { z } from 'zod';

import {
  playerPreferencesSchema,
  publishedScenarioFieldPathSchema,
  stygianOnslaughtScenarioSchema,
  stygianPlanSchema,
  type PlayerIntervention,
  type StygianOnslaughtScenario,
  type StygianPlan
} from './scenario-v2.js';
import {
  advisorLocaleSchema,
  advisorNarrativeSchema,
  defaultAdvisorNarrative
} from './advisor-narrative.js';

export const canonicalCharacterIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Character IDs must be canonical positive decimal strings')
  .refine((value) => Number.isSafeInteger(Number(value)), 'Character ID exceeds the safe range')
  .refine(
    (value) => String(Number(value)) === value,
    'Character ID must round-trip through number'
  );

const uniqueCharacterIdsSchema = z
  .array(canonicalCharacterIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, 'Character IDs must be unique');

const playerFacingTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !hasRawTechnicalPlayerText(value), 'Raw technical identifiers are forbidden');

const TARGET_ALIASES: Record<string, 'primogems' | 'high-reward' | 'dire-challenge'> = {
  primogems: 'primogems',
  拿原石即可: 'primogems',
  原石奖励: 'primogems',
  'high-reward': 'high-reward',
  冲高难奖励: 'high-reward',
  高难奖励: 'high-reward',
  'dire-challenge': 'dire-challenge',
  '挑战 Dire': 'dire-challenge',
  挑战极限难度: 'dire-challenge'
};

export const stygianRewardTargetSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (TARGET_ALIASES[value.trim()] ?? value.trim()) : value),
  z.enum(['primogems', 'high-reward', 'dire-challenge'])
);

export const stygianAdvisorPlanInputSchema = z
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
    locale: advisorLocaleSchema.default('zh-CN'),
    difficultyId: z.string().trim().min(1),
    phase: z.number().int().min(1).max(3).optional(),
    target: stygianRewardTargetSchema,
    preferences: playerPreferencesSchema,
    lockedCharacterIds: uniqueCharacterIdsSchema.default([]),
    excludedCharacterIds: uniqueCharacterIdsSchema.default([])
  })
  .strict()
  .superRefine(({ lockedCharacterIds, excludedCharacterIds }, context) => {
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
  });

export const stygianPlanIssueCodeSchema = z.enum([
  'INPUT_INVALID',
  'SCENARIO_MISMATCH',
  'DATA_VERSION_MISMATCH',
  'DIFFICULTY_NOT_FOUND',
  'TARGET_DIFFICULTY_CONFLICT',
  'PHASE_NOT_FOUND',
  'ROSTER_INSUFFICIENT',
  'LOCK_LIMIT_EXCEEDED',
  'LOCK_EXCLUDE_CONFLICT',
  'CHARACTER_NOT_OWNED',
  'CHARACTER_EXCLUDED',
  'LOCKED_CHARACTER_MISSING',
  'TEAM_SIZE_INVALID',
  'TEAM_DUPLICATE',
  'REUSE_POLICY_VIOLATION',
  'REUSE_ACKNOWLEDGEMENT_MISMATCH',
  'PHASE_COVERAGE_INVALID',
  'MECHANIC_COVERAGE_INVALID',
  'SEARCH_BUDGET_EXCEEDED',
  'PLAN_SCHEMA_INVALID',
  'AGENT_OUTPUT_INVALID'
]);

export const stygianPlanIssueSchema = z
  .object({
    code: stygianPlanIssueCodeSchema,
    path: z.array(z.union([z.string(), z.number()])),
    message: playerFacingTextSchema,
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

const developmentStygianScenarioSchema = z
  .object({
    mode: stygianOnslaughtScenarioSchema.shape.mode,
    id: stygianOnslaughtScenarioSchema.shape.id,
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
    crossPartyReusePolicy: stygianOnslaughtScenarioSchema.shape.crossPartyReusePolicy,
    difficulties: stygianOnslaughtScenarioSchema.shape.difficulties,
    phases: stygianOnslaughtScenarioSchema.shape.phases
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
    scenario: stygianOnslaughtScenarioSchema
  })
  .strict();

const developmentScenarioViewSchema = z
  .object({
    status: z.literal('ready'),
    trust: z.literal('development-sample'),
    notCurrent: z.literal(true),
    freshness: z.enum(['stale', 'unknown']),
    checkedAt: z.iso.datetime({ offset: true }),
    scenario: developmentStygianScenarioSchema
  })
  .strict();

export const stygianScenarioViewSchema = z.union([
  unavailableScenarioViewSchema,
  productionScenarioViewSchema,
  developmentScenarioViewSchema
]);

const resultCommonShape = {
  source: z.enum(['smart-service', 'local-rules']),
  issues: z.array(stygianPlanIssueSchema),
  warnings: z.array(playerFacingTextSchema),
  assumptions: z.array(playerFacingTextSchema),
  narrative: advisorNarrativeSchema.default(defaultAdvisorNarrative('stygian-onslaught'))
};

export const stygianPhaseGuidanceSchema = z
  .array(
    z
      .object({
        phase: z.number().int().min(1).max(3),
        mechanismBasis: z.array(playerFacingTextSchema).min(1),
        risks: z.array(playerFacingTextSchema)
      })
      .strict()
  )
  .length(3)
  .refine((items) => new Set(items.map(({ phase }) => phase)).size === 3);

export const stygianDifficultyAssessmentSchema = z
  .object({
    recommendation: z.enum(['proceed', 'proceed-with-caution', 'lower-difficulty']),
    evidence: z.array(playerFacingTextSchema).min(1),
    suggestedDifficultyId: z.string().trim().min(1).optional()
  })
  .strict();

export const stygianAdvisorPlanSchema = stygianPlanSchema.superRefine(
  ({ phases, warnings, assumptions }, context) => {
    phases.forEach(({ team }, phaseIndex) => {
      team.characterIds.forEach((id, characterIndex) => {
        if (canonicalCharacterIdSchema.safeParse(id).success) return;
        context.addIssue({
          code: 'custom',
          message: 'Character ID must be a canonical positive decimal string',
          path: ['phases', phaseIndex, 'team', 'characterIds', characterIndex]
        });
      });
    });
    const playerText = [
      ...warnings.map((value, index) => ({ path: ['warnings', index], value })),
      ...assumptions.map((value, index) => ({ path: ['assumptions', index], value })),
      ...phases.flatMap(({ team }, phaseIndex) => [
        { path: ['phases', phaseIndex, 'team', 'purpose'], value: team.purpose },
        ...team.rotationNotes.map((value, noteIndex) => ({
          path: ['phases', phaseIndex, 'team', 'rotationNotes', noteIndex],
          value
        }))
      ])
    ];
    playerText.forEach(({ path, value }) => {
      if (!hasRawTechnicalPlayerText(value)) return;
      context.addIssue({
        code: 'custom',
        message: 'Player-facing plan text contains a raw technical identifier',
        path
      });
    });
  }
);

function hasRawTechnicalPlayerText(value: string): boolean {
  return /(?:mcp__\w+|query_[a-z_]+|development-sample|dire-challenge|team-composer|scenarioId|dataVersion|difficultyId|characterIds|reusePolicyAcknowledgement|requires-capability:[a-z0-9_-]+|\b(?:LLM|Enka|API Key|Base URL|partial|fallback)\b|\b(?![eq](?:-[eq])+\b)[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+\b)/iu.test(
    value
  );
}

export const stygianAdvisorResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('planned'),
      ...resultCommonShape,
      plan: stygianAdvisorPlanSchema,
      phaseGuidance: stygianPhaseGuidanceSchema,
      difficultyAssessment: stygianDifficultyAssessmentSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('blocked'),
      ...resultCommonShape
    })
    .strict()
]);

export const stygianAdvisorProgressStepSchema = z.enum([
  'reading-roster',
  'analyzing-rules',
  'allocating-parties',
  'checking-mechanics',
  'writing-guidance'
]);

export type StygianAdvisorPlanInput = z.infer<typeof stygianAdvisorPlanInputSchema>;
export type StygianRewardTarget = z.infer<typeof stygianRewardTargetSchema>;
export type StygianPlanIssueCode = z.infer<typeof stygianPlanIssueCodeSchema>;
export type StygianPlanIssue = z.infer<typeof stygianPlanIssueSchema>;
export type StygianScenarioView = z.infer<typeof stygianScenarioViewSchema>;
export type StygianAdvisorResult = z.infer<typeof stygianAdvisorResultSchema>;
export type StygianPhaseGuidance = z.infer<typeof stygianPhaseGuidanceSchema>;
export type StygianDifficultyAssessment = z.infer<typeof stygianDifficultyAssessmentSchema>;
export type StygianAdvisorProgressStep = z.infer<typeof stygianAdvisorProgressStepSchema>;
export type StygianAdvisorProgressEvent = {
  correlationId: string;
  step: StygianAdvisorProgressStep;
};
export type StygianAdvisorEvent = { type: 'progress' } & StygianAdvisorProgressEvent;
export type DevelopmentStygianScenario = z.infer<typeof developmentStygianScenarioSchema>;
export type StygianScenario = StygianOnslaughtScenario | DevelopmentStygianScenario;
export type StygianPlanOutput = StygianPlan;
export type StygianPlayerIntervention = PlayerIntervention;
