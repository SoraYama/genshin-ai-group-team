import { z } from 'zod';

export function hasForbiddenIdentityControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const nonEmptyIdSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !hasForbiddenIdentityControlCharacter(value),
    'Control characters are forbidden'
  );

export const dataSourceKindSchema = z.enum([
  'official-announcement',
  'battle-chronicle',
  'community-wiki',
  'genshin-db',
  'enka-profile',
  'development-cross-check'
]);

export const scenarioPublicationSourceKindSchema = z.enum([
  'official-announcement',
  'community-wiki',
  'genshin-db'
]);

const sourceReferenceBaseShape = {
  id: nonEmptyIdSchema,
  retrievedAt: isoDateTimeSchema
};

const publishedStandardSourceReferenceSchema = z
  .object({
    ...sourceReferenceBaseShape,
    source: z.enum(['official-announcement', 'genshin-db']),
    url: z.url().optional(),
    attribution: z.string().trim().min(1).optional()
  })
  .strict();

export const internalSourceReferenceSchema = z
  .object({
    ...sourceReferenceBaseShape,
    source: z.enum(['battle-chronicle', 'enka-profile', 'development-cross-check']),
    url: z.url().optional(),
    attribution: z.string().trim().min(1).optional()
  })
  .strict();

export const communityWikiLicenseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CC-BY-SA-3.0') }).strict(),
  z
    .object({
      kind: z.literal('source-declared'),
      notice: z.string().trim().min(1),
      url: z.url()
    })
    .strict()
]);

export const communityWikiSourceReferenceSchema = z
  .object({
    ...sourceReferenceBaseShape,
    source: z.literal('community-wiki'),
    url: z.url(),
    attribution: z.string().trim().min(1),
    license: communityWikiLicenseSchema
  })
  .strict();

export const publishedSourceReferenceSchema = z.discriminatedUnion('source', [
  publishedStandardSourceReferenceSchema,
  communityWikiSourceReferenceSchema
]);

export const sourceReferenceSchema = z.discriminatedUnion('source', [
  publishedStandardSourceReferenceSchema,
  communityWikiSourceReferenceSchema,
  internalSourceReferenceSchema
]);

export const publishedScenarioFieldPathSchema = z.enum([
  'meta.effectiveRange',
  'scenario.floors',
  'scenario.blessing',
  'scenario.phases',
  'scenario.difficulties',
  'scenario.reusePolicy',
  'scenario.eligibility',
  'scenario.cast',
  'scenario.nodes',
  'scenario.vigor'
]);

export const fieldProvenanceSchema = z
  .object({
    fieldPath: z.string().trim().min(1),
    sourceRefId: nonEmptyIdSchema,
    note: z.string().trim().min(1).optional()
  })
  .strict();

export const publishedFieldProvenanceSchema = z
  .object({
    fieldPath: publishedScenarioFieldPathSchema,
    sourceRefId: nonEmptyIdSchema,
    note: z.string().trim().min(1).optional()
  })
  .strict();

export const provenanceSchema = z
  .object({
    sourceRefs: z.array(sourceReferenceSchema).min(1),
    fields: z.array(fieldProvenanceSchema).min(1)
  })
  .strict()
  .superRefine(({ sourceRefs, fields }, context) => {
    const sourceRefIds = new Set(sourceRefs.map(({ id }) => id));
    if (sourceRefIds.size !== sourceRefs.length) {
      context.addIssue({
        code: 'custom',
        message: 'Source reference IDs must be unique',
        path: ['sourceRefs']
      });
    }
    fields.forEach(({ sourceRefId }, index) => {
      if (!sourceRefIds.has(sourceRefId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown source reference: ${sourceRefId}`,
          path: ['fields', index, 'sourceRefId']
        });
      }
    });
  });

export const internalReviewEvidenceSchema = z
  .object({
    sourceRefs: z.array(internalSourceReferenceSchema).min(1),
    fieldProvenance: z.array(fieldProvenanceSchema).min(1)
  })
  .strict()
  .superRefine(({ sourceRefs, fieldProvenance }, context) => {
    const sourceRefIds = new Set(sourceRefs.map(({ id }) => id));
    if (sourceRefIds.size !== sourceRefs.length) {
      context.addIssue({
        code: 'custom',
        message: 'Internal source reference IDs must be unique',
        path: ['sourceRefs']
      });
    }
    fieldProvenance.forEach(({ sourceRefId }, index) => {
      if (!sourceRefIds.has(sourceRefId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown internal source reference: ${sourceRefId}`,
          path: ['fieldProvenance', index, 'sourceRefId']
        });
      }
    });
  });

const sha256Base64Schema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const ed25519Base64Schema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);

export const publicationIntegritySchema = z
  .object({
    scope: z.literal('payload'),
    serialization: z.literal('RFC8785-JCS'),
    hash: z
      .object({
        algorithm: z.literal('sha256'),
        encoding: z.literal('base64'),
        value: sha256Base64Schema
      })
      .strict(),
    signature: z
      .object({
        algorithm: z.literal('ed25519'),
        keyId: nonEmptyIdSchema,
        encoding: z.literal('base64'),
        value: ed25519Base64Schema
      })
      .strict()
  })
  .strict();

export const versionedMetaSchema = z
  .object({
    schemaVersion: z.literal(2),
    dataVersion: nonEmptyIdSchema,
    effectiveFrom: isoDateTimeSchema,
    effectiveTo: isoDateTimeSchema.optional(),
    sourceRefs: z.array(publishedSourceReferenceSchema).min(1),
    fieldProvenance: z.array(publishedFieldProvenanceSchema).min(1),
    reviewedAt: isoDateTimeSchema,
    reviewedBy: z.string().trim().min(1)
  })
  .strict()
  .superRefine(({ effectiveFrom, effectiveTo, sourceRefs, fieldProvenance }, context) => {
    if (effectiveTo !== undefined && Date.parse(effectiveTo) < Date.parse(effectiveFrom)) {
      context.addIssue({
        code: 'custom',
        message: 'effectiveTo must be greater than or equal to effectiveFrom',
        path: ['effectiveTo']
      });
    }

    const sourceRefIds = new Set(sourceRefs.map(({ id }) => id));
    if (sourceRefIds.size !== sourceRefs.length) {
      context.addIssue({
        code: 'custom',
        message: 'Source reference IDs must be unique',
        path: ['sourceRefs']
      });
    }

    fieldProvenance.forEach(({ sourceRefId }, index) => {
      if (!sourceRefIds.has(sourceRefId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown source reference: ${sourceRefId}`,
          path: ['fieldProvenance', index, 'sourceRefId']
        });
      }
    });

    const sourceById = new Map(sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
    const provenanceByFieldPath = new Map<string, typeof fieldProvenance>();
    fieldProvenance.forEach((provenance) => {
      const entries = provenanceByFieldPath.get(provenance.fieldPath) ?? [];
      entries.push(provenance);
      provenanceByFieldPath.set(provenance.fieldPath, entries);
    });

    provenanceByFieldPath.forEach((provenanceEntries, fieldPath) => {
      const hasAllowedSceneSource = provenanceEntries.some(({ sourceRefId }) => {
        const source = sourceById.get(sourceRefId)?.source;
        return (
          source !== undefined && scenarioPublicationSourceKindSchema.safeParse(source).success
        );
      });
      if (!hasAllowedSceneSource) {
        context.addIssue({
          code: 'custom',
          message: `Published field requires an allowed scene source: ${fieldPath}`,
          path: ['fieldProvenance']
        });
      }
    });
  });

const requiredFieldPathsByMode = {
  'spiral-abyss': ['meta.effectiveRange', 'scenario.floors', 'scenario.blessing'],
  'stygian-onslaught': [
    'meta.effectiveRange',
    'scenario.phases',
    'scenario.difficulties',
    'scenario.reusePolicy'
  ],
  'imaginarium-theater': [
    'meta.effectiveRange',
    'scenario.eligibility',
    'scenario.cast',
    'scenario.nodes',
    'scenario.vigor'
  ]
} as const;

function validateModeFieldCoverage(
  mode: keyof typeof requiredFieldPathsByMode,
  fieldProvenance: z.infer<typeof publishedFieldProvenanceSchema>[],
  context: z.RefinementCtx
): void {
  const requiredPaths = requiredFieldPathsByMode[mode];
  const requiredPathSet = new Set<string>(requiredPaths);
  const actualPaths = new Set(fieldProvenance.map(({ fieldPath }) => fieldPath));

  fieldProvenance.forEach(({ fieldPath }, index) => {
    if (!requiredPathSet.has(fieldPath)) {
      context.addIssue({
        code: 'custom',
        message: `Field path does not belong to ${mode}: ${fieldPath}`,
        path: ['meta', 'fieldProvenance', index, 'fieldPath']
      });
    }
  });

  requiredPaths.forEach((fieldPath) => {
    if (!actualPaths.has(fieldPath)) {
      context.addIssue({
        code: 'custom',
        message: `Missing required provenance path for ${mode}: ${fieldPath}`,
        path: ['meta', 'fieldProvenance']
      });
    }
  });
}

export const localizedEntityReferenceSchema = z
  .object({
    id: nonEmptyIdSchema,
    names: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .refine((names) => Object.keys(names).length > 0, 'At least one localized name is required')
  })
  .strict();

export const elementalTypeSchema = z.enum([
  'anemo',
  'geo',
  'electro',
  'dendro',
  'hydro',
  'pyro',
  'cryo'
]);

export const shieldSchema = z
  .object({
    element: elementalTypeSchema.or(z.literal('untyped')),
    strength: z.number().nonnegative().optional()
  })
  .strict();

export const resistanceSchema = z
  .object({
    damageType: z.string().trim().min(1),
    percent: z.number().min(-100).max(1000)
  })
  .strict();

export const enemyMechanicsSchema = z
  .object({
    shields: z.array(shieldSchema).default([]),
    resistances: z.array(resistanceSchema).default([]),
    immunities: z.array(z.string().trim().min(1)).default([]),
    tags: z.array(z.string().trim().min(1)).default([])
  })
  .strict();

export const enemyInstanceSchema = z
  .object({
    enemy: localizedEntityReferenceSchema,
    level: z.number().int().positive(),
    count: z.number().int().positive(),
    mechanics: enemyMechanicsSchema
  })
  .strict();

export const enemyWaveSchema = z
  .object({
    id: nonEmptyIdSchema,
    enemies: z.array(enemyInstanceSchema).min(1),
    spawnCondition: z.string().trim().min(1).optional()
  })
  .strict();

const enemyWavesSchema = z
  .array(enemyWaveSchema)
  .refine(
    (waves) => new Set(waves.map(({ id }) => id)).size === waves.length,
    'Wave IDs must be unique within an encounter'
  );

export const combatHalfSchema = z.object({ waves: enemyWavesSchema.min(1) }).strict();

const modifierSchema = z
  .object({
    id: nonEmptyIdSchema,
    description: z.string().trim().min(1)
  })
  .strict();

const modifiersSchema = z
  .array(modifierSchema)
  .refine(
    (modifiers) => new Set(modifiers.map(({ id }) => id)).size === modifiers.length,
    'Modifier IDs must be unique within a modifier collection'
  );

const spiralChamberSchema = z
  .object({
    chamber: z.number().int().positive(),
    firstHalf: combatHalfSchema,
    secondHalf: combatHalfSchema,
    targetSeconds: z.number().int().positive().optional()
  })
  .strict();

const spiralFloorSchema = z
  .object({
    floor: z.number().int().positive(),
    chambers: z
      .array(spiralChamberSchema)
      .min(1)
      .refine(
        (chambers) => new Set(chambers.map(({ chamber }) => chamber)).size === chambers.length,
        'Chamber numbers must be unique within a floor'
      )
  })
  .strict();

export const spiralAbyssScenarioSchema = z
  .object({
    mode: z.literal('spiral-abyss'),
    id: nonEmptyIdSchema,
    meta: versionedMetaSchema,
    blessing: modifierSchema,
    floors: z
      .array(spiralFloorSchema)
      .min(1)
      .refine(
        (floors) => new Set(floors.map(({ floor }) => floor)).size === floors.length,
        'Abyss floor numbers must be unique'
      )
  })
  .strict()
  .superRefine(({ meta }, context) => {
    validateModeFieldCoverage('spiral-abyss', meta.fieldProvenance, context);
  });

export const crossPartyReusePolicySchema = z.discriminatedUnion('rule', [
  z
    .object({
      rule: z.literal('forbidden'),
      notes: z.array(z.string().trim().min(1)).default([])
    })
    .strict(),
  z
    .object({
      rule: z.literal('allowed'),
      notes: z.array(z.string().trim().min(1)).default([])
    })
    .strict(),
  z
    .object({
      rule: z.literal('limited'),
      maxPartyAppearancesPerCharacter: z.number().int().min(1).max(3),
      notes: z.array(z.string().trim().min(1)).default([])
    })
    .strict()
]);

const stygianDifficultySchema = z
  .object({
    id: nonEmptyIdSchema,
    order: z.number().int().min(1).max(6),
    name: localizedEntityReferenceSchema,
    modifiers: modifiersSchema
  })
  .strict();

const stygianPhaseSchema = z
  .object({
    phase: z.number().int().min(1).max(3),
    encounterId: nonEmptyIdSchema,
    boss: enemyInstanceSchema,
    phaseModifiers: modifiersSchema,
    bossModifiers: modifiersSchema
  })
  .strict();

const stygianDifficultiesSchema = z
  .array(stygianDifficultySchema)
  .length(6)
  .refine(
    (difficulties) => new Set(difficulties.map(({ order }) => order)).size === 6,
    'Difficulty orders must contain each configured difficulty exactly once'
  )
  .refine(
    (difficulties) => new Set(difficulties.map(({ id }) => id)).size === difficulties.length,
    'Difficulty IDs must be unique'
  );

const stygianPhasesSchema = z
  .array(stygianPhaseSchema)
  .length(3)
  .refine(
    (phases) => new Set(phases.map(({ phase }) => phase)).size === 3,
    'Phases must contain phase 1, 2, and 3 exactly once'
  )
  .refine(
    (phases) => new Set(phases.map(({ encounterId }) => encounterId)).size === phases.length,
    'Stygian encounter IDs must be unique'
  );

export const stygianOnslaughtScenarioSchema = z
  .object({
    mode: z.literal('stygian-onslaught'),
    id: nonEmptyIdSchema,
    meta: versionedMetaSchema,
    crossPartyReusePolicy: crossPartyReusePolicySchema,
    difficulties: stygianDifficultiesSchema,
    phases: stygianPhasesSchema
  })
  .strict()
  .superRefine(({ meta }, context) => {
    validateModeFieldCoverage('stygian-onslaught', meta.fieldProvenance, context);
  });

export const theaterPathNoteSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('conditional'),
      text: z.string().trim().min(1),
      condition: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal('random'),
      text: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal('fixed'),
      text: z.string().trim().min(1)
    })
    .strict()
]);

const theaterEncounterSchema = z
  .object({
    id: nonEmptyIdSchema,
    waves: enemyWavesSchema
  })
  .strict();

const theaterActSchema = z
  .object({
    act: z.number().int().min(1).max(10),
    encounters: z
      .array(theaterEncounterSchema)
      .refine(
        (encounters) => new Set(encounters.map(({ id }) => id)).size === encounters.length,
        'Encounter IDs must be unique within a Theater act'
      ),
    pathNotes: z.array(theaterPathNoteSchema)
  })
  .strict();

const uniqueEntityReferencesSchema = z
  .array(localizedEntityReferenceSchema)
  .refine(
    (entities) => new Set(entities.map(({ id }) => id)).size === entities.length,
    'Entity IDs must be unique within a cast pool'
  );

const theaterPoolsSchema = z
  .object({
    opening: uniqueEntityReferencesSchema,
    trial: uniqueEntityReferencesSchema,
    specialGuest: uniqueEntityReferencesSchema,
    support: uniqueEntityReferencesSchema
  })
  .strict();

const vigorActCostsSchema = z
  .array(
    z
      .object({
        act: z.number().int().min(1).max(10),
        cost: z.number().int().nonnegative()
      })
      .strict()
  )
  .refine(
    (costs) => new Set(costs.map(({ act }) => act)).size === costs.length,
    'Vigor act-cost act IDs must be unique'
  );

const vigorNodeCostsSchema = z
  .array(
    z
      .object({
        nodeId: nonEmptyIdSchema,
        cost: z.number().int().nonnegative()
      })
      .strict()
  )
  .refine(
    (costs) => new Set(costs.map(({ nodeId }) => nodeId)).size === costs.length,
    'Vigor node-cost node IDs must be unique'
  );

const vigorSchema = z
  .object({
    initial: z.number().int().nonnegative(),
    max: z.number().int().positive(),
    actCosts: vigorActCostsSchema,
    nodeCosts: vigorNodeCostsSchema.default([])
  })
  .strict()
  .refine(({ initial, max }) => initial <= max, {
    message: 'Initial vigor cannot exceed maximum vigor',
    path: ['initial']
  });

export const imaginariumTheaterScenarioSchema = z
  .object({
    mode: z.literal('imaginarium-theater'),
    id: nonEmptyIdSchema,
    meta: versionedMetaSchema,
    eligibility: z
      .object({
        elements: z.array(elementalTypeSchema).min(1),
        minimumLevel: z.number().int().positive(),
        requiredHeadcount: z.number().int().positive()
      })
      .strict(),
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
        z
          .object({
            id: nonEmptyIdSchema,
            name: localizedEntityReferenceSchema,
            description: z.string().trim().min(1),
            pathNotes: z.array(theaterPathNoteSchema).default([])
          })
          .strict()
      )
      .refine(
        (nodes) => new Set(nodes.map(({ id }) => id)).size === nodes.length,
        'Arcana node IDs must be unique'
      )
      .optional()
  })
  .strict()
  .superRefine(({ meta }, context) => {
    validateModeFieldCoverage('imaginarium-theater', meta.fieldProvenance, context);
  });

export const scenarioV2Schema = z.discriminatedUnion('mode', [
  spiralAbyssScenarioSchema,
  stygianOnslaughtScenarioSchema,
  imaginariumTheaterScenarioSchema
]);

export const scenarioPublicationEnvelopeSchema = z
  .object({
    payload: scenarioV2Schema,
    integrity: publicationIntegritySchema
  })
  .strict();

export const scenarioRuntimeStateSchema = z
  .object({
    freshness: z.enum(['fresh', 'stale', 'last-known-good', 'refresh-failed']),
    checkedAt: isoDateTimeSchema,
    lastRefreshAttemptAt: isoDateTimeSchema.optional(),
    refreshErrorCode: z.string().trim().min(1).optional()
  })
  .strict();

export const scenarioCacheEnvelopeSchema = z
  .object({
    publication: scenarioPublicationEnvelopeSchema,
    runtime: scenarioRuntimeStateSchema
  })
  .strict();

const prioritySchema = z.enum(['off', 'low', 'medium', 'high']);

export const playerPreferencesSchema = z
  .object({
    comfort: prioritySchema,
    survival: prioritySchema,
    lowInvestment: prioritySchema,
    noBuildChange: z.boolean()
  })
  .strict();

export const recommendationTargetSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('spiral-abyss'),
      floor: z.number().int().positive(),
      chamber: z.number().int().positive().optional()
    })
    .strict(),
  z
    .object({
      mode: z.literal('stygian-onslaught'),
      difficultyId: nonEmptyIdSchema,
      phase: z.number().int().min(1).max(3).optional()
    })
    .strict(),
  z
    .object({
      mode: z.literal('imaginarium-theater'),
      act: z.number().int().min(1).max(10).optional()
    })
    .strict()
]);

export const playerInterventionSchema = z
  .object({
    lockedCharacterIds: z
      .array(nonEmptyIdSchema)
      .refine((ids) => new Set(ids).size === ids.length, 'Locked character IDs must be unique')
      .default([]),
    excludedCharacterIds: z
      .array(nonEmptyIdSchema)
      .refine((ids) => new Set(ids).size === ids.length, 'Excluded character IDs must be unique')
      .default([]),
    target: recommendationTargetSchema,
    preferences: playerPreferencesSchema
  })
  .strict()
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

export const teamAssignmentSchema = z
  .object({
    id: nonEmptyIdSchema,
    characterIds: z
      .array(nonEmptyIdSchema)
      .length(4)
      .refine((ids) => new Set(ids).size === ids.length, 'A team cannot contain duplicates'),
    purpose: z.string().trim().min(1),
    rotationNotes: z.array(z.string().trim().min(1)).default([])
  })
  .strict();

const planCommonShape = {
  schemaVersion: z.literal(2),
  scenarioId: nonEmptyIdSchema,
  dataVersion: nonEmptyIdSchema,
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

const abyssPlanBaseSchema = z
  .object({
    mode: z.literal('spiral-abyss'),
    ...planCommonShape,
    firstHalfTeam: teamAssignmentSchema,
    secondHalfTeam: teamAssignmentSchema,
    chambers: z
      .array(abyssChamberPlanSchema)
      .min(1)
      .refine(
        (chambers) =>
          new Set(chambers.map(({ floor, chamber }) => `${floor}:${chamber}`)).size ===
          chambers.length,
        'Abyss plan chamber coordinates must be unique'
      )
  })
  .strict();

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

export const stygianPlanSchema = z
  .object({
    mode: z.literal('stygian-onslaught'),
    ...planCommonShape,
    reusePolicyAcknowledgement: z.enum(['forbidden', 'allowed', 'limited']),
    phases: z
      .array(
        z
          .object({
            phase: z.number().int().min(1).max(3),
            team: teamAssignmentSchema
          })
          .strict()
      )
      .length(3)
      .refine(
        (phases) => new Set(phases.map(({ phase }) => phase)).size === 3,
        'A Stygian plan must cover phases 1, 2, and 3 exactly once'
      )
  })
  .strict();

const theaterPlanPathChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), note: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('conditional'), note: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('random'), note: z.string().trim().min(1) }).strict()
]);

const uniqueCharacterIdsSchema = z
  .array(nonEmptyIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, 'Character IDs must be unique');

const nonEmptyUniqueCharacterIdsSchema = z
  .array(nonEmptyIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, 'Character IDs must be unique');

const plannedVigorSpendSchema = z
  .array(
    z
      .object({
        characterId: nonEmptyIdSchema,
        cost: z.number().int().nonnegative()
      })
      .strict()
  )
  .refine(
    (spends) => new Set(spends.map(({ characterId }) => characterId)).size === spends.length,
    'Planned vigor-spend character IDs must be unique within an act'
  );

export const theaterPlanSchema = z
  .object({
    mode: z.literal('imaginarium-theater'),
    ...planCommonShape,
    cast: z
      .object({
        openingCharacterIds: uniqueCharacterIdsSchema,
        selectedCharacterIds: nonEmptyUniqueCharacterIdsSchema,
        trialCharacterIds: uniqueCharacterIdsSchema,
        specialGuestCharacterIds: uniqueCharacterIdsSchema,
        supportCharacterIds: uniqueCharacterIdsSchema
      })
      .strict(),
    acts: z
      .array(
        z
          .object({
            act: z.number().int().min(1).max(10),
            candidateCharacterIds: nonEmptyUniqueCharacterIdsSchema,
            plannedVigorSpend: plannedVigorSpendSchema,
            pathChoice: theaterPlanPathChoiceSchema
          })
          .strict()
      )
      .min(1)
      .max(10)
      .refine(
        (acts) => new Set(acts.map(({ act }) => act)).size === acts.length,
        'Theater plan act numbers must be unique'
      )
  })
  .strict();

export const recommendationPlanSchema = z.discriminatedUnion('mode', [
  abyssPlanSchema,
  stygianPlanSchema,
  theaterPlanSchema
]);

export const scenarioSchema = scenarioV2Schema;

export type DataSourceKind = z.infer<typeof dataSourceKindSchema>;
export type ScenarioPublicationSourceKind = z.infer<typeof scenarioPublicationSourceKindSchema>;
export type CommunityWikiLicense = z.infer<typeof communityWikiLicenseSchema>;
export type PublishedSourceReference = z.infer<typeof publishedSourceReferenceSchema>;
export type InternalSourceReference = z.infer<typeof internalSourceReferenceSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type FieldProvenanceV2 = z.infer<typeof fieldProvenanceSchema>;
export type PublishedScenarioFieldPath = z.infer<typeof publishedScenarioFieldPathSchema>;
export type PublishedFieldProvenance = z.infer<typeof publishedFieldProvenanceSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type InternalReviewEvidence = z.infer<typeof internalReviewEvidenceSchema>;
export type PublicationIntegrity = z.infer<typeof publicationIntegritySchema>;
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
export type ScenarioPublicationEnvelope = z.infer<typeof scenarioPublicationEnvelopeSchema>;
export type ScenarioRuntimeState = z.infer<typeof scenarioRuntimeStateSchema>;
export type ScenarioCacheEnvelope = z.infer<typeof scenarioCacheEnvelopeSchema>;
export type PlayerPreferences = z.infer<typeof playerPreferencesSchema>;
export type RecommendationTarget = z.infer<typeof recommendationTargetSchema>;
export type PlayerIntervention = z.infer<typeof playerInterventionSchema>;
export type TeamAssignment = z.infer<typeof teamAssignmentSchema>;
export type AbyssPlan = z.infer<typeof abyssPlanSchema>;
export type StygianPlan = z.infer<typeof stygianPlanSchema>;
export type TheaterPlan = z.infer<typeof theaterPlanSchema>;
export type RecommendationPlan = z.infer<typeof recommendationPlanSchema>;
