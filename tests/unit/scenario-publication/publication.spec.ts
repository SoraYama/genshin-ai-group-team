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

  it('rejects private public-key material in PEM, KeyObject, and JWK forms', () => {
    const pair = generateKeyPairSync('ed25519');
    const publication = createScenarioPublication(makeScenario('spiral-abyss'), {
      keyId: 'release-key',
      privateKey: pair.privateKey
    });
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const privateJwk = pair.privateKey.export({ format: 'jwk' });

    for (const privateMaterial of [pair.privateKey, privatePem, privateJwk] as const) {
      expect(() =>
        verifyScenarioPublication(publication.payload, publication.integrity, {
          'release-key': privateMaterial as never
        })
      ).toThrowError(expect.objectContaining({ code: 'invalid-signing-key' }));
    }
  });

  it('accepts an Ed25519 public JWK with no private parameter', () => {
    const pair = generateKeyPairSync('ed25519');
    const publication = createScenarioPublication(makeScenario('spiral-abyss'), {
      keyId: 'release-key',
      privateKey: pair.privateKey
    });

    expect(
      verifyScenarioPublication(publication.payload, publication.integrity, {
        'release-key': pair.publicKey.export({ format: 'jwk' })
      })
    ).toEqual(publication.payload);
  });

  it('signs and verifies only raw JSON values that Zod would not transform', () => {
    const pair = generateKeyPairSync('ed25519');
    const canonical = makeScenario('spiral-abyss');
    const publication = createScenarioPublication(canonical, {
      keyId: 'release-key',
      privateKey: pair.privateKey
    });
    const whitespace = { ...canonical, id: `  ${canonical.id}  ` };
    const omittedDefault = structuredClone(canonical);
    if (omittedDefault.mode !== 'spiral-abyss') throw new Error('Unexpected fixture mode');
    const mechanics = omittedDefault.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!
      .mechanics as unknown as Record<string, unknown>;
    delete mechanics.shields;

    for (const payload of [whitespace, omittedDefault]) {
      expect(() =>
        createScenarioPublication(payload, {
          keyId: 'release-key',
          privateKey: pair.privateKey
        })
      ).toThrowError(expect.objectContaining({ code: 'noncanonical-payload' }));
      expect(() =>
        verifyScenarioPublication(payload, publication.integrity, {
          'release-key': pair.publicKey
        })
      ).toThrowError(expect.objectContaining({ code: 'noncanonical-payload' }));
    }
  });

  it('rejects unknown payload fields before signing', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const payload = { ...makeScenario('spiral-abyss'), producerDrift: true };

    expect(() => createScenarioPublication(payload, { keyId: 'test-key', privateKey })).toThrow(
      ScenarioPublicationError
    );
  });
});
