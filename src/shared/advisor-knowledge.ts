import { z } from 'zod';

const boundedIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'ID contains unsupported characters');
const boundedNameSchema = z.string().trim().min(1).max(120);
const boundedSummarySchema = z.string().trim().min(1).max(1_000);
const boundedFactSchema = z.string().trim().min(1).max(600);
const uniqueBoundedIdsSchema = z
  .array(boundedIdSchema)
  .max(32)
  .refine((ids) => new Set(ids).size === ids.length, 'IDs must be unique');

export const canonicalCharacterIdSchema = z
  .string()
  .trim()
  .max(20)
  .regex(/^[1-9]\d*$/, 'Character IDs must be canonical positive decimal strings');

export const knowledgeTrustSchema = z.enum(['trusted-local', 'ephemeral-web']);

const httpsUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(2_048)
  .refine((value) => {
    const url = parseUrl(value);
    return url !== undefined && url.username.length === 0 && url.password.length === 0;
  }, 'URL credentials are not allowed');
const reviewedAtSchema = z.iso.datetime({ offset: true }).max(40);

const declaredHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Host must be a lowercase DNS hostname'
  );

export const sourceRegistryEntrySchema = z
  .object({
    id: boundedIdSchema,
    name: boundedNameSchema,
    hosts: z
      .array(declaredHostSchema)
      .min(1)
      .max(16)
      .refine((hosts) => new Set(hosts).size === hosts.length, 'Hosts must be unique'),
    trust: knowledgeTrustSchema,
    homepageUrl: httpsUrlSchema.optional()
  })
  .strict()
  .superRefine(({ hosts, homepageUrl }, context) => {
    const homepage = homepageUrl === undefined ? undefined : parseUrl(homepageUrl);
    if (
      homepageUrl !== undefined &&
      (homepage === undefined || !hosts.includes(homepage.hostname.toLowerCase()))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['homepageUrl'],
        message: 'Homepage URL host must be declared by the source'
      });
    }
  });

export const sourceCitationSchema = z
  .object({
    id: boundedIdSchema,
    sourceId: boundedIdSchema,
    url: httpsUrlSchema,
    title: z.string().trim().min(1).max(240),
    reviewedAt: reviewedAtSchema,
    trust: knowledgeTrustSchema
  })
  .strict();

export const sourceRegistrySchema = z
  .object({
    sources: z.array(sourceRegistryEntrySchema).max(128),
    citations: z.array(sourceCitationSchema).max(512)
  })
  .strict()
  .superRefine(({ sources, citations }, context) => {
    addDuplicateIdIssues(sources, ['sources'], context);
    addDuplicateIdIssues(citations, ['citations'], context);

    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    citations.forEach((citation, index) => {
      const source = sourcesById.get(citation.sourceId);
      if (source === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['citations', index, 'sourceId'],
          message: 'Citation sourceId must resolve in the source registry'
        });
        return;
      }
      const citationUrl = parseUrl(citation.url);
      if (citationUrl === undefined || !source.hosts.includes(citationUrl.hostname.toLowerCase())) {
        context.addIssue({
          code: 'custom',
          path: ['citations', index, 'url'],
          message: 'Citation URL host must be declared by its source'
        });
      }
      if (source.trust !== citation.trust) {
        context.addIssue({
          code: 'custom',
          path: ['citations', index, 'trust'],
          message: 'Citation trust must match its registered source'
        });
      }
    });
  });

export const characterCatalogEntrySchema = z
  .object({
    id: canonicalCharacterIdSchema,
    name: boundedNameSchema,
    aliases: z
      .array(z.string().trim().min(1).max(120))
      .max(16)
      .refine((aliases) => new Set(aliases).size === aliases.length, 'Aliases must be unique')
      .default([]),
    element: z.string().trim().min(1).max(32).optional(),
    weaponType: z.string().trim().min(1).max(32).optional()
  })
  .strict();

export const characterCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    knowledgeVersion: z.string().trim().min(1).max(128),
    characters: z.array(characterCatalogEntrySchema).max(256)
  })
  .strict()
  .superRefine(({ characters }, context) => {
    addDuplicateIdIssues(characters, ['characters'], context);
  });

const signalPredicateCommonShape = {
  id: boundedIdSchema,
  description: z.string().trim().min(1).max(240)
};

const categoricalSignalPredicateSchema = z
  .object({
    ...signalPredicateCommonShape,
    field: z.enum(['weapon', 'artifactSet', 'sandsMainStat', 'gobletMainStat', 'circletMainStat']),
    operator: z.enum(['eq', 'includes']),
    value: z.string().trim().min(1).max(160)
  })
  .strict();

const numericSignalPredicateSchema = z
  .object({
    ...signalPredicateCommonShape,
    field: z.enum([
      'hp',
      'atk',
      'def',
      'critRate',
      'critDmg',
      'energyRecharge',
      'elementalMastery'
    ]),
    operator: z.enum(['eq', 'gte', 'lte']),
    value: z.number().finite()
  })
  .strict();

export const signalPredicateSchema = z.discriminatedUnion('field', [
  categoricalSignalPredicateSchema,
  numericSignalPredicateSchema
]);

export const strategyFactSchema = z
  .object({
    id: boundedIdSchema,
    statement: boundedFactSchema,
    citationIds: uniqueBoundedIdsSchema.min(1)
  })
  .strict();

export const buildArchetypeSchema = z
  .object({
    id: boundedIdSchema,
    name: boundedNameSchema,
    signals: z.array(signalPredicateSchema).max(24),
    facts: z.array(strategyFactSchema).min(1).max(32)
  })
  .strict()
  .superRefine(({ signals, facts }, context) => {
    addDuplicateIdIssues(signals, ['signals'], context);
    addDuplicateIdIssues(facts, ['facts'], context);
  });

export const characterStrategySchema = z
  .object({
    id: canonicalCharacterIdSchema,
    name: boundedNameSchema,
    archetypes: z.array(buildArchetypeSchema).min(1).max(16)
  })
  .strict();

export const characterStrategyBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    knowledgeVersion: z.string().trim().min(1).max(128),
    trust: z.literal('trusted-local'),
    sourceRegistry: sourceRegistrySchema,
    characters: z.array(characterStrategySchema).max(256)
  })
  .strict()
  .superRefine(({ sourceRegistry, characters }, context) => {
    addDuplicateIdIssues(characters, ['characters'], context);
    addDuplicateArchetypeIdIssues(characters, context);
    ensureTrustedRegistry(sourceRegistry, ['sourceRegistry'], context);
    ensureFactCitationsResolve(
      characters.flatMap(({ archetypes }, characterIndex) =>
        archetypes.flatMap(({ facts }, archetypeIndex) =>
          facts.map((fact, factIndex) => ({
            fact,
            path: ['characters', characterIndex, 'archetypes', archetypeIndex, 'facts', factIndex]
          }))
        )
      ),
      sourceRegistry,
      context
    );
  });

export const enemyMechanicStrategySchema = z
  .object({
    id: boundedIdSchema,
    name: boundedNameSchema,
    matchTags: z
      .array(z.string().trim().min(1).max(80))
      .min(1)
      .max(24)
      .refine((tags) => new Set(tags).size === tags.length, 'Match tags must be unique'),
    facts: z.array(strategyFactSchema).min(1).max(32)
  })
  .strict()
  .superRefine(({ facts }, context) => {
    addDuplicateIdIssues(facts, ['facts'], context);
  });

export const enemyMechanicStrategyBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    knowledgeVersion: z.string().trim().min(1).max(128),
    trust: z.literal('trusted-local'),
    sourceRegistry: sourceRegistrySchema,
    mechanics: z.array(enemyMechanicStrategySchema).max(256)
  })
  .strict()
  .superRefine(({ sourceRegistry, mechanics }, context) => {
    addDuplicateIdIssues(mechanics, ['mechanics'], context);
    ensureTrustedRegistry(sourceRegistry, ['sourceRegistry'], context);
    ensureFactCitationsResolve(
      mechanics.flatMap(({ facts }, mechanicIndex) =>
        facts.map((fact, factIndex) => ({
          fact,
          path: ['mechanics', mechanicIndex, 'facts', factIndex]
        }))
      ),
      sourceRegistry,
      context
    );
  });

export const buildInterpretationSchema = z
  .object({
    characterId: canonicalCharacterIdSchema,
    archetypeId: z.string().trim().min(1).max(80).nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    matchedSignals: z.array(z.string().trim().min(1).max(160)).max(12),
    conflictingSignals: z.array(z.string().trim().min(1).max(160)).max(12),
    currentBuildUsable: z.boolean(),
    adjustment: z.enum(['none', 'optional', 'required']),
    unknowns: z.array(z.string().trim().min(1).max(200)).max(12)
  })
  .strict();

export const trustedKnowledgeMatchSchema = z
  .object({
    id: boundedIdSchema,
    characterId: canonicalCharacterIdSchema.optional(),
    mechanicId: boundedIdSchema.optional(),
    archetypeId: z.string().trim().min(1).max(80).nullable().optional(),
    summary: boundedSummarySchema,
    citationIds: uniqueBoundedIdsSchema.min(1)
  })
  .strict()
  .refine(
    ({ characterId, mechanicId }) => characterId !== undefined || mechanicId !== undefined,
    'A trusted knowledge match must identify a character or mechanic'
  );

export const ephemeralGuideMatchSchema = z
  .object({
    id: boundedIdSchema,
    subjectId: boundedIdSchema,
    summary: boundedSummarySchema,
    citationIds: uniqueBoundedIdsSchema.min(1)
  })
  .strict();

export const knowledgeGapSchema = z
  .object({
    id: boundedIdSchema,
    subjectId: boundedIdSchema,
    reason: z.string().trim().min(1).max(500)
  })
  .strict();

export const citationSchema = sourceCitationSchema;

const knowledgeCoverageSchema = z
  .object({
    requested: z.number().int().nonnegative().max(512),
    trusted: z.number().int().nonnegative().max(512),
    ephemeral: z.number().int().nonnegative().max(512),
    unknown: z.number().int().nonnegative().max(512)
  })
  .strict();

export const knowledgeContextPacketSchema = z
  .object({
    knowledgeVersion: z.string().trim().min(1).max(128),
    buildInterpretations: z.array(buildInterpretationSchema).max(256),
    trustedMatches: z.array(trustedKnowledgeMatchSchema).max(512),
    ephemeralMatches: z.array(ephemeralGuideMatchSchema).max(256),
    unknowns: z.array(knowledgeGapSchema).max(256),
    coverage: knowledgeCoverageSchema,
    citations: z.array(citationSchema).max(768)
  })
  .strict()
  .superRefine(
    (
      { buildInterpretations, trustedMatches, ephemeralMatches, unknowns, coverage, citations },
      context
    ) => {
      addDuplicateIdIssues(
        buildInterpretations.map((interpretation) => ({ id: interpretation.characterId })),
        ['buildInterpretations'],
        context,
        'Build interpretations must have unique character IDs'
      );
      addDuplicateIdIssues(citations, ['citations'], context);
      addDuplicateIdIssues(trustedMatches, ['trustedMatches'], context);
      addDuplicateIdIssues(ephemeralMatches, ['ephemeralMatches'], context);
      addDuplicateIdIssues(unknowns, ['unknowns'], context);
      addCrossKnowledgeIdIssues({ trustedMatches, ephemeralMatches, unknowns }, context);

      if (coverage.requested !== coverage.trusted + coverage.ephemeral + coverage.unknown) {
        context.addIssue({
          code: 'custom',
          path: ['coverage', 'requested'],
          message: 'Requested coverage must equal trusted + ephemeral + unknown'
        });
      }
      if (
        coverage.trusted !== trustedMatches.length ||
        coverage.ephemeral !== ephemeralMatches.length ||
        coverage.unknown !== unknowns.length
      ) {
        context.addIssue({
          code: 'custom',
          path: ['coverage'],
          message: 'Coverage counts must match trusted, ephemeral, and unknown entries'
        });
      }

      const citationsById = new Map(citations.map((citation) => [citation.id, citation]));
      ensureContextMatchCitations(
        trustedMatches,
        'trustedMatches',
        'trusted-local',
        citationsById,
        context
      );
      ensureContextMatchCitations(
        ephemeralMatches,
        'ephemeralMatches',
        'ephemeral-web',
        citationsById,
        context
      );
    }
  );

function addDuplicateIdIssues(
  entries: ReadonlyArray<{ id: string }>,
  path: Array<string | number>,
  context: z.RefinementCtx,
  message = 'IDs must be unique'
): void {
  const seen = new Set<string>();
  entries.forEach(({ id }, index) => {
    if (seen.has(id)) {
      context.addIssue({ code: 'custom', path: [...path, index, 'id'], message });
    }
    seen.add(id);
  });
}

function addDuplicateArchetypeIdIssues(
  characters: ReadonlyArray<z.infer<typeof characterStrategySchema>>,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  characters.forEach(({ archetypes }, characterIndex) => {
    archetypes.forEach(({ id }, archetypeIndex) => {
      if (seen.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['characters', characterIndex, 'archetypes', archetypeIndex, 'id'],
          message: 'Archetype IDs must be unique'
        });
      }
      seen.add(id);
    });
  });
}

function addCrossKnowledgeIdIssues(
  groups: {
    trustedMatches: ReadonlyArray<{ id: string }>;
    ephemeralMatches: ReadonlyArray<{ id: string }>;
    unknowns: ReadonlyArray<{ id: string }>;
  },
  context: z.RefinementCtx
): void {
  const firstGroupById = new Map<string, keyof typeof groups>();
  (
    [
      ['trustedMatches', groups.trustedMatches],
      ['ephemeralMatches', groups.ephemeralMatches],
      ['unknowns', groups.unknowns]
    ] as const
  ).forEach(([groupName, entries]) => {
    entries.forEach(({ id }, index) => {
      const firstGroup = firstGroupById.get(id);
      if (firstGroup !== undefined && firstGroup !== groupName) {
        context.addIssue({
          code: 'custom',
          path: [groupName, index, 'id'],
          message: 'Knowledge match and gap IDs must be unique across arrays'
        });
      } else if (firstGroup === undefined) {
        firstGroupById.set(id, groupName);
      }
    });
  });
}

function ensureTrustedRegistry(
  registry: z.infer<typeof sourceRegistrySchema>,
  path: Array<string | number>,
  context: z.RefinementCtx
): void {
  registry.citations.forEach((citation, index) => {
    if (citation.trust !== 'trusted-local') {
      context.addIssue({
        code: 'custom',
        path: [...path, 'citations', index, 'trust'],
        message: 'Ephemeral web citations cannot enter a trusted local bundle'
      });
    }
  });
}

function ensureFactCitationsResolve(
  entries: Array<{ fact: z.infer<typeof strategyFactSchema>; path: Array<string | number> }>,
  registry: z.infer<typeof sourceRegistrySchema>,
  context: z.RefinementCtx
): void {
  const citations = new Set(registry.citations.map(({ id }) => id));
  entries.forEach(({ fact, path }) => {
    fact.citationIds.forEach((citationId, citationIndex) => {
      if (!citations.has(citationId)) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'citationIds', citationIndex],
          message: 'Fact citation ID must resolve in the bundle'
        });
      }
    });
  });
}

function ensureContextMatchCitations(
  matches: ReadonlyArray<{ citationIds: string[] }>,
  path: 'trustedMatches' | 'ephemeralMatches',
  trust: z.infer<typeof knowledgeTrustSchema>,
  citations: ReadonlyMap<string, z.infer<typeof citationSchema>>,
  context: z.RefinementCtx
): void {
  matches.forEach((match, matchIndex) => {
    match.citationIds.forEach((citationId, citationIndex) => {
      const citation = citations.get(citationId);
      if (citation === undefined) {
        context.addIssue({
          code: 'custom',
          path: [path, matchIndex, 'citationIds', citationIndex],
          message: 'Citation ID must resolve in the knowledge context packet'
        });
      } else if (citation.trust !== trust) {
        context.addIssue({
          code: 'custom',
          path: [path, matchIndex, 'citationIds', citationIndex],
          message: `${path} may only reference ${trust} citations`
        });
      }
    });
  });
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export type KnowledgeTrust = z.infer<typeof knowledgeTrustSchema>;
export type SourceRegistryEntry = z.infer<typeof sourceRegistryEntrySchema>;
export type SourceCitation = z.infer<typeof sourceCitationSchema>;
export type SourceRegistry = z.infer<typeof sourceRegistrySchema>;
export type CharacterCatalogEntry = z.infer<typeof characterCatalogEntrySchema>;
export type CharacterCatalog = z.infer<typeof characterCatalogSchema>;
export type SignalPredicate = z.infer<typeof signalPredicateSchema>;
export type StrategyFact = z.infer<typeof strategyFactSchema>;
export type BuildArchetype = z.infer<typeof buildArchetypeSchema>;
export type CharacterStrategy = z.infer<typeof characterStrategySchema>;
export type CharacterStrategyBundle = z.infer<typeof characterStrategyBundleSchema>;
export type EnemyMechanicStrategy = z.infer<typeof enemyMechanicStrategySchema>;
export type EnemyMechanicStrategyBundle = z.infer<typeof enemyMechanicStrategyBundleSchema>;
export type BuildInterpretation = z.infer<typeof buildInterpretationSchema>;
export type TrustedKnowledgeMatch = z.infer<typeof trustedKnowledgeMatchSchema>;
export type EphemeralGuideMatch = z.infer<typeof ephemeralGuideMatchSchema>;
export type KnowledgeGap = z.infer<typeof knowledgeGapSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type KnowledgeContextPacket = z.infer<typeof knowledgeContextPacketSchema>;
