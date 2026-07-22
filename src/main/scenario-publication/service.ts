import { publicationIntegritySchema, type VersionedMeta } from '../../shared/scenario-v2.js';
import {
  scenarioPublicationManifestSchema,
  type ScenarioModeV2,
  type ScenarioPublicationUse,
  type ScenarioPublicationSnapshot,
  type ScenarioPublicationReader,
  type ScenarioPublicationStorage,
  type StoredScenarioPublication
} from './contracts.js';
import {
  asScenarioPublicationError,
  ScenarioPublicationError,
  type ScenarioPublicationErrorCode
} from './errors.js';
import { ScenarioPublicationMigratorRegistry } from './migration.js';
import type { ScenarioPublicKeyRing } from './publication.js';

const DEFAULT_EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function calculateScenarioFreshness(
  meta: Pick<VersionedMeta, 'effectiveFrom' | 'effectiveTo'>,
  asOf: Date,
  expiringWindowMs = DEFAULT_EXPIRING_WINDOW_MS
): ScenarioPublicationSnapshot['freshness'] {
  const asOfMs = asOf.getTime();
  const effectiveFromMs = Date.parse(meta.effectiveFrom);
  if (!Number.isFinite(asOfMs) || asOfMs < effectiveFromMs || !meta.effectiveTo) {
    return 'unknown';
  }
  const effectiveToMs = Date.parse(meta.effectiveTo);
  if (!Number.isFinite(effectiveToMs)) return 'unknown';
  if (asOfMs > effectiveToMs) return 'stale';
  if (asOfMs >= effectiveToMs - expiringWindowMs) return 'expiring';
  return 'fresh';
}

export interface ScenePublicationServiceOptions {
  reader: ScenarioPublicationReader;
  storage: ScenarioPublicationStorage;
  publicKeys: ScenarioPublicKeyRing;
  expectedUse: ScenarioPublicationUse;
  migrators?: ScenarioPublicationMigratorRegistry;
  now?: () => Date;
  expiringWindowMs?: number;
}

export class ScenePublicationService {
  private readonly reader: ScenarioPublicationReader;
  private readonly storage: ScenarioPublicationStorage;
  private readonly publicKeys: ScenarioPublicKeyRing;
  private readonly expectedUse: ScenarioPublicationUse;
  private readonly migrators: ScenarioPublicationMigratorRegistry;
  private readonly now: () => Date;
  private readonly expiringWindowMs: number;

  constructor(options: ScenePublicationServiceOptions) {
    this.reader = options.reader;
    this.storage = options.storage;
    this.publicKeys = options.publicKeys;
    this.expectedUse = options.expectedUse;
    this.migrators = options.migrators ?? new ScenarioPublicationMigratorRegistry();
    this.now = options.now ?? (() => new Date());
    this.expiringWindowMs = options.expiringWindowMs ?? DEFAULT_EXPIRING_WINDOW_MS;
  }

  async refresh(mode: ScenarioModeV2): Promise<ScenarioPublicationSnapshot> {
    const checkedAtDate = this.now();
    const checkedAt = checkedAtDate.toISOString();
    let lastKnownGood: StoredScenarioPublication | undefined;
    try {
      const stored = await this.storage.load(mode, this.expectedUse);
      if (stored) {
        const verifiedPayload = this.migrators.consume(
          stored.publication.payload,
          stored.publication.integrity,
          this.publicKeys
        );
        if (verifiedPayload.mode !== mode) {
          throw new ScenarioPublicationError('identity-mismatch');
        }
        lastKnownGood = {
          ...stored,
          publication: { ...stored.publication, payload: verifiedPayload }
        };
      }
    } catch {
      // A valid remote publication can repair an unreadable or unverifiable cache.
    }

    try {
      const manifestInput = await this.reader.readManifest();
      const manifestResult = scenarioPublicationManifestSchema.safeParse(manifestInput);
      if (!manifestResult.success) {
        throw new ScenarioPublicationError('manifest-invalid', { cause: manifestResult.error });
      }
      const descriptor = manifestResult.data.modes[mode].current;
      if (!descriptor) throw new ScenarioPublicationError('not-found');
      if (descriptor.channel !== this.expectedUse) {
        throw new ScenarioPublicationError('channel-mismatch');
      }

      const [payloadInput, integrityInput] = await Promise.all([
        this.reader.readJson(descriptor.payloadPath),
        this.reader.readJson(descriptor.integrityPath)
      ]);
      const integrityResult = publicationIntegritySchema.safeParse(integrityInput);
      if (!integrityResult.success) {
        throw new ScenarioPublicationError('schema-invalid', { cause: integrityResult.error });
      }
      const payload = this.migrators.consume(payloadInput, integrityResult.data, this.publicKeys);
      if (
        payload.mode !== mode ||
        descriptor.mode !== mode ||
        payload.id !== descriptor.scenarioId ||
        payload.meta.dataVersion !== descriptor.dataVersion ||
        payload.meta.schemaVersion !== descriptor.schemaVersion
      ) {
        throw new ScenarioPublicationError('identity-mismatch');
      }

      const stored: StoredScenarioPublication = {
        publication: { payload, integrity: integrityResult.data },
        savedAt: checkedAt
      };
      await this.storage.save(mode, this.expectedUse, stored);

      return {
        status: 'ready',
        trustedUse: this.expectedUse,
        freshness: calculateScenarioFreshness(payload.meta, checkedAtDate, this.expiringWindowMs),
        checkedAt,
        publication: stored.publication
      };
    } catch (error) {
      const publicationError = asScenarioPublicationError(error);
      return this.fallback(lastKnownGood, checkedAtDate, publicationError.code);
    }
  }

  private fallback(
    lastKnownGood: StoredScenarioPublication | undefined,
    checkedAtDate: Date,
    refreshErrorCode: ScenarioPublicationErrorCode
  ): ScenarioPublicationSnapshot {
    const checkedAt = checkedAtDate.toISOString();
    if (!lastKnownGood) {
      return {
        status: 'unavailable',
        trustedUse: this.expectedUse,
        freshness: 'unknown',
        checkedAt,
        refreshErrorCode
      };
    }
    return {
      status: 'last-known-good',
      trustedUse: this.expectedUse,
      freshness: calculateScenarioFreshness(
        lastKnownGood.publication.payload.meta,
        checkedAtDate,
        this.expiringWindowMs
      ),
      checkedAt,
      publication: lastKnownGood.publication,
      refreshErrorCode
    };
  }
}
