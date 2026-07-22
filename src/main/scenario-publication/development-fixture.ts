import { z } from 'zod';

import {
  imaginariumTheaterScenarioSchema,
  publishedScenarioFieldPathSchema,
  spiralAbyssScenarioSchema,
  stygianOnslaughtScenarioSchema
} from '../../shared/scenario-v2.js';

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const developmentNoticeSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (notice) => notice.includes('NOT CURRENT LIVE-SERVICE DATA'),
    'Development fixtures must explicitly deny current live-service status'
  );

const syntheticProvenanceSchema = z
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
  .strict();

const developmentMetadataSchema = z
  .object({
    schemaVersion: z.literal(2),
    dataVersion: z.string().trim().min(1),
    effectiveFrom: isoDateTimeSchema,
    effectiveTo: isoDateTimeSchema.optional(),
    reviewedAt: isoDateTimeSchema,
    reviewedBy: z.string().trim().min(1),
    syntheticProvenance: syntheticProvenanceSchema
  })
  .strict()
  .refine(
    ({ effectiveFrom, effectiveTo }) =>
      effectiveTo === undefined || Date.parse(effectiveTo) >= Date.parse(effectiveFrom),
    { message: 'effectiveTo must be greater than or equal to effectiveFrom', path: ['effectiveTo'] }
  );

const spiralDevelopmentScenarioSchema = z
  .object({
    mode: spiralAbyssScenarioSchema.shape.mode,
    id: spiralAbyssScenarioSchema.shape.id,
    blessing: spiralAbyssScenarioSchema.shape.blessing,
    floors: spiralAbyssScenarioSchema.shape.floors
  })
  .strict();

const stygianDevelopmentScenarioSchema = z
  .object({
    mode: stygianOnslaughtScenarioSchema.shape.mode,
    id: stygianOnslaughtScenarioSchema.shape.id,
    crossPartyReusePolicy: stygianOnslaughtScenarioSchema.shape.crossPartyReusePolicy,
    difficulties: stygianOnslaughtScenarioSchema.shape.difficulties,
    phases: stygianOnslaughtScenarioSchema.shape.phases
  })
  .strict();

const theaterDevelopmentScenarioSchema = z
  .object({
    mode: imaginariumTheaterScenarioSchema.shape.mode,
    id: imaginariumTheaterScenarioSchema.shape.id,
    eligibility: imaginariumTheaterScenarioSchema.shape.eligibility,
    pools: imaginariumTheaterScenarioSchema.shape.pools,
    vigor: imaginariumTheaterScenarioSchema.shape.vigor,
    acts: imaginariumTheaterScenarioSchema.shape.acts,
    arcanaNodes: imaginariumTheaterScenarioSchema.shape.arcanaNodes
  })
  .strict();

const requiredPaths = {
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

function developmentFixtureFor<T extends z.ZodType>(mode: keyof typeof requiredPaths, scenario: T) {
  return z
    .object({
      fixtureKind: z.literal('development-only'),
      notice: developmentNoticeSchema,
      meta: developmentMetadataSchema,
      scenario
    })
    .strict()
    .superRefine(({ meta }, context) => {
      const actual = meta.syntheticProvenance.fields.map(({ fieldPath }) => fieldPath);
      const expected = requiredPaths[mode];
      if (
        new Set(actual).size !== actual.length ||
        actual.length !== expected.length ||
        expected.some((fieldPath) => !actual.includes(fieldPath))
      ) {
        context.addIssue({
          code: 'custom',
          message: `Synthetic provenance must exactly cover ${mode}`,
          path: ['meta', 'syntheticProvenance', 'fields']
        });
      }
    });
}

export const developmentScenarioFixtureSchema = z.union([
  developmentFixtureFor('spiral-abyss', spiralDevelopmentScenarioSchema),
  developmentFixtureFor('stygian-onslaught', stygianDevelopmentScenarioSchema),
  developmentFixtureFor('imaginarium-theater', theaterDevelopmentScenarioSchema)
]);

const fixturePathSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]+\.json$/)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((segment) => segment === '..' || segment.length === 0),
    'Fixture path must stay below its index root'
  );

const fixtureModeIndexSchema = z
  .object({
    current: fixturePathSchema,
    history: z.array(fixturePathSchema).min(1)
  })
  .strict()
  .refine(({ current, history }) => history.includes(current), {
    message: 'Current fixture must also appear in history',
    path: ['history']
  });

export const developmentFixtureIndexSchema = z
  .object({
    fixtureIndexVersion: z.literal(1),
    fixtureKind: z.literal('development-only'),
    notice: developmentNoticeSchema,
    modes: z
      .object({
        'spiral-abyss': fixtureModeIndexSchema,
        'stygian-onslaught': fixtureModeIndexSchema,
        'imaginarium-theater': fixtureModeIndexSchema
      })
      .strict()
  })
  .strict();

export type DevelopmentScenarioFixture = z.infer<typeof developmentScenarioFixtureSchema>;
export type DevelopmentFixtureIndex = z.infer<typeof developmentFixtureIndexSchema>;
