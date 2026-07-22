import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createProductionScenarioPublicationSource,
  type ProductionScenarioPublicationSource
} from '../../../src/main/scenario-publication/production-composition.js';
import { createScenarioPublication } from '../../../src/main/scenario-publication/publication.js';
import type { ScenarioHttpRequest } from '../../../src/main/scenario-publication/readers.js';
import type { ScenarioPublicationManifest } from '../../../src/main/scenario-publication/contracts.js';
import { makeScenario } from './fixtures.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function manifestFor(
  payload: ReturnType<typeof makeScenario>,
  payloadPath: string,
  integrityPath: string
): ScenarioPublicationManifest {
  const descriptor = {
    mode: payload.mode,
    schemaVersion: payload.meta.schemaVersion,
    scenarioId: payload.id,
    dataVersion: payload.meta.dataVersion,
    payloadPath,
    integrityPath,
    channel: 'production' as const
  };
  return {
    manifestVersion: 1,
    publishedAt: '2026-07-23T00:00:00.000Z',
    modes: {
      'spiral-abyss': { current: descriptor, history: [descriptor] },
      'stygian-onslaught': { history: [] },
      'imaginarium-theater': { history: [] }
    }
  };
}

function jsonResponse(value: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: (async function* () {
      yield Buffer.from(JSON.stringify(value));
    })()
  };
}

async function configuredSource(options: {
  userDataDir: string;
  requestJson: ScenarioHttpRequest;
  publicKeyPem: string;
  now?: () => Date;
}): Promise<ProductionScenarioPublicationSource> {
  return createProductionScenarioPublicationSource({
    userDataDir: options.userDataDir,
    packagedConfigPath: path.join(options.userDataDir, 'absent-config.json'),
    env: {
      GTA_SCENARIO_MANIFEST_URL: 'https://scenario.example.test/manifest.json',
      GTA_SCENARIO_PUBLIC_KEYS_JSON: JSON.stringify({ release: options.publicKeyPem })
    },
    requestJson: options.requestJson,
    now: options.now ?? (() => new Date('2026-07-23T12:00:00.000Z'))
  });
}

describe('production scenario publication composition', () => {
  it('builds the verified HTTP + userData storage path from explicit production config', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'gta-production-scenario-'));
    temporaryDirectories.push(userDataDir);
    const keys = generateKeyPairSync('ed25519');
    const scenario = makeScenario('spiral-abyss', 'production', '2026.07.1');
    scenario.meta.effectiveFrom = '2026-07-01T00:00:00.000Z';
    scenario.meta.effectiveTo = '2026-08-01T00:00:00.000Z';
    const publication = createScenarioPublication(scenario, {
      keyId: 'release',
      privateKey: keys.privateKey
    });
    const payloadPath = 'publications/abyss/payload.json';
    const integrityPath = 'publications/abyss/integrity.json';
    const documents = new Map<string, unknown>([
      ['/manifest.json', manifestFor(publication.payload, payloadPath, integrityPath)],
      [`/${payloadPath}`, publication.payload],
      [`/${integrityPath}`, publication.integrity]
    ]);
    const requestJson: ScenarioHttpRequest = async (url) =>
      jsonResponse(documents.get(url.pathname), documents.has(url.pathname) ? 200 : 404);
    const source = await configuredSource({
      userDataDir,
      requestJson,
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    });

    expect(source.status).toBe('configured');
    if (source.status !== 'configured') throw new Error('Expected configured source');
    await expect(source.refresh('spiral-abyss')).resolves.toMatchObject({
      status: 'ready',
      trustedUse: 'production',
      freshness: 'fresh',
      publication: { payload: { id: scenario.id } }
    });
  });

  it('returns a verified last-known-good snapshot when the configured endpoint later returns 404', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'gta-production-lkg-'));
    temporaryDirectories.push(userDataDir);
    const keys = generateKeyPairSync('ed25519');
    const scenario = makeScenario('spiral-abyss', 'production', '2026.07.1');
    scenario.meta.effectiveFrom = '2026-07-01T00:00:00.000Z';
    scenario.meta.effectiveTo = '2026-08-01T00:00:00.000Z';
    const publication = createScenarioPublication(scenario, {
      keyId: 'release',
      privateKey: keys.privateKey
    });
    const payloadPath = 'publications/abyss/payload.json';
    const integrityPath = 'publications/abyss/integrity.json';
    let remoteAvailable = true;
    const documents = new Map<string, unknown>([
      ['/manifest.json', manifestFor(publication.payload, payloadPath, integrityPath)],
      [`/${payloadPath}`, publication.payload],
      [`/${integrityPath}`, publication.integrity]
    ]);
    const source = await configuredSource({
      userDataDir,
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      requestJson: async (url) =>
        remoteAvailable && documents.has(url.pathname)
          ? jsonResponse(documents.get(url.pathname))
          : jsonResponse({}, 404)
    });
    if (source.status !== 'configured') throw new Error('Expected configured source');

    await expect(source.refresh('spiral-abyss')).resolves.toMatchObject({ status: 'ready' });
    remoteAvailable = false;
    await expect(source.refresh('spiral-abyss')).resolves.toMatchObject({
      status: 'last-known-good',
      refreshErrorCode: 'not-found',
      publication: { payload: { id: scenario.id } }
    });
  });

  it('fails closed with typed unavailable states for missing config and 404 without cache', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'gta-production-unavailable-'));
    temporaryDirectories.push(userDataDir);
    await expect(
      createProductionScenarioPublicationSource({
        userDataDir,
        packagedConfigPath: path.join(userDataDir, 'missing.json'),
        env: {}
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'production-source-not-configured' });

    const keys = generateKeyPairSync('ed25519');
    const configured = await configuredSource({
      userDataDir,
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      requestJson: async () => jsonResponse({}, 404)
    });
    if (configured.status !== 'configured') throw new Error('Expected configured source');
    await expect(configured.refresh('spiral-abyss')).resolves.toMatchObject({
      status: 'unavailable',
      trustedUse: 'production',
      refreshErrorCode: 'not-found'
    });
  });

  it('rejects private or non-Ed25519 key material in production configuration', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'gta-production-invalid-key-'));
    temporaryDirectories.push(userDataDir);
    const ed25519 = generateKeyPairSync('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

    await expect(
      configuredSource({
        userDataDir,
        requestJson: async () => jsonResponse({}, 404),
        publicKeyPem: ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'production-config-invalid' });
    await expect(
      configuredSource({
        userDataDir,
        requestJson: async () => jsonResponse({}, 404),
        publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'production-config-invalid' });
  });

  it('rejects an empty production keyring from both environment and packaged config', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'gta-production-empty-keyring-'));
    temporaryDirectories.push(userDataDir);
    await expect(
      createProductionScenarioPublicationSource({
        userDataDir,
        packagedConfigPath: path.join(userDataDir, 'unused.json'),
        env: {
          GTA_SCENARIO_MANIFEST_URL: 'https://scenario.example.test/manifest.json',
          GTA_SCENARIO_PUBLIC_KEYS_JSON: '{}'
        }
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'production-config-invalid' });

    await expect(
      createProductionScenarioPublicationSource({
        userDataDir,
        packagedConfigPath: path.join(userDataDir, 'scenario-production.json'),
        env: {},
        readFile: async () =>
          JSON.stringify({
            version: 1,
            enabled: true,
            manifestUrl: 'https://scenario.example.test/manifest.json',
            publicKeys: {}
          })
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'production-config-invalid' });
  });
});
