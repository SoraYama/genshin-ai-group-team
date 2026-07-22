import type { PublicationIntegrity, ScenarioV2 } from '../../shared/scenario-v2.js';
import { ScenarioPublicationError } from './errors.js';
import { verifyScenarioPublication, type ScenarioPublicKeyRing } from './publication.js';

export type ScenarioPublicationMigrator = (
  payload: unknown,
  integrity: PublicationIntegrity,
  publicKeys: ScenarioPublicKeyRing
) => ScenarioV2;

function readSchemaVersion(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const meta = (payload as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const version = (meta as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) ? version : undefined;
}

/**
 * Version routing lives outside the v2 contract. Future schema support registers
 * a verifier/migrator here instead of weakening the v2 Zod schema.
 */
export class ScenarioPublicationMigratorRegistry {
  private readonly migrators = new Map<number, ScenarioPublicationMigrator>();

  constructor() {
    this.register(2, (payload, integrity, publicKeys) =>
      verifyScenarioPublication(payload, integrity, publicKeys)
    );
  }

  register(version: number, migrator: ScenarioPublicationMigrator): void {
    if (!Number.isInteger(version) || version < 1 || this.migrators.has(version)) {
      throw new Error(`Invalid or duplicate scenario schema version: ${version}`);
    }
    this.migrators.set(version, migrator);
  }

  consume(
    payload: unknown,
    integrity: PublicationIntegrity,
    publicKeys: ScenarioPublicKeyRing
  ): ScenarioV2 {
    const version = readSchemaVersion(payload);
    if (version === undefined) {
      throw new ScenarioPublicationError('schema-invalid');
    }
    const migrator = this.migrators.get(version);
    if (!migrator) {
      throw new ScenarioPublicationError('unsupported-schema-version');
    }
    return migrator(payload, integrity, publicKeys);
  }
}
