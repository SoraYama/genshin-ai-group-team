import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  canonicalizeJson,
  createScenarioPublication,
  verifyScenarioPublication
} from '../../../src/main/scenario-publication/publication.js';
import { ScenarioPublicationError } from '../../../src/main/scenario-publication/errors.js';
import { makeScenario } from './fixtures.js';

describe('RFC 8785 publication primitives', () => {
  it('canonicalizes nested object keys without changing array order', () => {
    expect(canonicalizeJson({ z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }] })).toBe(
      '{"a":{"b":2,"d":4},"list":[{"x":1,"y":2}],"z":1}'
    );
  });

  it('rejects lone Unicode surrogates that RFC 8785 forbids', () => {
    expect(() => canonicalizeJson({ broken: '\ud800' })).toThrowError(
      expect.objectContaining({ code: 'schema-invalid' })
    );
    expect(() => canonicalizeJson({ ['\udc00']: 'broken key' })).toThrowError(
      expect.objectContaining({ code: 'schema-invalid' })
    );
  });

  it.each(['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater'] as const)(
    'creates and verifies a detached signed %s publication',
    (mode) => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const publication = createScenarioPublication(makeScenario(mode), {
        keyId: 'test-key',
        privateKey
      });

      expect(publication.integrity.hash.value).toMatch(/=$/);
      expect(
        verifyScenarioPublication(publication.payload, publication.integrity, {
          'test-key': publicKey
        })
      ).toEqual(publication.payload);
    }
  );

  it('rejects a digest mismatch before trusting the payload', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publication = createScenarioPublication(makeScenario('spiral-abyss'), {
      keyId: 'test-key',
      privateKey
    });
    const changed = {
      ...publication.payload,
      blessing: { id: 'changed', description: 'changed after signing' }
    };

    expect(() =>
      verifyScenarioPublication(changed, publication.integrity, { 'test-key': publicKey })
    ).toThrowError(expect.objectContaining({ code: 'digest-mismatch' }));
  });

  it('rejects a signature from an untrusted private key', () => {
    const signingPair = generateKeyPairSync('ed25519');
    const trustedPair = generateKeyPairSync('ed25519');
    const publication = createScenarioPublication(makeScenario('spiral-abyss'), {
      keyId: 'trusted-key',
      privateKey: signingPair.privateKey
    });

    expect(() =>
      verifyScenarioPublication(publication.payload, publication.integrity, {
        'trusted-key': trustedPair.publicKey
      })
    ).toThrowError(expect.objectContaining({ code: 'bad-signature' }));
  });

  it('rejects non-Ed25519 private and public keys before crypto operations', () => {
    const signingPair = generateKeyPairSync('ed25519');
    const rsaPair = generateKeyPairSync('rsa', { modulusLength: 512 });
    const payload = makeScenario('spiral-abyss');

    expect(() =>
      createScenarioPublication(payload, {
        keyId: 'rsa-key',
        privateKey: rsaPair.privateKey
      })
    ).toThrowError(expect.objectContaining({ code: 'unsupported-key-type' }));

    const publication = createScenarioPublication(payload, {
      keyId: 'release-key',
      privateKey: signingPair.privateKey
    });
    expect(() =>
      verifyScenarioPublication(publication.payload, publication.integrity, {
        'release-key': rsaPair.publicKey
      })
    ).toThrowError(expect.objectContaining({ code: 'unsupported-key-type' }));
  });

  it('rejects unknown payload fields before signing', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const payload = { ...makeScenario('spiral-abyss'), producerDrift: true };

    expect(() => createScenarioPublication(payload, { keyId: 'test-key', privateKey })).toThrow(
      ScenarioPublicationError
    );
  });
});
