import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  scenarioPublicationManifestSchema,
  type ScenarioPublicationManifest
} from '../../../src/main/scenario-publication/contracts.js';
import { ScenarioPublicationError } from '../../../src/main/scenario-publication/errors.js';
import { createScenarioPublication } from '../../../src/main/scenario-publication/publication.js';
import {
  calculateScenarioFreshness,
  ScenePublicationService
} from '../../../src/main/scenario-publication/service.js';
import type {
  ScenarioPublicationReader,
  ScenarioPublicationStorage,
  StoredScenarioPublication
} from '../../../src/main/scenario-publication/contracts.js';
import type { ScenarioV2 } from '../../../src/shared/scenario-v2.js';
import { makeScenario } from './fixtures.js';

const mode = 'spiral-abyss' as const;

function manifestFor(payload: ScenarioV2): ScenarioPublicationManifest {
  const descriptor = {
    mode: payload.mode,
    schemaVersion: payload.meta.schemaVersion,
    scenarioId: payload.id,
    dataVersion: payload.meta.dataVersion,
    payloadPath: `publications/${payload.id}/payload.json`,
    integrityPath: `publications/${payload.id}/integrity.json`,
    channel: 'development-sample' as const
  };
  const manifest: ScenarioPublicationManifest = {
    manifestVersion: 1,
    publishedAt: '2026-01-01T02:00:00.000Z',
    modes: {
      'spiral-abyss': { current: undefined, history: [] },
      'stygian-onslaught': { current: undefined, history: [] },
      'imaginarium-theater': { current: undefined, history: [] }
    }
  };
  manifest.modes[payload.mode] = { current: descriptor, history: [descriptor] };
  return manifest;
}

class MemoryReader implements ScenarioPublicationReader {
  constructor(
    readonly manifest: unknown,
    readonly documents: Readonly<Record<string, unknown>>,
    readonly failure?: { at: 'manifest' | string; error: ScenarioPublicationError }
  ) {}

  async readManifest(): Promise<unknown> {
    if (this.failure?.at === 'manifest') throw this.failure.error;
    return this.manifest;
  }

  async readJson(publicationPath: string): Promise<unknown> {
    if (this.failure?.at === publicationPath) throw this.failure.error;
    if (!(publicationPath in this.documents)) throw new ScenarioPublicationError('not-found');
    return this.documents[publicationPath];
  }
}

class MemoryStorage implements ScenarioPublicationStorage {
  value?: StoredScenarioPublication;
  failSave = false;

  async load(): Promise<StoredScenarioPublication | undefined> {
    return this.value;
  }

  async save(_mode: ScenarioV2['mode'], value: StoredScenarioPublication): Promise<void> {
    if (this.failSave) throw new ScenarioPublicationError('storage-write-failed');
    this.value = value;
  }
}

function setup(payload = makeScenario(mode), storage = new MemoryStorage()) {
  const keys = generateKeyPairSync('ed25519');
  const publication = createScenarioPublication(payload, {
    keyId: 'test-release-key',
    privateKey: keys.privateKey
  });
  const manifest = manifestFor(publication.payload);
  const descriptor = manifest.modes[mode].current!;
  const reader = new MemoryReader(manifest, {
    [descriptor.payloadPath]: publication.payload,
    [descriptor.integrityPath]: publication.integrity
  });
  const service = new ScenePublicationService({
    reader,
    storage,
    publicKeys: { 'test-release-key': keys.publicKey },
    now: () => new Date('2026-01-15T00:00:00.000Z')
  });
  return { service, storage, reader, publication, manifest, keys, descriptor };
}

describe('scenario publication manifest', () => {
  it('rejects unknown keys and unsafe publication paths', () => {
    const payload = makeScenario(mode);
    const valid = manifestFor(payload);
    expect(scenarioPublicationManifestSchema.safeParse(valid).success).toBe(true);
    expect(
      scenarioPublicationManifestSchema.safeParse({ ...valid, producerDrift: true }).success
    ).toBe(false);
    expect(
      scenarioPublicationManifestSchema.safeParse({
        ...valid,
        modes: {
          ...valid.modes,
          [mode]: {
            ...valid.modes[mode],
            current: { ...valid.modes[mode].current!, payloadPath: '../secret.json' }
          }
        }
      }).success
    ).toBe(false);
  });
});

describe('ScenePublicationService', () => {
  it('publishes all three modes through the same verified path', async () => {
    for (const scenarioMode of [
      'spiral-abyss',
      'stygian-onslaught',
      'imaginarium-theater'
    ] as const) {
      const payload = makeScenario(scenarioMode);
      const keys = generateKeyPairSync('ed25519');
      const publication = createScenarioPublication(payload, {
        keyId: 'test-key',
        privateKey: keys.privateKey
      });
      const manifest = manifestFor(publication.payload);
      const descriptor = manifest.modes[scenarioMode].current!;
      const reader = new MemoryReader(manifest, {
        [descriptor.payloadPath]: publication.payload,
        [descriptor.integrityPath]: publication.integrity
      });
      const service = new ScenePublicationService({
        reader,
        storage: new MemoryStorage(),
        publicKeys: { 'test-key': keys.publicKey },
        now: () => new Date('2026-01-15T00:00:00.000Z')
      });

      const result = await service.refresh(scenarioMode);
      expect(result.status).toBe('ready');
      expect(result.publication?.payload.mode).toBe(scenarioMode);
    }
  });

  it.each([
    ['manifest', 'not-found'],
    ['payload', 'not-found'],
    ['manifest', 'network-unavailable']
  ] as const)('returns unavailable on first-start %s %s', async (target, code) => {
    const { manifest, descriptor, keys } = setup();
    const failureAt = target === 'manifest' ? 'manifest' : descriptor.payloadPath;
    const reader = new MemoryReader(
      manifest,
      {},
      {
        at: failureAt,
        error: new ScenarioPublicationError(code)
      }
    );
    const service = new ScenePublicationService({
      reader,
      storage: new MemoryStorage(),
      publicKeys: { 'test-release-key': keys.publicKey }
    });

    await expect(service.refresh(mode)).resolves.toMatchObject({
      status: 'unavailable',
      refreshErrorCode: code
    });
  });

  it.each(['digest', 'signature'] as const)(
    'keeps the last-known-good publication after a %s failure',
    async (failureKind) => {
      const { service, storage, publication, manifest, descriptor, keys } = setup();
      expect((await service.refresh(mode)).status).toBe('ready');
      const saved = storage.value;
      const brokenIntegrity =
        failureKind === 'digest'
          ? {
              ...publication.integrity,
              hash: { ...publication.integrity.hash, value: `${'A'.repeat(43)}=` }
            }
          : {
              ...publication.integrity,
              signature: { ...publication.integrity.signature, value: `${'A'.repeat(86)}==` }
            };
      const brokenService = new ScenePublicationService({
        reader: new MemoryReader(manifest, {
          [descriptor.payloadPath]: publication.payload,
          [descriptor.integrityPath]: brokenIntegrity
        }),
        storage,
        publicKeys: { 'test-release-key': keys.publicKey },
        now: () => new Date('2026-01-16T00:00:00.000Z')
      });

      const result = await brokenService.refresh(mode);
      expect(result.status).toBe('last-known-good');
      expect(result.refreshErrorCode).toBe(
        failureKind === 'digest' ? 'digest-mismatch' : 'bad-signature'
      );
      expect(storage.value).toEqual(saved);
    }
  );

  it('never treats a locally tampered cache record as last-known-good', async () => {
    const { service, storage, manifest, keys } = setup();
    await service.refresh(mode);
    const cachedPayload = storage.value!.publication.payload;
    if (cachedPayload.mode !== 'spiral-abyss') throw new Error('Unexpected fixture mode');
    storage.value!.publication.payload = {
      ...cachedPayload,
      blessing: { id: 'tampered-cache', description: 'changed after verification' }
    };
    const offlineService = new ScenePublicationService({
      reader: new MemoryReader(
        manifest,
        {},
        {
          at: 'manifest',
          error: new ScenarioPublicationError('network-unavailable')
        }
      ),
      storage,
      publicKeys: { 'test-release-key': keys.publicKey }
    });

    await expect(offlineService.refresh(mode)).resolves.toMatchObject({
      status: 'unavailable',
      refreshErrorCode: 'network-unavailable'
    });
  });

  it('rejects payload unknown keys and manifest identity conflicts without replacing LKG', async () => {
    const { service, storage, publication, manifest, descriptor, keys } = setup();
    await service.refresh(mode);
    const saved = storage.value;
    const driftedPayload = { ...publication.payload, producerDrift: true };
    const conflictManifest = structuredClone(manifest);
    conflictManifest.modes[mode].current!.scenarioId = 'different-id';

    for (const [reader, expectedCode] of [
      [
        new MemoryReader(manifest, {
          [descriptor.payloadPath]: driftedPayload,
          [descriptor.integrityPath]: publication.integrity
        }),
        'schema-invalid'
      ],
      [
        new MemoryReader(conflictManifest, {
          [descriptor.payloadPath]: publication.payload,
          [descriptor.integrityPath]: publication.integrity
        }),
        'identity-mismatch'
      ]
    ] as const) {
      const result = await new ScenePublicationService({
        reader,
        storage,
        publicKeys: { 'test-release-key': keys.publicKey }
      }).refresh(mode);
      expect(result).toMatchObject({ status: 'last-known-good', refreshErrorCode: expectedCode });
      expect(storage.value).toEqual(saved);
    }
  });

  it('returns a typed newer-schema error and preserves LKG', async () => {
    const { service, storage, publication, manifest, descriptor, keys } = setup();
    await service.refresh(mode);
    const futurePayload = structuredClone(publication.payload) as unknown as {
      meta: { schemaVersion: number };
    };
    futurePayload.meta.schemaVersion = 3;
    const futureManifest = structuredClone(manifest);
    futureManifest.modes[mode].current!.schemaVersion = 3;
    const result = await new ScenePublicationService({
      reader: new MemoryReader(futureManifest, {
        [descriptor.payloadPath]: futurePayload,
        [descriptor.integrityPath]: publication.integrity
      }),
      storage,
      publicKeys: { 'test-release-key': keys.publicKey }
    }).refresh(mode);

    expect(result).toMatchObject({
      status: 'last-known-good',
      refreshErrorCode: 'unsupported-schema-version'
    });
  });

  it('does not expose a fetched publication when atomic persistence fails', async () => {
    const storage = new MemoryStorage();
    storage.failSave = true;
    const { service } = setup(makeScenario(mode), storage);

    await expect(service.refresh(mode)).resolves.toMatchObject({
      status: 'unavailable',
      refreshErrorCode: 'storage-write-failed'
    });
    expect(storage.value).toBeUndefined();
  });
});

describe('freshness calculation stays outside the signed payload', () => {
  it.each([
    ['2025-12-01T00:00:00.000Z', 'unknown'],
    ['2026-01-15T00:00:00.000Z', 'fresh'],
    ['2026-01-31T12:00:00.000Z', 'expiring'],
    ['2026-02-02T00:00:00.000Z', 'stale']
  ] as const)('maps %s to %s', (asOf, expected) => {
    expect(
      calculateScenarioFreshness(
        {
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: '2026-02-01T00:00:00.000Z'
        },
        new Date(asOf),
        24 * 60 * 60 * 1000
      )
    ).toBe(expected);
  });

  it('returns unknown without an effective end date', () => {
    expect(
      calculateScenarioFreshness(
        { effectiveFrom: '2026-01-01T00:00:00.000Z' },
        new Date('2026-01-15T00:00:00.000Z')
      )
    ).toBe('unknown');
  });
});
