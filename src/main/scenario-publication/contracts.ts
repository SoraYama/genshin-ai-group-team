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

function descriptorFingerprint(
  descriptor: z.infer<typeof scenarioPublicationDescriptorSchema>
): string {
  return [
    descriptor.mode,
    descriptor.schemaVersion,
    descriptor.scenarioId,
    descriptor.dataVersion,
    descriptor.payloadPath,
    descriptor.integrityPath,
    descriptor.channel
  ].join('\u0000');
}

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
    const paths = new Map<string, string>();
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

      if (
        index.current &&
        !index.history.some(
          (descriptor) =>
            descriptorFingerprint(descriptor) === descriptorFingerprint(index.current!)
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: `Current descriptor must exactly match a history entry for ${mode}`,
          path: ['modes', mode, 'current']
        });
      }

      descriptors.forEach((descriptor, descriptorIndex) => {
        const fingerprint = descriptorFingerprint(descriptor);
        const descriptorPath =
          descriptorIndex < index.history.length
            ? ['modes', mode, 'history', descriptorIndex]
            : ['modes', mode, 'current'];
        if (descriptor.payloadPath === descriptor.integrityPath) {
          context.addIssue({
            code: 'custom',
            message: 'Payload and integrity paths must be different',
            path: descriptorPath
          });
        }
        for (const publicationPath of [descriptor.payloadPath, descriptor.integrityPath]) {
          const existing = paths.get(publicationPath);
          if (existing && existing !== fingerprint) {
            context.addIssue({
              code: 'custom',
              message: `Publication path is reused by another descriptor: ${publicationPath}`,
              path: descriptorPath
            });
          } else {
            paths.set(publicationPath, fingerprint);
          }
        }
      });
    });
  });

export const storedScenarioPublicationSchema = z
  .object({
    publication: scenarioPublicationEnvelopeSchema,
    savedAt: isoDateTimeSchema
  })
  .strict();

export type ScenarioModeV2 = ScenarioV2['mode'];
export type ScenarioPublicationUse = 'production' | 'development-sample';
export type ScenarioPublicationDescriptor = z.infer<typeof scenarioPublicationDescriptorSchema>;
export type ScenarioPublicationManifest = z.infer<typeof scenarioPublicationManifestSchema>;
export type StoredScenarioPublication = z.infer<typeof storedScenarioPublicationSchema>;

export interface ScenarioPublicationReader {
  readManifest(): Promise<unknown>;
  readJson(publicationPath: string): Promise<unknown>;
}

export interface ScenarioPublicationStorage {
  load(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse
  ): Promise<StoredScenarioPublication | undefined>;
  save(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse,
    value: StoredScenarioPublication
  ): Promise<void>;
}

export interface ScenarioPublicationSnapshot {
  status: 'ready' | 'last-known-good' | 'unavailable';
  trustedUse: ScenarioPublicationUse;
  freshness: 'fresh' | 'expiring' | 'stale' | 'unknown';
  checkedAt: string;
  publication?: ScenarioPublicationEnvelope;
  refreshErrorCode?: import('./errors.js').ScenarioPublicationErrorCode;
}
