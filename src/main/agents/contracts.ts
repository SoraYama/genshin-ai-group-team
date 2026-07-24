import { z } from 'zod';
import { playerPreferencesSchema, recommendationPlanSchema } from '../../shared/scenario-v2.js';
import {
  advisorFactRefSchema,
  advisorLocaleSchema,
  advisorNarrativeReasonCodeSchema
} from '../../shared/advisor-narrative.js';
import {
  artifactMainStatKeySchema,
  knowledgeContextPacketSchema
} from '../../shared/advisor-knowledge.js';

export const dataCuratorOutputSchema = z.object({
  usableCharacterIds: z.array(z.number().int()).min(4),
  partial: z.boolean(),
  dataNotes: z.array(z.string()).max(8)
});

export const composedTeamSchema = z.object({
  name: z.string().min(1).max(40),
  characterIds: z.array(z.number().int()).length(4),
  concept: z.string().min(1).max(500),
  confidence: z.enum(['low', 'medium', 'high']),
  assumptions: z.array(z.string()).max(8)
});

export const teamComposerOutputSchema = z.object({
  teams: z.array(composedTeamSchema).min(1).max(3)
});

export const critiqueOutputSchema = z.object({
  reviews: z.array(
    z.object({
      teamIndex: z.number().int().nonnegative(),
      viable: z.boolean(),
      issues: z.array(z.string()).max(8)
    })
  )
});

export const rotationCoachOutputSchema = z.object({
  rotations: z.array(
    z.object({
      teamIndex: z.number().int().nonnegative(),
      rotationTip: z.string().min(1).max(800)
    })
  )
});

export const explainOutputSchema = z.object({
  summary: z.string().min(1).max(800),
  teams: z.array(
    z.object({
      teamIndex: z.number().int().nonnegative(),
      reasoning: z.string().min(1).max(1000)
    })
  )
});

export type DataCuratorOutput = z.infer<typeof dataCuratorOutputSchema>;
export type TeamComposerOutput = z.infer<typeof teamComposerOutputSchema>;
export type CritiqueOutput = z.infer<typeof critiqueOutputSchema>;
export type RotationCoachOutput = z.infer<typeof rotationCoachOutputSchema>;
export type ExplainOutput = z.infer<typeof explainOutputSchema>;

const v2ModeSchema = z.enum(['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater']);
const v2PlayerTextSchema = z.string().trim().min(1).max(800);
const boundedIdSchema = z.string().trim().min(1).max(128);
const canonicalProfileCharacterIdSchema = z.number().int().positive();
const boundedCharacterIdsSchema = z.array(boundedIdSchema).max(128);

const v2AbyssTeamTargetSchema = z
  .object({
    kind: z.literal('abyss-team'),
    half: z.enum(['first', 'second'])
  })
  .strict();
const v2AbyssChamberTargetSchema = z
  .object({
    kind: z.literal('abyss-chamber'),
    floor: z.number().int().positive(),
    chamber: z.number().int().positive(),
    half: z.enum(['first', 'second'])
  })
  .strict();
const v2StygianPhaseTargetSchema = z
  .object({
    kind: z.literal('stygian-phase'),
    phase: z.number().int().min(1).max(3)
  })
  .strict();
const v2TheaterActTargetSchema = z
  .object({
    kind: z.literal('theater-act'),
    act: z.number().int().min(1).max(10)
  })
  .strict();
const v2TheaterCastTargetSchema = z
  .object({
    kind: z.literal('theater-cast')
  })
  .strict();

export const v2AgentTargetSchema = z.discriminatedUnion('kind', [
  v2AbyssTeamTargetSchema,
  v2AbyssChamberTargetSchema,
  v2StygianPhaseTargetSchema,
  v2TheaterActTargetSchema,
  v2TheaterCastTargetSchema
]);

const profileCoverageSchema = z
  .object({
    expectedOwnedCount: z.number().int().nonnegative().optional(),
    ownedCount: z.number().int().nonnegative(),
    detailedCount: z.number().int().nonnegative(),
    buildCount: z.number().int().nonnegative(),
    statsCount: z.number().int().nonnegative(),
    enkaShowcaseCount: z.number().int().nonnegative(),
    missingDetailCount: z.number().int().nonnegative(),
    partial: z.boolean()
  })
  .strict();
const fieldSourceSchema = z.enum(['miyoushe-index', 'miyoushe-list', 'miyoushe-detail', 'enka']);
const advisorStatsSchema = z
  .object({
    hp: z.number().optional(),
    atk: z.number().optional(),
    def: z.number().optional(),
    critRate: z.number().optional(),
    critDmg: z.number().optional(),
    energyRecharge: z.number().optional(),
    elementalMastery: z.number().optional()
  })
  .strict();
const advisorCharacterContextSchema = z
  .object({
    id: canonicalProfileCharacterIdSchema,
    name: z.string().trim().min(1).max(80),
    element: z.string().trim().min(1).max(24),
    rarity: z.number().int().positive(),
    level: z.number().int().nonnegative().optional(),
    constellation: z.number().int().nonnegative().optional(),
    talents: z
      .object({
        normal: z.number().int().nonnegative().optional(),
        skill: z.number().int().nonnegative().optional(),
        burst: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional(),
    weapon: z
      .object({
        name: z.string().trim().min(1),
        level: z.number().int().nonnegative(),
        refinement: z.number().int().positive().optional()
      })
      .strict()
      .optional(),
    artifactSummary: z
      .object({
        sets: z
          .array(
            z
              .object({
                name: z.string().trim().min(1),
                count: z.number().int().positive()
              })
              .strict()
          )
          .max(5),
        mainStats: z
          .object({
            sands: artifactMainStatKeySchema.or(z.literal('unknown')).optional(),
            goblet: artifactMainStatKeySchema.or(z.literal('unknown')).optional(),
            circlet: artifactMainStatKeySchema.or(z.literal('unknown')).optional()
          })
          .strict()
      })
      .strict()
      .optional(),
    stats: advisorStatsSchema.optional(),
    completeness: z.enum(['basic', 'build', 'detailed']),
    missingFields: z
      .array(z.enum(['stats', 'weapon', 'artifacts', 'talents']))
      .max(4)
      .optional()
  })
  .strict();

const advisorCharacterIndexSchema = z
  .object({
    id: canonicalProfileCharacterIdSchema,
    name: z.string().trim().min(1).max(80),
    element: z.string().trim().min(1).max(24),
    rarity: z.number().int().positive(),
    level: z.number().int().nonnegative().optional(),
    completeness: z.enum(['basic', 'build', 'detailed']),
    missingFields: z
      .array(z.enum(['stats', 'weapon', 'artifacts', 'talents']))
      .max(4)
      .optional()
  })
  .strict();

const compactTeamSchema = z
  .object({
    id: boundedIdSchema,
    characterIds: z.array(boundedIdSchema).length(4)
  })
  .strict();

export const v2CompactBaselineSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('spiral-abyss'),
      scenarioId: boundedIdSchema,
      dataVersion: boundedIdSchema,
      firstHalfTeam: compactTeamSchema,
      secondHalfTeam: compactTeamSchema,
      chambers: z
        .array(
          z
            .object({
              floor: z.number().int().positive(),
              chamber: z.number().int().positive()
            })
            .strict()
        )
        .min(1)
        .max(12)
    })
    .strict(),
  z
    .object({
      mode: z.literal('stygian-onslaught'),
      scenarioId: boundedIdSchema,
      dataVersion: boundedIdSchema,
      reusePolicyAcknowledgement: z.enum(['forbidden', 'allowed', 'limited']),
      phases: z
        .array(
          z
            .object({
              phase: z.number().int().min(1).max(3),
              team: compactTeamSchema
            })
            .strict()
        )
        .length(3)
    })
    .strict(),
  z
    .object({
      mode: z.literal('imaginarium-theater'),
      scenarioId: boundedIdSchema,
      dataVersion: boundedIdSchema,
      cast: z
        .object({
          openingCharacterIds: boundedCharacterIdsSchema,
          selectedCharacterIds: boundedCharacterIdsSchema,
          trialCharacterIds: boundedCharacterIdsSchema,
          specialGuestCharacterIds: boundedCharacterIdsSchema,
          supportCharacterIds: boundedCharacterIdsSchema
        })
        .strict(),
      acts: z
        .array(
          z
            .object({
              act: z.number().int().min(1).max(10),
              candidateCharacterIds: boundedCharacterIdsSchema,
              plannedVigorSpend: z
                .array(
                  z
                    .object({
                      characterId: boundedIdSchema,
                      cost: z.number().int().nonnegative()
                    })
                    .strict()
                )
                .max(32),
              pathKind: z.enum(['fixed', 'conditional', 'random'])
            })
            .strict()
        )
        .min(1)
        .max(10)
    })
    .strict()
]);

const v2InterventionsSchema = z
  .object({
    locale: advisorLocaleSchema,
    preferences: playerPreferencesSchema,
    lockedCharacterIds: boundedCharacterIdsSchema.optional(),
    excludedCharacterIds: boundedCharacterIdsSchema.optional(),
    selectedCharacterIds: boundedCharacterIdsSchema.optional(),
    selectedOpeningCharacterIds: boundedCharacterIdsSchema.optional(),
    selectedTrialCharacterIds: boundedCharacterIdsSchema.optional(),
    selectedSpecialGuestCharacterIds: boundedCharacterIdsSchema.optional(),
    selectedSupportCharacterIds: boundedCharacterIdsSchema.optional(),
    target: boundedIdSchema.optional(),
    difficultyId: boundedIdSchema.optional(),
    phase: z.number().int().min(1).max(3).optional(),
    act: z.number().int().min(1).max(10).optional(),
    recomputeHalf: z.enum(['firstHalf', 'secondHalf']).optional()
  })
  .strict();

export const v2PipelineContextSchema = z
  .object({
    mode: v2ModeSchema,
    correlationId: z.string().trim().min(1).max(128),
    scenarioId: boundedIdSchema,
    dataVersion: boundedIdSchema,
    locale: advisorLocaleSchema,
    profileRef: z
      .object({
        uid: z.string().regex(/^\d{9}$/)
      })
      .strict(),
    profile: z
      .object({
        coverage: profileCoverageSchema,
        provenanceSummaries: z
          .array(
            z
              .object({
                ownership: fieldSourceSchema,
                build: fieldSourceSchema.optional(),
                stats: fieldSourceSchema.optional(),
                staleFields: z.array(z.enum(['ownership', 'build', 'stats'])).optional(),
                characterIndexes: z.array(z.number().int().nonnegative())
              })
              .strict()
          )
          .max(16),
        minimalIndex: z.array(advisorCharacterIndexSchema).min(1).max(128),
        detailedProfiles: z.array(advisorCharacterContextSchema).max(24)
      })
      .strict(),
    candidate: z
      .object({
        kind: z.literal('feasibleBaseline'),
        feasibleBaseline: v2CompactBaselineSchema,
        eligibleCharacterIds: boundedCharacterIdsSchema.min(1)
      })
      .strict(),
    mechanics: z
      .array(
        z
          .object({
            target: z.string().trim().min(1).max(128),
            facts: z.array(z.string().trim().min(1).max(240)).max(16),
            unknowns: z.array(z.string().trim().min(1).max(240)).max(8)
          })
          .strict()
      )
      .max(32),
    interventions: v2InterventionsSchema,
    knowledge: knowledgeContextPacketSchema
  })
  .strict()
  .superRefine(({ mode, scenarioId, dataVersion, candidate }, context) => {
    const baseline = candidate.feasibleBaseline;
    if (
      baseline.mode !== mode ||
      baseline.scenarioId !== scenarioId ||
      baseline.dataVersion !== dataVersion
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidate', 'feasibleBaseline'],
        message: 'Feasible baseline identity must match the pipeline context'
      });
    }
  });

export const v2CritiqueInputSchema = z
  .object({
    stage: z.literal('critique'),
    context: v2PipelineContextSchema,
    plan: recommendationPlanSchema
  })
  .strict();

const v2CritiqueIssueSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/),
    severity: z.literal('soft'),
    target: v2AgentTargetSchema,
    message: v2PlayerTextSchema
  })
  .strict();

export const v2CritiqueOutputSchema = z
  .object({
    decision: z.enum(['accept', 'repair']),
    issues: z.array(v2CritiqueIssueSchema).max(16)
  })
  .strict()
  .superRefine(({ decision, issues }, context) => {
    if (decision === 'repair' && issues.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['issues'],
        message: 'A repair decision requires at least one concrete soft issue'
      });
    }
  });

export const v2RotationInputSchema = z
  .object({
    stage: z.literal('rotation'),
    context: v2PipelineContextSchema,
    plan: recommendationPlanSchema,
    critique: v2CritiqueOutputSchema
  })
  .strict();

export const v2NarrativeReasonCodeSchema = advisorNarrativeReasonCodeSchema;

export const v2FactRefSchema = advisorFactRefSchema;

const v2NarrativeDirectiveShape = {
  tone: z.enum(['steady', 'cautious', 'technical']),
  reasonCodes: z.array(v2NarrativeReasonCodeSchema).min(1).max(8),
  factRefs: z.array(v2FactRefSchema).min(1).max(16)
};

export const v2RotationOutputSchema = z
  .object({
    rotations: z
      .array(
        z
          .object({
            target: z.discriminatedUnion('kind', [
              v2AbyssTeamTargetSchema,
              v2StygianPhaseTargetSchema,
              v2TheaterActTargetSchema
            ]),
            ...v2NarrativeDirectiveShape
          })
          .strict()
      )
      .min(1)
      .max(12)
  })
  .strict();

export const v2ExplainInputSchema = z
  .object({
    stage: z.literal('explain'),
    context: v2PipelineContextSchema,
    plan: recommendationPlanSchema,
    critique: v2CritiqueOutputSchema,
    rotation: v2RotationOutputSchema
  })
  .strict();

export const v2ExplainOutputSchema = z
  .object({
    explanations: z
      .array(
        z
          .object({
            target: z.discriminatedUnion('kind', [
              v2AbyssChamberTargetSchema,
              v2StygianPhaseTargetSchema,
              v2TheaterActTargetSchema,
              v2TheaterCastTargetSchema
            ]),
            ...v2NarrativeDirectiveShape
          })
          .strict()
      )
      .min(1)
      .max(24)
  })
  .strict();

export type V2AgentTarget = z.infer<typeof v2AgentTargetSchema>;
export type V2PipelineContext = z.infer<typeof v2PipelineContextSchema>;
export type V2CritiqueOutput = z.infer<typeof v2CritiqueOutputSchema>;
export type V2RotationOutput = z.infer<typeof v2RotationOutputSchema>;
export type V2ExplainOutput = z.infer<typeof v2ExplainOutputSchema>;
