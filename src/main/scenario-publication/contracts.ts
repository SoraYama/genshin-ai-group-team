import { z } from 'zod';

import {
  scenarioPublicationEnvelopeSchema,
  type ScenarioPublicationEnvelope,
  type ScenarioV2
} from '../../shared/scenario-v2.js';

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const nonEmptyIdSchema = z.string().trim().min(1);
const scenarioModeSchema = z.enum(['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater']);
const relativePublicationPathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9._/-]+\.json$/)
  .refine((value) => !value.startsWith('/') && !value.includes('\\'), 'Path must be relative')
  .refine(
    (value) => !value.split('/').some((segment) => segment === '..' || segment.length === 0),
    'Path traversal is forbidden'
  );

export const scenarioPublicationDescriptorSchema = z
  .object({
    mode: scenarioModeSchema,
    schemaVersion: z.number().int().positive(),
    scenarioId: nonEmptyIdSchema,
    dataVersion: nonEmptyIdSchema,
    payloadPath: relativePublicationPathSchema,
    integrityPath: relativePublicationPathSchema,
    channel: z.enum(['production', 'development-sample'])
  })
  .strict();

const modePublicationIndexSchema = z
  .object({
    current: scenarioPublicationDescriptorSchema.optional(),
    history: z.array(scenarioPublicationDescriptorSchema)
  })
  .strict();

export const scenarioPublicationManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    publishedAt: isoDateTimeSchema,
    modes: z
      .object({
        'spiral-abyss': modePublicationIndexSchema,
        'stygian-onslaught': modePublicationIndexSchema,
        'imaginarium-theater': modePublicationIndexSchema
      })
      .strict()
  })
  .strict()
  .superRefine(({ modes }, context) => {
    Object.entries(modes).forEach(([mode, index]) => {
      const descriptors = [...index.history, ...(index.current ? [index.current] : [])];
      descriptors.forEach((descriptor, descriptorIndex) => {
        if (descriptor.mode !== mode) {
          context.addIssue({
            code: 'custom',
            message: `Descriptor mode must match index: ${mode}`,
            path: ['modes', mode, descriptorIndex < index.history.length ? 'history' : 'current']
          });
        }
      });
      const historyIds = index.history.map(
        ({ scenarioId, dataVersion }) => `${scenarioId}\u0000${dataVersion}`
      );
      if (new Set(historyIds).size !== historyIds.length) {
        context.addIssue({
          code: 'custom',
          message: `History entries must be unique for ${mode}`,
          path: ['modes', mode, 'history']
        });
      }
    });
  });

export const storedScenarioPublicationSchema = z
  .object({
    publication: scenarioPublicationEnvelopeSchema,
    savedAt: isoDateTimeSchema
  })
  .strict();

export type ScenarioModeV2 = ScenarioV2['mode'];
export type ScenarioPublicationDescriptor = z.infer<typeof scenarioPublicationDescriptorSchema>;
export type ScenarioPublicationManifest = z.infer<typeof scenarioPublicationManifestSchema>;
export type StoredScenarioPublication = z.infer<typeof storedScenarioPublicationSchema>;

export interface ScenarioPublicationReader {
  readManifest(): Promise<unknown>;
  readJson(publicationPath: string): Promise<unknown>;
}

export interface ScenarioPublicationStorage {
  load(mode: ScenarioModeV2): Promise<StoredScenarioPublication | undefined>;
  save(mode: ScenarioModeV2, value: StoredScenarioPublication): Promise<void>;
}

export interface ScenarioPublicationSnapshot {
  status: 'ready' | 'last-known-good' | 'unavailable';
  freshness: 'fresh' | 'expiring' | 'stale' | 'unknown';
  checkedAt: string;
  publication?: ScenarioPublicationEnvelope;
  refreshErrorCode?: import('./errors.js').ScenarioPublicationErrorCode;
}
