import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
  type KeyLike
} from 'node:crypto';

import {
  publicationIntegritySchema,
  scenarioV2Schema,
  type PublicationIntegrity,
  type ScenarioPublicationEnvelope,
  type ScenarioV2
} from '../../shared/scenario-v2.js';
import { ScenarioPublicationError } from './errors.js';

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        throw new ScenarioPublicationError('schema-invalid');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ScenarioPublicationError('schema-invalid');
    }
  }
}

function canonicalizeValue(value: unknown): string {
  if (typeof value === 'string') {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ScenarioPublicationError('schema-invalid');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValue).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    keys.forEach(assertWellFormedUnicode);
    const properties = keys
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`);
    return `{${properties.join(',')}}`;
  }
  throw new ScenarioPublicationError('schema-invalid');
}

/** RFC 8785-compatible canonical JSON for schema-validated JSON values. */
export function canonicalizeJson(value: JsonValue | unknown): string {
  return canonicalizeValue(value);
}

export interface PublicationSigningOptions {
  keyId: string;
  privateKey: KeyLike | KeyObject;
}

export type ScenarioPublicKeyRing = Readonly<Record<string, KeyLike | KeyObject>>;

function canonicalPayloadBytes(payload: ScenarioV2): Buffer {
  return Buffer.from(canonicalizeJson(payload), 'utf8');
}

function requireEd25519PrivateKey(key: KeyLike | KeyObject): KeyObject {
  let parsed: KeyObject;
  try {
    parsed = key instanceof KeyObject ? key : createPrivateKey(key);
  } catch {
    throw new ScenarioPublicationError('invalid-signing-key');
  }
  if (parsed.type !== 'private') {
    throw new ScenarioPublicationError('invalid-signing-key');
  }
  if (parsed.asymmetricKeyType !== 'ed25519') {
    throw new ScenarioPublicationError('unsupported-key-type');
  }
  return parsed;
}

function requireEd25519PublicKey(key: KeyLike | KeyObject): KeyObject {
  let parsed: KeyObject;
  try {
    if (key instanceof KeyObject && key.type !== 'public') {
      throw new ScenarioPublicationError('invalid-signing-key');
    }
    parsed = key instanceof KeyObject ? key : createPublicKey(key);
  } catch (error) {
    if (error instanceof ScenarioPublicationError) throw error;
    throw new ScenarioPublicationError('invalid-signing-key');
  }
  if (parsed.asymmetricKeyType !== 'ed25519') {
    throw new ScenarioPublicationError('unsupported-key-type');
  }
  return parsed;
}

export function createScenarioPublication(
  input: unknown,
  options: PublicationSigningOptions
): ScenarioPublicationEnvelope {
  const parsed = scenarioV2Schema.safeParse(input);
  if (!parsed.success || options.keyId.trim().length === 0) {
    throw new ScenarioPublicationError('schema-invalid', {
      cause: parsed.success ? undefined : parsed.error
    });
  }

  const payloadBytes = canonicalPayloadBytes(parsed.data);
  const privateKey = requireEd25519PrivateKey(options.privateKey);
  const integrity: PublicationIntegrity = {
    scope: 'payload',
    serialization: 'RFC8785-JCS',
    hash: {
      algorithm: 'sha256',
      encoding: 'base64',
      value: createHash('sha256').update(payloadBytes).digest('base64')
    },
    signature: {
      algorithm: 'ed25519',
      keyId: options.keyId,
      encoding: 'base64',
      value: sign(null, payloadBytes, privateKey).toString('base64')
    }
  };

  return { payload: parsed.data, integrity: publicationIntegritySchema.parse(integrity) };
}

export function verifyScenarioPublication(
  payloadInput: unknown,
  integrityInput: unknown,
  publicKeys: ScenarioPublicKeyRing
): ScenarioV2 {
  const payloadResult = scenarioV2Schema.safeParse(payloadInput);
  if (!payloadResult.success) {
    throw new ScenarioPublicationError('schema-invalid', { cause: payloadResult.error });
  }
  const integrityResult = publicationIntegritySchema.safeParse(integrityInput);
  if (!integrityResult.success) {
    throw new ScenarioPublicationError('schema-invalid', { cause: integrityResult.error });
  }

  const payloadBytes = canonicalPayloadBytes(payloadResult.data);
  const actualDigest = createHash('sha256').update(payloadBytes).digest('base64');
  if (actualDigest !== integrityResult.data.hash.value) {
    throw new ScenarioPublicationError('digest-mismatch');
  }

  const publicKey = publicKeys[integrityResult.data.signature.keyId];
  if (!publicKey) {
    throw new ScenarioPublicationError('unknown-signing-key');
  }
  const ed25519PublicKey = requireEd25519PublicKey(publicKey);
  const signature = Buffer.from(integrityResult.data.signature.value, 'base64');
  if (!verify(null, payloadBytes, ed25519PublicKey, signature)) {
    throw new ScenarioPublicationError('bad-signature');
  }

  return payloadResult.data;
}
