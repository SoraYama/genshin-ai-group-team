import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { scenarioPublicationManifestSchema } from '../../../src/main/scenario-publication/contracts.js';
import { createScenarioPublicationBundle } from '../../../src/main/scenario-publication/publisher.js';
import { verifyScenarioPublication } from '../../../src/main/scenario-publication/publication.js';
import { makeScenario } from './fixtures.js';

describe('offline scenario publication bundle', () => {
  it('generates strict current/history indexes and detached files for every mode', () => {
    const keys = generateKeyPairSync('ed25519');
    const candidates = [
      makeScenario('spiral-abyss'),
      makeScenario('stygian-onslaught'),
      makeScenario('imaginarium-theater')
    ].map((payload) => ({ payload, current: true, channel: 'development-sample' as const }));

    const bundle = createScenarioPublicationBundle(candidates, {
      keyId: 'development-test-key',
      privateKey: keys.privateKey,
      publishedAt: '2026-01-01T02:00:00.000Z'
    });

    expect(scenarioPublicationManifestSchema.parse(bundle.manifest)).toEqual(bundle.manifest);
    for (const mode of ['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater'] as const) {
      const index = bundle.manifest.modes[mode];
      expect(index.current?.channel).toBe('development-sample');
      expect(index.history).toHaveLength(1);
      const payload = bundle.documents[index.current!.payloadPath];
      const integrity = bundle.documents[index.current!.integrityPath];
      expect(
        verifyScenarioPublication(payload, integrity, { 'development-test-key': keys.publicKey })
          .mode
      ).toBe(mode);
    }
  });

  it('rejects duplicate identities or more than one current candidate per mode', () => {
    const keys = generateKeyPairSync('ed25519');
    const payload = makeScenario('spiral-abyss');
    const options = {
      keyId: 'test-key',
      privateKey: keys.privateKey,
      publishedAt: '2026-01-01T02:00:00.000Z'
    };

    expect(() =>
      createScenarioPublicationBundle(
        [
          { payload, current: true, channel: 'development-sample' },
          { payload, current: false, channel: 'development-sample' }
        ],
        options
      )
    ).toThrowError(expect.objectContaining({ code: 'manifest-invalid' }));
    expect(() =>
      createScenarioPublicationBundle(
        [
          { payload, current: true, channel: 'development-sample' },
          {
            payload: makeScenario('spiral-abyss', 'other', 'dev.other'),
            current: true,
            channel: 'development-sample'
          }
        ],
        options
      )
    ).toThrowError(expect.objectContaining({ code: 'manifest-invalid' }));
  });
});
