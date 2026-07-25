import { z } from 'zod';

import { scenarioMechanicTagSchema } from './advisor-scenario-taxonomy.js';

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
const sha256Schema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/, 'SHA-256 must be 64 lowercase hexadecimal characters');

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

export const committedSourceCitationSchema = sourceCitationSchema
  .extend({
    subjectCharacterIds: z
      .array(canonicalCharacterIdSchema)
      .max(16)
      .refine((ids) => new Set(ids).size === ids.length, 'Subject character IDs must be unique'),
    subjectMechanicIds: z
      .array(boundedIdSchema)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length, 'Subject mechanic IDs must be unique')
      .optional(),
    retrievedAt: reviewedAtSchema,
    reviewEvidenceVersion: z.literal('paraphrased-evidence-v1'),
    reviewEvidenceSha256: sha256Schema
  })
  .strict()
  .refine(
    ({ subjectCharacterIds, subjectMechanicIds }) =>
      subjectCharacterIds.length > 0 || (subjectMechanicIds?.length ?? 0) > 0,
    'A committed citation must declare a character or mechanic subject'
  );

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

export const committedSourceRegistryEntrySchema = z
  .object({
    id: boundedIdSchema,
    displayName: boundedNameSchema,
    host: declaredHostSchema,
    trust: z.literal('trusted-local'),
    reviewCadenceDays: z.number().int().min(1).max(3_650)
  })
  .strict();

export const committedSourceRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceVersion: z.string().trim().min(1).max(128),
    sources: z.array(committedSourceRegistryEntrySchema).min(1).max(128),
    citations: z.array(committedSourceCitationSchema).min(1).max(512)
  })
  .strict()
  .superRefine(({ sources, citations }, context) => {
    addDuplicateIdIssues(sources, ['sources'], context);
    addDuplicateIdIssues(citations, ['citations'], context);

    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const hosts = new Set<string>();
    sources.forEach(({ host }, index) => {
      if (hosts.has(host)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'host'],
          message: 'Source hosts must be unique'
        });
      }
      hosts.add(host);
    });

    citations.forEach((citation, index) => {
      const source = sourcesById.get(citation.sourceId);
      if (source === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['citations', index, 'sourceId'],
          message: 'Citation sourceId must resolve in the committed source registry'
        });
        return;
      }
      const citationUrl = parseUrl(citation.url);
      if (citationUrl === undefined || citationUrl.hostname.toLowerCase() !== source.host) {
        context.addIssue({
          code: 'custom',
          path: ['citations', index, 'url'],
          message: 'Citation URL must use the exact registered source host'
        });
      }
      if (citation.trust !== source.trust) {
        context.addIssue({
          code: 'custom',
          path: ['citations', index, 'trust'],
          message: 'Citation trust must match its committed source'
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

export const characterCatalogProvenanceSchema = z
  .object({
    id: boundedIdSchema,
    url: httpsUrlSchema,
    retrievedAt: reviewedAtSchema,
    sha256: sha256Schema
  })
  .strict();

export const committedCharacterCatalogEntrySchema = z
  .object({
    id: canonicalCharacterIdSchema,
    name: boundedNameSchema,
    aliases: z
      .array(z.string().trim().min(1).max(120))
      .max(16)
      .refine((aliases) => new Set(aliases).size === aliases.length, 'Aliases must be unique'),
    element: z.enum(['anemo', 'geo', 'electro', 'dendro', 'hydro', 'pyro', 'cryo', 'unknown']),
    weaponType: z.enum(['sword', 'claymore', 'polearm', 'bow', 'catalyst', 'unknown'])
  })
  .strict();

const characterCatalogExclusionCommonShape = {
  id: canonicalCharacterIdSchema,
  name: boundedNameSchema,
  reason: z.string().trim().min(1).max(500)
};

const characterCatalogAlternateExclusionSchema = z
  .object({
    ...characterCatalogExclusionCommonShape,
    kind: z.literal('alternate-variant'),
    canonicalId: canonicalCharacterIdSchema
  })
  .strict();

const characterCatalogStandaloneExclusionSchema = (
  kind: 'trial-variant' | 'test-variant' | 'provisional'
) =>
  z
    .object({
      ...characterCatalogExclusionCommonShape,
      kind: z.literal(kind)
    })
    .strict();

export const characterCatalogExclusionSchema = z.discriminatedUnion('kind', [
  characterCatalogAlternateExclusionSchema,
  characterCatalogStandaloneExclusionSchema('trial-variant'),
  characterCatalogStandaloneExclusionSchema('test-variant'),
  characterCatalogStandaloneExclusionSchema('provisional')
]);

export const committedCharacterCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogVersion: z.string().trim().min(1).max(128),
    retrievedAt: reviewedAtSchema,
    provenance: z.array(characterCatalogProvenanceSchema).length(3),
    exclusions: z.array(characterCatalogExclusionSchema).max(64),
    characters: z.array(committedCharacterCatalogEntrySchema).length(112)
  })
  .strict()
  .superRefine(({ provenance, exclusions, characters }, context) => {
    addDuplicateIdIssues(provenance, ['provenance'], context);
    addDuplicateIdIssues(exclusions, ['exclusions'], context);
    addDuplicateIdIssues(characters, ['characters'], context);

    const characterIds = new Set(characters.map(({ id }) => id));
    exclusions.forEach((exclusion, index) => {
      const { id } = exclusion;
      if (characterIds.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['exclusions', index, 'id'],
          message: 'Excluded upstream IDs cannot also appear in the canonical catalog'
        });
      }
      if (exclusion.kind === 'alternate-variant' && !characterIds.has(exclusion.canonicalId)) {
        context.addIssue({
          code: 'custom',
          path: ['exclusions', index, 'canonicalId'],
          message: 'Alternate exclusions must resolve to a character in the canonical catalog'
        });
      }
    });
  });

const signalPredicateCommonShape = {
  id: boundedIdSchema,
  description: z.string().trim().min(1).max(240),
  required: z.boolean(),
  weight: z.number().int().min(1).max(5)
};

export const artifactMainStatKeySchema = z.enum([
  'hpPct',
  'atkPct',
  'defPct',
  'elementalMastery',
  'energyRecharge',
  'critRate',
  'critDmg',
  'healingBonus',
  'pyroDmg',
  'hydroDmg',
  'electroDmg',
  'cryoDmg',
  'anemoDmg',
  'geoDmg',
  'dendroDmg',
  'physicalDmg'
]);

export type ArtifactMainStatKey = z.infer<typeof artifactMainStatKeySchema>;

const artifactMainStatSignalPredicateSchema = z
  .object({
    ...signalPredicateCommonShape,
    field: z.enum(['sandsMainStat', 'gobletMainStat', 'circletMainStat']),
    operator: z.literal('eq'),
    value: artifactMainStatKeySchema
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
  artifactMainStatSignalPredicateSchema,
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

const committedUnknownSchema = z
  .object({
    id: boundedIdSchema,
    description: z.string().trim().min(1).max(500)
  })
  .strict();

const committedTeammateSlotSchema = z
  .object({
    id: boundedIdSchema,
    label: boundedNameSchema,
    requirements: z
      .array(z.string().trim().min(1).max(240))
      .min(1)
      .max(12)
      .refine((requirements) => new Set(requirements).size === requirements.length),
    optional: z.boolean()
  })
  .strict();

const committedRoleSchema = z.enum([
  'on-field',
  'off-field',
  'driver',
  'trigger',
  'support',
  'sustain',
  'healer',
  'unclassified'
]);

const committedReviewedRoleSchema = z.enum([
  'on-field',
  'off-field',
  'driver',
  'trigger',
  'support',
  'sustain',
  'healer'
]);

const committedReviewedArchetypeV2Schema = z
  .object({
    id: boundedIdSchema,
    name: boundedNameSchema,
    role: committedReviewedRoleSchema,
    coverage: z.literal('reviewed'),
    environments: z
      .array(z.enum(['general', 'overworld', 'spiral-abyss', 'imaginarium-theater']))
      .min(1)
      .max(4)
      .refine((environments) => new Set(environments).size === environments.length),
    teammateSlots: z.array(committedTeammateSlotSchema).min(1).max(4),
    signals: z.array(signalPredicateSchema).min(1).max(24),
    requiredMode: z.literal('all'),
    minimumSupportingWeight: z.number().int().min(0).max(120),
    facts: z.array(strategyFactSchema).min(1).max(32),
    unknowns: z.array(committedUnknownSchema).max(16)
  })
  .strict()
  .superRefine(({ signals, minimumSupportingWeight }, context) => {
    if (signals.every(({ required }) => !required) && minimumSupportingWeight === 0) {
      context.addIssue({
        code: 'custom',
        path: ['minimumSupportingWeight'],
        message: 'An optional-only signal policy must require positive supporting weight'
      });
    }
    const availableSupportingWeight = signals
      .filter(({ required }) => !required)
      .reduce((total, { weight }) => total + weight, 0);
    if (minimumSupportingWeight > availableSupportingWeight) {
      context.addIssue({
        code: 'custom',
        path: ['minimumSupportingWeight'],
        message: 'Minimum supporting weight cannot exceed the available supporting signal weight'
      });
    }
  });

const committedGapArchetypeV2Schema = z
  .object({
    id: boundedIdSchema,
    name: boundedNameSchema,
    role: z.literal('unclassified'),
    coverage: z.literal('gap'),
    environments: z.array(z.never()).length(0),
    teammateSlots: z.array(z.never()).length(0),
    signals: z.array(z.never()).length(0),
    facts: z.array(z.never()).length(0),
    unknowns: z.array(committedUnknownSchema).min(1).max(16)
  })
  .strict();

export const committedBuildArchetypeV2Schema = z
  .discriminatedUnion('coverage', [
    committedReviewedArchetypeV2Schema,
    committedGapArchetypeV2Schema
  ])
  .superRefine(({ teammateSlots, signals, facts, unknowns }, context) => {
    addDuplicateIdIssues(teammateSlots, ['teammateSlots'], context);
    addDuplicateIdIssues(signals, ['signals'], context);
    addDuplicateIdIssues(facts, ['facts'], context);
    addDuplicateIdIssues(unknowns, ['unknowns'], context);
  });

export const committedCharacterStrategyV2Schema = z
  .object({
    id: canonicalCharacterIdSchema,
    name: boundedNameSchema,
    reviewState: z.enum(['reviewed', 'unreviewed']),
    baseRoles: z
      .array(committedRoleSchema)
      .min(1)
      .max(8)
      .refine((roles) => new Set(roles).size === roles.length, 'Base roles must be unique'),
    archetypes: z.array(committedBuildArchetypeV2Schema).min(1).max(16),
    unknowns: z.array(committedUnknownSchema).max(16)
  })
  .strict()
  .superRefine(({ reviewState, baseRoles, archetypes, unknowns }, context) => {
    addDuplicateIdIssues(archetypes, ['archetypes'], context);
    addDuplicateIdIssues(unknowns, ['unknowns'], context);

    if (
      reviewState === 'unreviewed' &&
      (baseRoles.length !== 1 || baseRoles[0] !== 'unclassified')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['baseRoles'],
        message: 'Unreviewed characters must remain unclassified'
      });
    }
    if (reviewState === 'reviewed' && baseRoles.includes('unclassified')) {
      context.addIssue({
        code: 'custom',
        path: ['baseRoles'],
        message: 'Reviewed characters must declare concrete base roles'
      });
    }
    if (
      (reviewState === 'reviewed' && archetypes.some(({ coverage }) => coverage !== 'reviewed')) ||
      (reviewState === 'unreviewed' && archetypes.some(({ coverage }) => coverage !== 'gap'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['archetypes'],
        message: 'Archetype coverage must match character review state'
      });
    }
  });

export const committedCharacterStrategyBundleV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    knowledgeVersion: z.string().trim().min(1).max(128),
    sourceVersion: z.string().trim().min(1).max(128),
    catalogVersion: z.string().trim().min(1).max(128),
    reviewedAt: reviewedAtSchema,
    trust: z.literal('trusted-local'),
    characters: z.array(committedCharacterStrategyV2Schema).length(112)
  })
  .strict()
  .superRefine(({ characters }, context) => {
    addDuplicateIdIssues(characters, ['characters'], context);
    addDuplicateArchetypeIdIssues(characters, context);
    const factIds = new Set<string>();
    characters.forEach(({ archetypes }, characterIndex) => {
      archetypes.forEach(({ facts }, archetypeIndex) => {
        facts.forEach(({ id }, factIndex) => {
          if (factIds.has(id)) {
            context.addIssue({
              code: 'custom',
              path: [
                'characters',
                characterIndex,
                'archetypes',
                archetypeIndex,
                'facts',
                factIndex,
                'id'
              ],
              message: 'Committed strategy fact IDs must be globally unique'
            });
          }
          factIds.add(id);
        });
      });
    });
  });

const reviewEvidenceItemSchema = z
  .object({
    id: boundedIdSchema,
    summary: boundedFactSchema,
    factBindings: z
      .array(
        z
          .object({
            factId: boundedIdSchema,
            statementSha256: sha256Schema
          })
          .strict()
      )
      .min(1)
      .max(32)
      .refine(
        (bindings) => new Set(bindings.map(({ factId }) => factId)).size === bindings.length,
        'Evidence fact bindings must use unique fact IDs'
      )
  })
  .strict();

const reviewEvidenceArchetypeBindingSchema = z
  .object({
    archetypeId: boundedIdSchema,
    policySha256: sha256Schema
  })
  .strict();

export const reviewEvidenceEntrySchema = z
  .object({
    citationId: boundedIdSchema,
    subjectCharacterIds: z
      .array(canonicalCharacterIdSchema)
      .max(16)
      .refine((ids) => new Set(ids).size === ids.length, 'Subject character IDs must be unique'),
    subjectMechanicIds: z
      .array(boundedIdSchema)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length, 'Subject mechanic IDs must be unique')
      .optional(),
    url: httpsUrlSchema,
    reviewedAt: reviewedAtSchema,
    sectionLabels: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(16)
      .refine((labels) => new Set(labels).size === labels.length, 'Section labels must be unique'),
    archetypeBindings: z
      .array(reviewEvidenceArchetypeBindingSchema)
      .max(16)
      .refine(
        (bindings) =>
          new Set(bindings.map(({ archetypeId }) => archetypeId)).size === bindings.length,
        'Evidence archetype bindings must use unique archetype IDs'
      ),
    mechanicBindings: z
      .array(
        z
          .object({
            mechanicId: boundedIdSchema,
            policySha256: sha256Schema
          })
          .strict()
      )
      .max(32)
      .refine(
        (bindings) =>
          new Set(bindings.map(({ mechanicId }) => mechanicId)).size === bindings.length,
        'Evidence mechanic bindings must use unique mechanic IDs'
      )
      .optional(),
    paraphrasedEvidence: z.array(reviewEvidenceItemSchema).min(1).max(32)
  })
  .strict()
  .superRefine(
    (
      {
        subjectCharacterIds,
        subjectMechanicIds,
        archetypeBindings,
        mechanicBindings,
        paraphrasedEvidence
      },
      context
    ) => {
      if (subjectCharacterIds.length === 0 && (subjectMechanicIds?.length ?? 0) === 0) {
        context.addIssue({
          code: 'custom',
          path: ['subjectCharacterIds'],
          message: 'Review evidence must declare a character or mechanic subject'
        });
      }
      if (archetypeBindings.length === 0 && (mechanicBindings?.length ?? 0) === 0) {
        context.addIssue({
          code: 'custom',
          path: ['archetypeBindings'],
          message: 'Review evidence must bind an archetype or mechanic policy'
        });
      }
      addDuplicateIdIssues(paraphrasedEvidence, ['paraphrasedEvidence'], context);
    }
  );

export const committedReviewEvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewEvidenceVersion: z.literal('paraphrased-evidence-v1'),
    sourceRegistrySha256: sha256Schema,
    entries: z.array(reviewEvidenceEntrySchema).min(1).max(512)
  })
  .strict()
  .superRefine(({ entries }, context) => {
    addDuplicateIdIssues(
      entries.map((entry) => ({ id: entry.citationId })),
      ['entries'],
      context,
      'Evidence citation IDs must be unique'
    );
  });

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function canonicalJsonStringify(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonStringify(
          (value as Record<string, CanonicalJsonValue>)[key]!
        )}`
    )
    .join(',')}}`;
}

export const committedAdvisorKnowledgeSetStructureSchema = z
  .object({
    sources: committedSourceRegistrySchema,
    catalog: committedCharacterCatalogSchema,
    strategies: committedCharacterStrategyBundleV2Schema,
    mechanics: z.lazy(() => enemyMechanicStrategyBundleSchema),
    evidence: committedReviewEvidenceBundleSchema
  })
  .strict()
  .superRefine(({ sources, catalog, strategies, mechanics, evidence }, context) => {
    if (strategies.sourceVersion !== sources.sourceVersion) {
      context.addIssue({
        code: 'custom',
        path: ['strategies', 'sourceVersion'],
        message: 'Strategy sourceVersion must match the committed source registry'
      });
    }
    if (strategies.catalogVersion !== catalog.catalogVersion) {
      context.addIssue({
        code: 'custom',
        path: ['strategies', 'catalogVersion'],
        message: 'Strategy catalogVersion must match the committed character catalog'
      });
    }
    if (mechanics.sourceVersion !== sources.sourceVersion) {
      context.addIssue({
        code: 'custom',
        path: ['mechanics', 'sourceVersion'],
        message: 'Mechanic sourceVersion must match the committed source registry'
      });
    }
    if (mechanics.knowledgeVersion !== strategies.knowledgeVersion) {
      context.addIssue({
        code: 'custom',
        path: ['mechanics', 'knowledgeVersion'],
        message: 'Mechanic knowledgeVersion must match character strategies'
      });
    }

    const catalogById = new Map(catalog.characters.map((character) => [character.id, character]));
    const strategiesById = new Map(
      strategies.characters.map((character) => [character.id, character])
    );
    catalog.characters.forEach(({ id }, index) => {
      if (!strategiesById.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['catalog', 'characters', index, 'id'],
          message: 'Every catalog character must have one strategy index entry'
        });
      }
    });
    strategies.characters.forEach(({ id, name }, characterIndex) => {
      const catalogCharacter = catalogById.get(id);
      if (catalogCharacter === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['strategies', 'characters', characterIndex, 'id'],
          message: 'Every strategy index entry must resolve to the catalog'
        });
      } else if (catalogCharacter.name !== name) {
        context.addIssue({
          code: 'custom',
          path: ['strategies', 'characters', characterIndex, 'name'],
          message: 'Strategy character names must match the canonical catalog'
        });
      }
    });

    const citationsById = new Map(sources.citations.map((citation) => [citation.id, citation]));
    const evidenceByCitationId = new Map(
      evidence.entries.map((entry) => [entry.citationId, entry])
    );
    sources.citations.forEach((citation, citationIndex) => {
      const entry = evidenceByCitationId.get(citation.id);
      if (entry === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', 'entries'],
          message: `Committed citation ${citation.id} must have one review evidence entry`
        });
        return;
      }
      if (citation.reviewEvidenceVersion !== evidence.reviewEvidenceVersion) {
        context.addIssue({
          code: 'custom',
          path: ['sources', 'citations', citationIndex, 'reviewEvidenceVersion'],
          message: 'Citation review evidence version must match the evidence bundle'
        });
      }
      if (
        entry.url !== citation.url ||
        entry.reviewedAt !== citation.reviewedAt ||
        !sameStringSet(entry.subjectCharacterIds, citation.subjectCharacterIds) ||
        !sameStringSet(entry.subjectMechanicIds ?? [], citation.subjectMechanicIds ?? [])
      ) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', 'entries', evidence.entries.indexOf(entry)],
          message: 'Review evidence identity must match its committed citation'
        });
      }
    });
    evidence.entries.forEach(({ citationId }, evidenceIndex) => {
      if (!citationsById.has(citationId)) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', 'entries', evidenceIndex, 'citationId'],
          message: 'Review evidence citationId must resolve in the committed source registry'
        });
      }
    });

    const factsById = new Map<
      string,
      Array<{ characterId: string; citationIds: string[]; factPath: Array<string | number> }>
    >();
    const mechanicFactsById = new Map<
      string,
      Array<{ mechanicId: string; citationIds: string[]; factPath: Array<string | number> }>
    >();
    strategies.characters.forEach(({ id: characterId, archetypes }, characterIndex) => {
      archetypes.forEach(({ facts }, archetypeIndex) => {
        facts.forEach(({ id: factId, citationIds: factCitationIds }, factIndex) => {
          const factPath = [
            'strategies',
            'characters',
            characterIndex,
            'archetypes',
            archetypeIndex,
            'facts',
            factIndex
          ];
          const owners = factsById.get(factId) ?? [];
          owners.push({ characterId, citationIds: factCitationIds, factPath });
          factsById.set(factId, owners);
          factCitationIds.forEach((citationId, citationIndex) => {
            const citation = citationsById.get(citationId);
            if (citation === undefined) {
              context.addIssue({
                code: 'custom',
                path: [
                  'strategies',
                  'characters',
                  characterIndex,
                  'archetypes',
                  archetypeIndex,
                  'facts',
                  factIndex,
                  'citationIds',
                  citationIndex
                ],
                message: 'Trusted strategy fact citation must resolve in the committed registry'
              });
            } else if (!citation.subjectCharacterIds.includes(characterId)) {
              context.addIssue({
                code: 'custom',
                path: [
                  'strategies',
                  'characters',
                  characterIndex,
                  'archetypes',
                  archetypeIndex,
                  'facts',
                  factIndex,
                  'citationIds',
                  citationIndex
                ],
                message:
                  'Trusted strategy fact citation must declare the fact character as a subject'
              });
            } else {
              const entry = evidenceByCitationId.get(citationId);
              const evidenceFactIds = new Set(
                entry?.paraphrasedEvidence.flatMap(({ factBindings }) =>
                  factBindings.map(({ factId }) => factId)
                ) ?? []
              );
              if (!evidenceFactIds.has(factId)) {
                context.addIssue({
                  code: 'custom',
                  path: [...factPath, 'citationIds', citationIndex],
                  message: 'Trusted strategy fact must be bound by its citation review evidence'
                });
              }
            }
          });
        });
      });
    });

    const committedSourcesById = new Map(sources.sources.map((source) => [source.id, source]));
    mechanics.sourceRegistry.sources.forEach((source, sourceIndex) => {
      const committedSource = committedSourcesById.get(source.id);
      if (
        committedSource === undefined ||
        source.name !== committedSource.displayName ||
        source.trust !== committedSource.trust ||
        !sameStringSet(source.hosts, [committedSource.host]) ||
        source.homepageUrl !== `https://${committedSource.host}/`
      ) {
        context.addIssue({
          code: 'custom',
          path: ['mechanics', 'sourceRegistry', 'sources', sourceIndex],
          message: 'Mechanic source must match the committed source registry'
        });
      }
    });
    const embeddedCitationsById = new Map(
      mechanics.sourceRegistry.citations.map((citation) => [citation.id, citation])
    );
    mechanics.sourceRegistry.citations.forEach((citation, citationIndex) => {
      const committedCitation = citationsById.get(citation.id);
      if (
        committedCitation === undefined ||
        committedCitation.sourceId !== citation.sourceId ||
        committedCitation.url !== citation.url ||
        committedCitation.title !== citation.title ||
        committedCitation.reviewedAt !== citation.reviewedAt ||
        committedCitation.trust !== citation.trust
      ) {
        context.addIssue({
          code: 'custom',
          path: ['mechanics', 'sourceRegistry', 'citations', citationIndex],
          message: 'Mechanic citation must match the committed source registry'
        });
      }
    });
    mechanics.mechanics.forEach(({ id: mechanicId, facts }, mechanicIndex) => {
      facts.forEach(({ id: factId, citationIds: factCitationIds }, factIndex) => {
        const factPath = ['mechanics', 'mechanics', mechanicIndex, 'facts', factIndex];
        const owners = mechanicFactsById.get(factId) ?? [];
        owners.push({ mechanicId, citationIds: factCitationIds, factPath });
        mechanicFactsById.set(factId, owners);
        factCitationIds.forEach((citationId, citationIndex) => {
          const embeddedCitation = embeddedCitationsById.get(citationId);
          const citation = citationsById.get(citationId);
          if (
            embeddedCitation === undefined ||
            citation === undefined ||
            !citation.subjectMechanicIds?.includes(mechanicId)
          ) {
            context.addIssue({
              code: 'custom',
              path: [...factPath, 'citationIds', citationIndex],
              message:
                'Trusted mechanic fact citation must resolve and declare the mechanic as a subject'
            });
          } else {
            const entry = evidenceByCitationId.get(citationId);
            const evidenceFactIds = new Set(
              entry?.paraphrasedEvidence.flatMap(({ factBindings }) =>
                factBindings.map(({ factId: boundFactId }) => boundFactId)
              ) ?? []
            );
            if (!evidenceFactIds.has(factId)) {
              context.addIssue({
                code: 'custom',
                path: [...factPath, 'citationIds', citationIndex],
                message: 'Trusted mechanic fact must be bound by its citation review evidence'
              });
            }
          }
        });
      });
    });

    evidence.entries.forEach((entry, evidenceIndex) => {
      entry.paraphrasedEvidence.forEach(({ factBindings }, itemIndex) => {
        factBindings.forEach(({ factId }, factIndex) => {
          const owners = factsById.get(factId) ?? [];
          const compatibleOwner = owners.find(
            ({ characterId, citationIds }) =>
              entry.subjectCharacterIds.includes(characterId) &&
              citationIds.includes(entry.citationId)
          );
          const compatibleMechanicOwner = (mechanicFactsById.get(factId) ?? []).find(
            ({ mechanicId, citationIds }) =>
              (entry.subjectMechanicIds ?? []).includes(mechanicId) &&
              citationIds.includes(entry.citationId)
          );
          if (compatibleOwner === undefined && compatibleMechanicOwner === undefined) {
            context.addIssue({
              code: 'custom',
              path: [
                'evidence',
                'entries',
                evidenceIndex,
                'paraphrasedEvidence',
                itemIndex,
                'factBindings',
                factIndex
              ],
              message: 'Review evidence fact ID must resolve to its citation subject and fact'
            });
          }
        });
      });
    });
  });

export const enemyMechanicStrategySchema = z
  .object({
    id: boundedIdSchema,
    name: boundedNameSchema,
    matchTags: z
      .array(scenarioMechanicTagSchema)
      .min(1)
      .max(24)
      .refine((tags) => new Set(tags).size === tags.length, 'Match tags must be unique'),
    avoidTags: z
      .array(scenarioMechanicTagSchema)
      .max(24)
      .refine((tags) => new Set(tags).size === tags.length, 'Avoid tags must be unique'),
    requiredCapabilities: uniqueBoundedIdsSchema.min(1),
    preferredArchetypes: uniqueBoundedIdsSchema.min(1),
    teamSkeletonHints: z
      .array(
        z
          .object({
            id: boundedIdSchema,
            slots: uniqueBoundedIdsSchema.min(1).max(4)
          })
          .strict()
      )
      .min(1)
      .max(8),
    facts: z.array(strategyFactSchema).min(1).max(32)
  })
  .strict()
  .superRefine(({ matchTags, avoidTags, facts, teamSkeletonHints }, context) => {
    addDuplicateIdIssues(facts, ['facts'], context);
    addDuplicateIdIssues(teamSkeletonHints, ['teamSkeletonHints'], context);
    const matchTagSet = new Set(matchTags);
    avoidTags.forEach((tag, index) => {
      if (matchTagSet.has(tag)) {
        context.addIssue({
          code: 'custom',
          path: ['avoidTags', index],
          message: 'Mechanic match and avoid tags must be disjoint'
        });
      }
    });
  });

export const enemyMechanicStrategyBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    knowledgeVersion: z.string().trim().min(1).max(128),
    sourceVersion: z.string().trim().min(1).max(128),
    trust: z.literal('trusted-local'),
    sourceRegistrySha256: sha256Schema,
    sourceRegistry: sourceRegistrySchema,
    mechanics: z.array(enemyMechanicStrategySchema).max(256)
  })
  .strict()
  .superRefine(({ sourceRegistry, mechanics }, context) => {
    addDuplicateIdIssues(mechanics, ['mechanics'], context);
    const factIds = new Set<string>();
    mechanics.forEach(({ facts }, mechanicIndex) => {
      facts.forEach(({ id }, factIndex) => {
        if (factIds.has(id)) {
          context.addIssue({
            code: 'custom',
            path: ['mechanics', mechanicIndex, 'facts', factIndex, 'id'],
            message: 'Mechanic fact IDs must be globally unique'
          });
        }
        factIds.add(id);
      });
    });
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
    candidateArchetypeIds: z.array(z.string().trim().min(1).max(80)).max(16).default([]),
    contextRequired: z.boolean().default(false),
    matchedSignals: z.array(z.string().trim().min(1).max(160)).max(12),
    conflictingSignals: z.array(z.string().trim().min(1).max(160)).max(12),
    closestCandidate: z
      .object({
        archetypeId: boundedIdSchema,
        supportingWeight: z.number().int().min(0).max(120),
        minimumSupportingWeight: z.number().int().min(0).max(120),
        matchedSignals: z
          .array(
            z
              .object({
                id: boundedIdSchema,
                weight: z.number().int().min(1).max(5),
                required: z.boolean()
              })
              .strict()
          )
          .max(24),
        missingSignals: z
          .array(
            z
              .object({
                id: boundedIdSchema,
                weight: z.number().int().min(1).max(5),
                required: z.boolean()
              })
              .strict()
          )
          .max(24),
        conflictingSignals: z
          .array(
            z
              .object({
                id: boundedIdSchema,
                weight: z.number().int().min(1).max(5),
                required: z.boolean()
              })
              .strict()
          )
          .max(24)
      })
      .strict()
      .optional(),
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
    role: z
      .enum([
        'on-field',
        'off-field',
        'driver',
        'trigger',
        'support',
        'sustain',
        'healer'
      ])
      .optional(),
    summary: boundedSummarySchema,
    factStatements: z.array(boundedFactSchema).max(32).optional(),
    requiredCapabilities: uniqueBoundedIdsSchema.optional(),
    preferredArchetypes: uniqueBoundedIdsSchema.optional(),
    teamSkeletonHints: z
      .array(
        z
          .object({
            id: boundedIdSchema,
            slots: uniqueBoundedIdsSchema.min(1).max(4)
          })
          .strict()
      )
      .max(8)
      .optional(),
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
    kind: z
      .enum(['missing', 'stale', 'conflict', 'build-unmatched', 'payload-truncated'])
      .default('missing'),
    reason: z.string().trim().min(1).max(500)
  })
  .strict();

export const citationSchema = sourceCitationSchema;

const knowledgeGapsSchema = z
  .array(knowledgeGapSchema)
  .max(257)
  .superRefine((gaps, context) => {
    const payloadMarkers = gaps.filter(({ kind }) => kind === 'payload-truncated');
    const normalGaps = gaps.length - payloadMarkers.length;
    if (normalGaps > 256) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Knowledge packets support at most 256 non-truncation gaps'
      });
    }
    if (payloadMarkers.length > 1) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Knowledge packets support at most one payload truncation marker'
      });
    }
  });

const knowledgeCoverageSchema = z
  .object({
    requested: z.number().int().nonnegative().max(513),
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
    unknowns: knowledgeGapsSchema,
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

      const normalUnknownCount = unknowns.filter(({ kind }) => kind !== 'payload-truncated').length;
      const businessEntryCount =
        trustedMatches.length + ephemeralMatches.length + normalUnknownCount;
      if (businessEntryCount > 512) {
        context.addIssue({
          code: 'custom',
          path: ['coverage', 'requested'],
          message: 'Knowledge packets support at most 512 business entries'
        });
      }

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

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

export type KnowledgeTrust = z.infer<typeof knowledgeTrustSchema>;
export type SourceRegistryEntry = z.infer<typeof sourceRegistryEntrySchema>;
export type SourceCitation = z.infer<typeof sourceCitationSchema>;
export type SourceRegistry = z.infer<typeof sourceRegistrySchema>;
export type CommittedSourceRegistryEntry = z.infer<typeof committedSourceRegistryEntrySchema>;
export type CommittedSourceRegistry = z.infer<typeof committedSourceRegistrySchema>;
export type CharacterCatalogEntry = z.infer<typeof characterCatalogEntrySchema>;
export type CharacterCatalog = z.infer<typeof characterCatalogSchema>;
export type CharacterCatalogProvenance = z.infer<typeof characterCatalogProvenanceSchema>;
export type CharacterCatalogExclusion = z.infer<typeof characterCatalogExclusionSchema>;
export type CommittedCharacterCatalogEntry = z.infer<typeof committedCharacterCatalogEntrySchema>;
export type CommittedCharacterCatalog = z.infer<typeof committedCharacterCatalogSchema>;
export type SignalPredicate = z.infer<typeof signalPredicateSchema>;
export type StrategyFact = z.infer<typeof strategyFactSchema>;
export type BuildArchetype = z.infer<typeof buildArchetypeSchema>;
export type CharacterStrategy = z.infer<typeof characterStrategySchema>;
export type CharacterStrategyBundle = z.infer<typeof characterStrategyBundleSchema>;
export type CommittedBuildArchetypeV2 = z.infer<typeof committedBuildArchetypeV2Schema>;
export type CommittedCharacterStrategyV2 = z.infer<typeof committedCharacterStrategyV2Schema>;
export type CommittedCharacterStrategyBundleV2 = z.infer<
  typeof committedCharacterStrategyBundleV2Schema
>;
export type CommittedAdvisorKnowledgeSet = z.infer<
  typeof committedAdvisorKnowledgeSetStructureSchema
>;
export type CharacterStrategyResult =
  | {
      status: 'reviewed';
      characterId: string;
      knowledgeVersion: string;
      strategy: CommittedCharacterStrategyV2;
    }
  | {
      status: 'gap';
      characterId: string;
      knowledgeVersion: string;
      strategy: CommittedCharacterStrategyV2;
    }
  | {
      status: 'unknown';
      characterId: string;
      knowledgeVersion: string;
    };
export interface AdvisorKnowledgeCoverage {
  knowledgeVersion: string;
  catalogVersion: string;
  requestedCharacterIds: string[];
  trustedCharacterIds: string[];
  unknownCharacterIds: string[];
}
export interface AdvisorKnowledgeReader {
  readonly version: string;
  readonly catalogVersion: string;
  getCatalogEntry(characterId: string): CommittedCharacterCatalogEntry | undefined;
  getCharacterStrategy(characterId: string): CharacterStrategyResult;
  getArchetype(characterId: string, archetypeId: string): CommittedBuildArchetypeV2 | undefined;
  citations(ids: readonly string[]): CommittedSourceRegistry['citations'][number][];
  coverageFor(input: { characterIds: readonly string[]; now: Date }): AdvisorKnowledgeCoverage;
}
export type EnemyMechanicStrategy = z.infer<typeof enemyMechanicStrategySchema>;
export type EnemyMechanicStrategyBundle = z.infer<typeof enemyMechanicStrategyBundleSchema>;
export type BuildInterpretation = z.infer<typeof buildInterpretationSchema>;
export type TrustedKnowledgeMatch = z.infer<typeof trustedKnowledgeMatchSchema>;
export type EphemeralGuideMatch = z.infer<typeof ephemeralGuideMatchSchema>;
export type KnowledgeGap = z.infer<typeof knowledgeGapSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type KnowledgeContextPacket = z.infer<typeof knowledgeContextPacketSchema>;
