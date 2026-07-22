import { z } from 'zod';

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const nonEmptyIdSchema = z.string().trim().min(1);

export const dataSourceKindSchema = z.enum([
  'official-announcement',
  'battle-chronicle',
  'fandom',
  'genshin-db',
  'enka-profile',
  'development-cross-check'
]);

export const sourceReferenceSchema = z.object({
  id: nonEmptyIdSchema,
  source: dataSourceKindSchema,
  url: z.url().optional(),
  retrievedAt: isoDateTimeSchema,
  attribution: z.string().trim().min(1).optional()
});

export const fieldProvenanceSchema = z.object({
  fieldPath: z.string().trim().min(1),
  sourceRefId: nonEmptyIdSchema,
  note: z.string().trim().min(1).optional()
});

export const provenanceSchema = z.object({
  sourceRefs: z.array(sourceReferenceSchema).min(1),
  fields: z.array(fieldProvenanceSchema).default([])
});

export const dataManifestSchema = z.object({
  algorithm: z.literal('sha256'),
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
  signature: z.string().trim().min(1)
});

export const versionedMetaSchema = z
  .object({
    schemaVersion: z.literal(2),
    dataVersion: z.string().trim().min(1),
    effectiveFrom: isoDateTimeSchema,
    effectiveTo: isoDateTimeSchema.optional(),
    sourceRefs: z.array(sourceReferenceSchema).min(1),
    fieldProvenance: z.array(fieldProvenanceSchema).default([]),
    staleStatus: z.enum(['fresh', 'stale', 'last-known-good']),
    reviewedAt: isoDateTimeSchema,
    reviewedBy: z.string().trim().min(1),
    manifest: dataManifestSchema
  })
  .refine(
    ({ effectiveFrom, effectiveTo }) =>
      effectiveTo === undefined || Date.parse(effectiveTo) >= Date.parse(effectiveFrom),
    {
      message: 'effectiveTo must be greater than or equal to effectiveFrom',
      path: ['effectiveTo']
    }
  );

export const localizedEntityReferenceSchema = z.object({
  id: nonEmptyIdSchema,
  names: z
    .record(z.string().trim().min(1), z.string().trim().min(1))
    .refine((names) => Object.keys(names).length > 0, 'At least one localized name is required')
});

export const elementalTypeSchema = z.enum([
  'anemo',
  'geo',
  'electro',
  'dendro',
  'hydro',
  'pyro',
  'cryo'
]);

export const shieldSchema = z.object({
  element: elementalTypeSchema.or(z.literal('untyped')),
  strength: z.number().nonnegative().optional()
});

export const resistanceSchema = z.object({
  damageType: z.string().trim().min(1),
  percent: z.number().min(-100).max(1000)
});

export const enemyMechanicsSchema = z.object({
  shields: z.array(shieldSchema).default([]),
  resistances: z.array(resistanceSchema).default([]),
  immunities: z.array(z.string().trim().min(1)).default([]),
  tags: z.array(z.string().trim().min(1)).default([])
});

export const enemyInstanceSchema = z.object({
  enemy: localizedEntityReferenceSchema,
  level: z.number().int().positive(),
  count: z.number().int().positive(),
  mechanics: enemyMechanicsSchema
});

export const enemyWaveSchema = z.object({
  id: nonEmptyIdSchema,
  enemies: z.array(enemyInstanceSchema).min(1),
  spawnCondition: z.string().trim().min(1).optional()
});

export const combatHalfSchema = z.object({
  waves: z.array(enemyWaveSchema).min(1)
});

const modifierSchema = z.object({
  id: nonEmptyIdSchema,
  description: z.string().trim().min(1)
});

const spiralChamberSchema = z.object({
  chamber: z.number().int().positive(),
  firstHalf: combatHalfSchema,
  secondHalf: combatHalfSchema,
  targetSeconds: z.number().int().positive().optional()
});

const spiralFloorSchema = z.object({
  floor: z.number().int().positive(),
  chambers: z.array(spiralChamberSchema).min(1)
});

export const spiralAbyssScenarioSchema = z.object({
  mode: z.literal('spiral-abyss'),
  id: nonEmptyIdSchema,
  meta: versionedMetaSchema,
  floors: z.array(spiralFloorSchema)
});

export const crossPartyReusePolicySchema = z.discriminatedUnion('rule', [
  z.object({
    rule: z.literal('forbidden'),
    notes: z.array(z.string().trim().min(1)).default([])
  }),
  z.object({
    rule: z.literal('allowed'),
    notes: z.array(z.string().trim().min(1)).default([])
  }),
  z.object({
    rule: z.literal('limited'),
    maxPartyAppearancesPerCharacter: z.number().int().min(1).max(3),
    notes: z.array(z.string().trim().min(1)).default([])
  })
]);

const stygianDifficultySchema = z.object({
  id: nonEmptyIdSchema,
  order: z.number().int().min(1).max(6),
  name: localizedEntityReferenceSchema,
  modifiers: z.array(modifierSchema)
});

const stygianPhaseSchema = z.object({
  phase: z.number().int().min(1).max(3),
  boss: enemyInstanceSchema,
  phaseModifiers: z.array(modifierSchema),
  bossModifiers: z.array(modifierSchema)
});

const stygianDifficultiesSchema = z
  .array(stygianDifficultySchema)
  .length(6)
  .refine(
    (difficulties) => new Set(difficulties.map(({ order }) => order)).size === 6,
    'Difficulty orders must contain each configured difficulty exactly once'
  );

const stygianPhasesSchema = z
  .array(stygianPhaseSchema)
  .length(3)
  .refine(
    (phases) => new Set(phases.map(({ phase }) => phase)).size === 3,
    'Phases must contain phase 1, 2, and 3 exactly once'
  );

export const stygianOnslaughtScenarioSchema = z.object({
  mode: z.literal('stygian-onslaught'),
  id: nonEmptyIdSchema,
  meta: versionedMetaSchema,
  crossPartyReusePolicy: crossPartyReusePolicySchema,
  difficulties: stygianDifficultiesSchema,
  phases: stygianPhasesSchema
});

export const theaterPathNoteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('conditional'),
    text: z.string().trim().min(1),
    condition: z.string().trim().min(1)
  }),
  z.object({
    kind: z.literal('random'),
    text: z.string().trim().min(1)
  }),
  z.object({
    kind: z.literal('fixed'),
    text: z.string().trim().min(1)
  })
]);

const theaterEncounterSchema = z.object({
  id: nonEmptyIdSchema,
  waves: z.array(enemyWaveSchema)
});

const theaterActSchema = z.object({
  act: z.number().int().min(1).max(10),
  encounters: z.array(theaterEncounterSchema),
  pathNotes: z.array(theaterPathNoteSchema)
});

const theaterPoolsSchema = z.object({
  opening: z.array(localizedEntityReferenceSchema),
  trial: z.array(localizedEntityReferenceSchema),
  specialGuest: z.array(localizedEntityReferenceSchema),
  support: z.array(localizedEntityReferenceSchema)
});

const vigorSchema = z
  .object({
    initial: z.number().int().nonnegative(),
    max: z.number().int().positive(),
    actCosts: z.array(
      z.object({
        act: z.number().int().min(1).max(10),
        cost: z.number().int().nonnegative()
      })
    )
  })
  .refine(({ initial, max }) => initial <= max, {
    message: 'Initial vigor cannot exceed maximum vigor',
    path: ['initial']
  });

export const imaginariumTheaterScenarioSchema = z.object({
  mode: z.literal('imaginarium-theater'),
  id: nonEmptyIdSchema,
  meta: versionedMetaSchema,
  eligibility: z.object({
    elements: z.array(elementalTypeSchema).min(1),
    minimumLevel: z.number().int().positive(),
    requiredHeadcount: z.number().int().positive()
  }),
  pools: theaterPoolsSchema,
  vigor: vigorSchema,
  acts: z
    .array(theaterActSchema)
    .min(1)
    .max(10)
    .refine(
      (acts) => new Set(acts.map(({ act }) => act)).size === acts.length,
      'Theater acts must be unique'
    ),
  arcanaNodes: z
    .array(
      z.object({
        id: nonEmptyIdSchema,
        name: localizedEntityReferenceSchema,
        description: z.string().trim().min(1),
        pathNotes: z.array(theaterPathNoteSchema).default([])
      })
    )
    .optional()
});

export const scenarioV2Schema = z.discriminatedUnion('mode', [
  spiralAbyssScenarioSchema,
  stygianOnslaughtScenarioSchema,
  imaginariumTheaterScenarioSchema
]);

const prioritySchema = z.enum(['off', 'low', 'medium', 'high']);

export const playerPreferencesSchema = z.object({
  comfort: prioritySchema,
  survival: prioritySchema,
  lowInvestment: prioritySchema,
  noBuildChange: z.boolean()
});

export const recommendationTargetSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('spiral-abyss'),
    floor: z.number().int().positive(),
    chamber: z.number().int().positive().optional()
  }),
  z.object({
    mode: z.literal('stygian-onslaught'),
    difficultyId: nonEmptyIdSchema,
    phase: z.number().int().min(1).max(3).optional()
  }),
  z.object({
    mode: z.literal('imaginarium-theater'),
    act: z.number().int().min(1).max(10).optional()
  })
]);

export const playerInterventionSchema = z
  .object({
    lockedCharacterIds: z.array(nonEmptyIdSchema).default([]),
    excludedCharacterIds: z.array(nonEmptyIdSchema).default([]),
    target: recommendationTargetSchema,
    preferences: playerPreferencesSchema
  })
  .superRefine(({ lockedCharacterIds, excludedCharacterIds }, context) => {
    const excluded = new Set(excludedCharacterIds);
    const overlap = lockedCharacterIds.filter((id) => excluded.has(id));
    if (overlap.length > 0) {
      context.addIssue({
        code: 'custom',
        message: `Characters cannot be both locked and excluded: ${overlap.join(', ')}`,
        path: ['excludedCharacterIds']
      });
    }
  });

export const teamAssignmentSchema = z.object({
  id: nonEmptyIdSchema,
  characterIds: z
    .array(nonEmptyIdSchema)
    .length(4)
    .refine((ids) => new Set(ids).size === ids.length, 'A team cannot contain duplicates'),
  purpose: z.string().trim().min(1),
  rotationNotes: z.array(z.string().trim().min(1)).default([])
});

const planCommonShape = {
  scenarioId: nonEmptyIdSchema,
  dataVersion: z.string().trim().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  warnings: z.array(z.string().trim().min(1)),
  assumptions: z.array(z.string().trim().min(1))
};

const abyssHalfTacticsSchema = z
  .object({
    tactics: z.array(z.string().trim().min(1)).min(1),
    risks: z.array(z.string().trim().min(1)).default([]),
    substitutionNotes: z.array(z.string().trim().min(1)).default([])
  })
  .strict();

const abyssChamberPlanSchema = z
  .object({
    floor: z.number().int().positive(),
    chamber: z.number().int().positive(),
    firstHalf: abyssHalfTacticsSchema,
    secondHalf: abyssHalfTacticsSchema
  })
  .strict();

const abyssPlanBaseSchema = z.object({
  mode: z.literal('spiral-abyss'),
  ...planCommonShape,
  firstHalfTeam: teamAssignmentSchema,
  secondHalfTeam: teamAssignmentSchema,
  chambers: z.array(abyssChamberPlanSchema).min(1)
});

export const abyssPlanSchema = abyssPlanBaseSchema.superRefine(
  ({ firstHalfTeam, secondHalfTeam }, context) => {
    const firstHalfIds = new Set(firstHalfTeam.characterIds);
    const overlap = secondHalfTeam.characterIds.filter((id) => firstHalfIds.has(id));
    if (overlap.length > 0) {
      context.addIssue({
        code: 'custom',
        message: `Abyss halves must use non-overlapping teams: ${overlap.join(', ')}`,
        path: ['secondHalfTeam', 'characterIds']
      });
    }
  }
);

export const stygianPlanSchema = z.object({
  mode: z.literal('stygian-onslaught'),
  ...planCommonShape,
  reusePolicyAcknowledgement: z.enum(['forbidden', 'allowed', 'limited']),
  phases: z
    .array(
      z.object({
        phase: z.number().int().min(1).max(3),
        team: teamAssignmentSchema
      })
    )
    .length(3)
    .refine(
      (phases) => new Set(phases.map(({ phase }) => phase)).size === 3,
      'A Stygian plan must cover phases 1, 2, and 3 exactly once'
    )
});

const theaterPlanPathChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), note: z.string().trim().min(1) }),
  z.object({ kind: z.literal('conditional'), note: z.string().trim().min(1) }),
  z.object({ kind: z.literal('random'), note: z.string().trim().min(1) })
]);

export const theaterPlanSchema = z.object({
  mode: z.literal('imaginarium-theater'),
  ...planCommonShape,
  cast: z.object({
    openingCharacterIds: z.array(nonEmptyIdSchema),
    selectedCharacterIds: z.array(nonEmptyIdSchema).min(1),
    trialCharacterIds: z.array(nonEmptyIdSchema),
    specialGuestCharacterIds: z.array(nonEmptyIdSchema),
    supportCharacterIds: z.array(nonEmptyIdSchema)
  }),
  acts: z.array(
    z.object({
      act: z.number().int().min(1).max(10),
      candidateCharacterIds: z.array(nonEmptyIdSchema).min(1),
      plannedVigorSpend: z.array(
        z.object({
          characterId: nonEmptyIdSchema,
          cost: z.number().int().nonnegative()
        })
      ),
      pathChoice: theaterPlanPathChoiceSchema
    })
  )
});

export const recommendationPlanSchema = z.discriminatedUnion('mode', [
  abyssPlanSchema,
  stygianPlanSchema,
  theaterPlanSchema
]);

export const scenarioSchema = scenarioV2Schema;

export type DataSourceKind = z.infer<typeof dataSourceKindSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type FieldProvenanceV2 = z.infer<typeof fieldProvenanceSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type DataManifest = z.infer<typeof dataManifestSchema>;
export type VersionedMeta = z.infer<typeof versionedMetaSchema>;
export type LocalizedEntityReference = z.infer<typeof localizedEntityReferenceSchema>;
export type EnemyMechanics = z.infer<typeof enemyMechanicsSchema>;
export type EnemyInstance = z.infer<typeof enemyInstanceSchema>;
export type EnemyWave = z.infer<typeof enemyWaveSchema>;
export type SpiralAbyssScenario = z.infer<typeof spiralAbyssScenarioSchema>;
export type CrossPartyReusePolicy = z.infer<typeof crossPartyReusePolicySchema>;
export type StygianOnslaughtScenario = z.infer<typeof stygianOnslaughtScenarioSchema>;
export type ImaginariumTheaterScenario = z.infer<typeof imaginariumTheaterScenarioSchema>;
export type ScenarioV2 = z.infer<typeof scenarioV2Schema>;
export type PlayerPreferences = z.infer<typeof playerPreferencesSchema>;
export type RecommendationTarget = z.infer<typeof recommendationTargetSchema>;
export type PlayerIntervention = z.infer<typeof playerInterventionSchema>;
export type TeamAssignment = z.infer<typeof teamAssignmentSchema>;
export type AbyssPlan = z.infer<typeof abyssPlanSchema>;
export type StygianPlan = z.infer<typeof stygianPlanSchema>;
export type TheaterPlan = z.infer<typeof theaterPlanSchema>;
export type RecommendationPlan = z.infer<typeof recommendationPlanSchema>;
