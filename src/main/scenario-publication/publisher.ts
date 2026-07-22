import { createHash, type KeyLike, type KeyObject } from 'node:crypto';

import type { PublicationIntegrity, ScenarioV2 } from '../../shared/scenario-v2.js';
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

function publicationDirectory(mode: ScenarioModeV2, digestBase64: string): string {
  const digestHex = Buffer.from(digestBase64, 'base64').toString('hex');
  return `publications/${mode}/${digestHex}`;
}

export function scenarioPublicationPaths(
  payload: ScenarioV2,
  integrity: PublicationIntegrity
): { payloadPath: string; integrityPath: string } {
  const directory = publicationDirectory(payload.mode, integrity.hash.value);
  const keyDigest = createHash('sha256').update(integrity.signature.keyId).digest('hex');
  return {
    payloadPath: `${directory}/payload.json`,
    integrityPath: `${directory}/integrity-${keyDigest}.json`
  };
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
    return JSON.stringify([a.mode, a.id, a.meta.dataVersion]).localeCompare(
      JSON.stringify([b.mode, b.id, b.meta.dataVersion])
    );
  });

  for (const { candidate, publication } of publications) {
    const payload = publication.payload;
    const identity = JSON.stringify([payload.mode, payload.id, payload.meta.dataVersion]);
    if (identities.has(identity) || (candidate.current && currentModes.has(payload.mode))) {
      throw new ScenarioPublicationError('manifest-invalid');
    }
    identities.add(identity);
    if (candidate.current) currentModes.add(payload.mode);

    const publicationPaths = scenarioPublicationPaths(payload, publication.integrity);
    const descriptor: ScenarioPublicationDescriptor = {
      mode: payload.mode,
      schemaVersion: payload.meta.schemaVersion,
      scenarioId: payload.id,
      dataVersion: payload.meta.dataVersion,
      ...publicationPaths,
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
