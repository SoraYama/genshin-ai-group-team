import { createHash, type KeyLike, type KeyObject } from 'node:crypto';

import type { ScenarioV2 } from '../../shared/scenario-v2.js';
import {
  scenarioPublicationManifestSchema,
  type ScenarioModeV2,
  type ScenarioPublicationDescriptor,
  type ScenarioPublicationManifest
} from './contracts.js';
import { ScenarioPublicationError } from './errors.js';
import { createScenarioPublication } from './publication.js';

export interface ScenarioPublicationCandidate {
  payload: unknown;
  current: boolean;
  channel: 'production' | 'development-sample';
}

export interface ScenarioBundleSigningOptions {
  keyId: string;
  privateKey: KeyLike | KeyObject;
  publishedAt: string;
}

export interface ScenarioPublicationBundle {
  manifest: ScenarioPublicationManifest;
  documents: Record<string, unknown>;
}

function publicationDirectory(payload: ScenarioV2): string {
  const identity = `${payload.mode}\u0000${payload.id}\u0000${payload.meta.dataVersion}`;
  return `publications/${payload.mode}/${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

export function createScenarioPublicationBundle(
  candidates: ScenarioPublicationCandidate[],
  options: ScenarioBundleSigningOptions
): ScenarioPublicationBundle {
  if (candidates.some(({ channel }) => channel !== 'production')) {
    throw new ScenarioPublicationError('channel-mismatch');
  }
  const manifest: ScenarioPublicationManifest = {
    manifestVersion: 1,
    publishedAt: options.publishedAt,
    modes: {
      'spiral-abyss': { current: undefined, history: [] },
      'stygian-onslaught': { current: undefined, history: [] },
      'imaginarium-theater': { current: undefined, history: [] }
    }
  };
  const documents: Record<string, unknown> = {};
  const identities = new Set<string>();
  const currentModes = new Set<ScenarioModeV2>();

  const publications = candidates.map((candidate) => ({
    candidate,
    publication: createScenarioPublication(candidate.payload, options)
  }));
  publications.sort((left, right) => {
    const a = left.publication.payload;
    const b = right.publication.payload;
    return `${a.mode}\u0000${a.id}\u0000${a.meta.dataVersion}`.localeCompare(
      `${b.mode}\u0000${b.id}\u0000${b.meta.dataVersion}`
    );
  });

  for (const { candidate, publication } of publications) {
    const payload = publication.payload;
    const identity = `${payload.mode}\u0000${payload.id}\u0000${payload.meta.dataVersion}`;
    if (identities.has(identity) || (candidate.current && currentModes.has(payload.mode))) {
      throw new ScenarioPublicationError('manifest-invalid');
    }
    identities.add(identity);
    if (candidate.current) currentModes.add(payload.mode);

    const directory = publicationDirectory(payload);
    const descriptor: ScenarioPublicationDescriptor = {
      mode: payload.mode,
      schemaVersion: payload.meta.schemaVersion,
      scenarioId: payload.id,
      dataVersion: payload.meta.dataVersion,
      payloadPath: `${directory}/payload.json`,
      integrityPath: `${directory}/integrity.json`,
      channel: 'production'
    };
    manifest.modes[payload.mode].history.push(descriptor);
    if (candidate.current) manifest.modes[payload.mode].current = descriptor;
    documents[descriptor.payloadPath] = payload;
    documents[descriptor.integrityPath] = publication.integrity;
  }

  const manifestResult = scenarioPublicationManifestSchema.safeParse(manifest);
  if (!manifestResult.success) {
    throw new ScenarioPublicationError('manifest-invalid', { cause: manifestResult.error });
  }
  return { manifest: manifestResult.data, documents };
}
