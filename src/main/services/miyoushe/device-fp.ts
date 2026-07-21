import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { request } from 'undici';
import {
  type DeviceFpCooldownInspection,
  type DeviceFpFailureKind
} from './device-fp-recovery-store.js';
import {
  buildDeviceFpPayload,
  ensureStableDeviceProfile,
  mergeDeviceCookies,
  type DeviceCookieUpdates,
  type DeviceProfileDependencies,
  type StableDeviceProfile
} from './device-profile.js';

const DEVICE_FP_ENDPOINT = 'https://public-data-api.mihoyo.com/device-fp/api/getFp';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const DEFAULT_RECENT_REFRESH_MS = 5 * 60_000;
const PARTITION_PREPARATION_KEY = 'partition';
const DEVICE_FP_PATTERN = /^[A-Za-z0-9]{10,64}$/;
const REQUIRED_DEVICE_COOKIES = [
  '_MHYUUID',
  'DEVICEFP',
  'DEVICEFP_SEED_ID',
  'DEVICEFP_SEED_TIME'
] as const;

export type DeviceFpResult =
  | { ok: true; cookie: string; deviceHash: string; refreshed: boolean }
  | {
      ok: false;
      cookie: string;
      deviceHash?: string;
      reason: DeviceFpFailureKind | 'cooldown';
      retryAt?: number;
    };

export interface DeviceFpTransport {
  (
    payload: ReturnType<typeof buildDeviceFpPayload>
  ): Promise<{ statusCode: number; bodyText: string }>;
}

export interface DeviceFpCookieWriter {
  writeDeviceCookies(values: Readonly<Record<string, string>>): Promise<void>;
}

export type DeviceFpPersistence = 'partition' | 'memory-only';

export interface DeviceFpEnsureOptions {
  persistence?: DeviceFpPersistence;
}

export interface DeviceFpCooldown {
  inspect(deviceId: string): DeviceFpCooldownInspection;
  recordFailure(deviceId: string, reason: DeviceFpFailureKind): void;
  clearFailure(deviceId: string): void;
}

type SharedFingerprintResult =
  | { ok: true; deviceFp: string }
  | { ok: false; reason: DeviceFpFailureKind };

interface PreparedProfile {
  cookie: string;
  profile: StableDeviceProfile;
  wasComplete: boolean;
}

type SharedPreparationResult =
  | { ok: true; profile: StableDeviceProfile; updates: DeviceCookieUpdates }
  | {
      ok: false;
      reason: 'profile-invalid' | 'persist';
      deviceId?: string;
      updates: DeviceCookieUpdates;
    };

function parseCookies(cookie: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) values.set(name, value);
  }
  return values;
}

function fullDeviceHash(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

function publicDeviceHash(deviceId: string): string {
  return fullDeviceHash(deviceId).slice(0, 12);
}

function internalProfileKey(deviceId: string, seedId: string, seedTime: string): string {
  return createHash('sha256')
    .update(deviceId)
    .update('\0')
    .update(seedId)
    .update('\0')
    .update(seedTime)
    .digest('hex');
}

function internalRestoreKey(profileKey: string, deviceFp: string): string {
  return createHash('sha256').update(profileKey).update('\0').update(deviceFp).digest('hex');
}

function hasCompleteDeviceProfile(cookie: string): boolean {
  const cookies = parseCookies(cookie);
  return REQUIRED_DEVICE_COOKIES.every((name) => Boolean(cookies.get(name)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuntimeStableProfile(value: unknown): value is StableDeviceProfile {
  if (!isRecord(value)) return false;
  return ['deviceId', 'deviceFp', 'seedId', 'seedTime'].every((name) => {
    const field = value[name];
    return typeof field === 'string' && field.trim().length > 0;
  });
}

function failureResult(
  cookie: string,
  reason: DeviceFpFailureKind | 'cooldown',
  deviceId?: string,
  retryAt?: number
): DeviceFpResult {
  return {
    ok: false,
    cookie,
    ...(deviceId ? { deviceHash: publicDeviceHash(deviceId) } : {}),
    reason,
    ...(retryAt === undefined ? {} : { retryAt })
  };
}

async function defaultTransport(
  payload: ReturnType<typeof buildDeviceFpPayload>
): Promise<{ statusCode: number; bodyText: string }> {
  const response = await request(DEVICE_FP_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    bodyTimeout: REQUEST_TIMEOUT_MS,
    headersTimeout: REQUEST_TIMEOUT_MS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  return { statusCode: response.statusCode, bodyText: await readLimitedBody(response.body) };
}

async function readLimitedBody(
  body: AsyncIterable<Uint8Array> & { destroy(error?: Error): unknown }
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
      const error = new Error('getFp response body exceeded limit');
      try {
        body.destroy(error);
      } catch {
        // The size violation remains the transport failure even if disposal also fails.
      }
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export class MiyousheDeviceFpService {
  private readonly cookieWriter: DeviceFpCookieWriter;
  private readonly cooldown: DeviceFpCooldown;
  private readonly transport: DeviceFpTransport;
  private readonly now: () => number;
  private readonly profileDependencies?: DeviceProfileDependencies;
  private readonly recentRefreshMs: number;
  private readonly latestFingerprintByDevice = new Map<string, string>();
  private readonly recentRefreshByDevice = new Map<
    string,
    { deviceFp: string; refreshedAt: number }
  >();
  private readonly inFlightByDevice = new Map<string, Promise<SharedFingerprintResult>>();
  private readonly restoreInFlightByProfile = new Map<string, Promise<SharedFingerprintResult>>();
  private readonly fingerprintMutationTailByProfile = new Map<string, Promise<void>>();
  private readonly preparationInFlightByIdentity = new Map<
    string,
    Promise<SharedPreparationResult>
  >();
  private readonly persistenceScope = new AsyncLocalStorage<DeviceFpPersistence>();

  constructor(options: {
    cookieWriter: DeviceFpCookieWriter;
    cooldown: DeviceFpCooldown;
    transport?: DeviceFpTransport;
    now?: () => number;
    profileDependencies?: DeviceProfileDependencies;
    recentRefreshMs?: number;
  }) {
    this.cookieWriter = options.cookieWriter;
    this.cooldown = options.cooldown;
    this.transport = options.transport ?? defaultTransport;
    this.now = options.now ?? Date.now;
    this.profileDependencies = options.profileDependencies;
    const recentRefreshMs = options.recentRefreshMs ?? DEFAULT_RECENT_REFRESH_MS;
    if (!Number.isFinite(recentRefreshMs) || recentRefreshMs < 0) {
      throw new RangeError('recentRefreshMs must be a finite non-negative number');
    }
    this.recentRefreshMs = recentRefreshMs;
  }

  applyKnownFingerprint(cookie: string): string {
    const cookies = parseCookies(cookie);
    const deviceId = cookies.get('_MHYUUID');
    const seedId = cookies.get('DEVICEFP_SEED_ID');
    const seedTime = cookies.get('DEVICEFP_SEED_TIME');
    if (!deviceId || !seedId || !seedTime) return cookie;

    const knownFingerprint = this.latestFingerprintByDevice.get(
      this.scopedProfileKey(
        this.currentPersistence(),
        internalProfileKey(deviceId, seedId, seedTime)
      )
    );
    if (!knownFingerprint || cookies.get('DEVICEFP') === knownFingerprint) return cookie;
    return mergeDeviceCookies(cookie, { DEVICEFP: knownFingerprint });
  }

  async ensureForSession(
    cookie: string,
    options: DeviceFpEnsureOptions = {}
  ): Promise<DeviceFpResult> {
    const persistence = this.currentPersistence(options.persistence);
    const originalCookies = parseCookies(cookie);
    const prepared = await this.prepareProfile(cookie, persistence);
    if (!prepared.ok) return prepared.result;

    const { cookie: preparedCookie, profile, wasComplete } = prepared.value;
    const key = this.scopedProfileKey(
      persistence,
      internalProfileKey(profile.deviceId, profile.seedId, profile.seedTime)
    );
    if (wasComplete) {
      const cachedFingerprint = this.latestFingerprintByDevice.get(key);
      this.latestFingerprintByDevice.set(key, profile.deviceFp);
      if (cachedFingerprint !== undefined && cachedFingerprint !== profile.deviceFp) {
        this.recentRefreshByDevice.delete(key);
      }
      return {
        ok: true,
        cookie: preparedCookie,
        deviceHash: publicDeviceHash(profile.deviceId),
        refreshed: false
      };
    }

    const hasOriginalStableIdentity =
      Boolean(originalCookies.get('_MHYUUID')) &&
      Boolean(originalCookies.get('DEVICEFP_SEED_ID')) &&
      Boolean(originalCookies.get('DEVICEFP_SEED_TIME'));
    if (hasOriginalStableIdentity && !originalCookies.get('DEVICEFP')) {
      const knownFingerprint = this.latestFingerprintByDevice.get(key);
      if (knownFingerprint) {
        const restored = await this.restoreKnownFingerprint(
          profile,
          key,
          knownFingerprint,
          persistence
        );
        if (!restored.ok) return failureResult(preparedCookie, restored.reason, profile.deviceId);
        return {
          ok: true,
          cookie: mergeDeviceCookies(preparedCookie, { DEVICEFP: restored.deviceFp }),
          deviceHash: publicDeviceHash(profile.deviceId),
          refreshed: false
        };
      }
    }

    const cooldownResult = this.inspectCooldown(preparedCookie, profile.deviceId);
    if (cooldownResult) return cooldownResult;
    return this.refreshFingerprint(preparedCookie, profile, persistence);
  }

  runWithPersistence<T>(persistence: DeviceFpPersistence, operation: () => Promise<T>): Promise<T> {
    return this.persistenceScope.run(persistence, operation);
  }

  async recoverFrom5003(cookie: string): Promise<DeviceFpResult> {
    const persistence = this.currentPersistence();
    const appliedCookie = this.applyKnownFingerprint(cookie);
    const prepared = await this.prepareProfile(appliedCookie, persistence);
    if (!prepared.ok) return prepared.result;

    const { cookie: preparedCookie, profile } = prepared.value;
    const cooldownResult = this.inspectCooldown(preparedCookie, profile.deviceId);
    if (cooldownResult) return cooldownResult;

    const recent = this.recentRefreshByDevice.get(
      this.scopedProfileKey(
        persistence,
        internalProfileKey(profile.deviceId, profile.seedId, profile.seedTime)
      )
    );
    const recentAge = recent ? this.now() - recent.refreshedAt : undefined;
    if (recent && recentAge !== undefined && recentAge >= 0 && recentAge < this.recentRefreshMs) {
      return {
        ok: true,
        cookie: mergeDeviceCookies(preparedCookie, { DEVICEFP: recent.deviceFp }),
        deviceHash: publicDeviceHash(profile.deviceId),
        refreshed: false
      };
    }

    return this.refreshFingerprint(preparedCookie, profile, persistence);
  }

  finishReplay(cookie: string, outcome: 'success' | '5003' | 'other-error'): void {
    try {
      const deviceId = parseCookies(cookie).get('_MHYUUID');
      if (!deviceId || outcome === 'other-error') return;
      if (outcome === 'success') {
        this.safeClearFailure(deviceId);
      } else {
        this.safeRecordFailure(deviceId, 'upstream');
      }
    } catch {
      // Replay bookkeeping must never interfere with the caller's request lifecycle.
    }
  }

  private async prepareProfile(
    cookie: string,
    persistence: 'partition' | 'memory-only'
  ): Promise<{ ok: true; value: PreparedProfile } | { ok: false; result: DeviceFpResult }> {
    const shared = await this.prepareStableProfile(cookie, persistence);
    let mergedCookie: string;
    try {
      mergedCookie = mergeDeviceCookies(cookie, shared.updates);
    } catch {
      const deviceId = shared.ok ? shared.profile.deviceId : shared.deviceId;
      if (deviceId) this.safeRecordFailure(deviceId, 'profile-invalid');
      return {
        ok: false,
        result: failureResult(cookie, 'profile-invalid', deviceId)
      };
    }
    if (!shared.ok) {
      return {
        ok: false,
        result: failureResult(mergedCookie, shared.reason, shared.deviceId)
      };
    }

    const hasStableUpdates = Object.keys(shared.updates).length > 0;
    return {
      ok: true,
      value: {
        cookie: mergedCookie,
        profile: shared.profile,
        wasComplete: hasCompleteDeviceProfile(cookie) && !hasStableUpdates
      }
    };
  }

  private prepareStableProfile(
    cookie: string,
    persistence: 'partition' | 'memory-only'
  ): Promise<SharedPreparationResult> {
    const cookies = parseCookies(cookie);
    const deviceId = cookies.get('_MHYUUID');
    const needsInitialization =
      !deviceId || !cookies.get('DEVICEFP_SEED_ID') || !cookies.get('DEVICEFP_SEED_TIME');
    if (!needsInitialization) return this.createStableProfile(cookie, false, persistence);

    const identityKey = deviceId
      ? fullDeviceHash(deviceId)
      : persistence === 'partition'
        ? PARTITION_PREPARATION_KEY
        : fullDeviceHash(cookie);
    const key = `${persistence}:${identityKey}`;
    const current = this.preparationInFlightByIdentity.get(key);
    if (current) return current;

    const pending = this.createStableProfile(cookie, true, persistence).finally(() => {
      if (this.preparationInFlightByIdentity.get(key) === pending) {
        this.preparationInFlightByIdentity.delete(key);
      }
    });
    this.preparationInFlightByIdentity.set(key, pending);
    return pending;
  }

  private async createStableProfile(
    cookie: string,
    includeFullStableUpdates: boolean,
    persistence: 'partition' | 'memory-only'
  ): Promise<SharedPreparationResult> {
    const knownDeviceId = parseCookies(cookie).get('_MHYUUID');
    let ensured: ReturnType<typeof ensureStableDeviceProfile>;
    let recordableDeviceId = knownDeviceId;
    try {
      ensured = ensureStableDeviceProfile(cookie, this.profileDependencies);
      const runtimeProfile: unknown = ensured.profile;
      if (
        isRecord(runtimeProfile) &&
        typeof runtimeProfile.deviceId === 'string' &&
        runtimeProfile.deviceId.trim()
      ) {
        recordableDeviceId = runtimeProfile.deviceId;
      }
      if (!isRuntimeStableProfile(runtimeProfile)) throw new TypeError('invalid device profile');
    } catch {
      if (recordableDeviceId) this.safeRecordFailure(recordableDeviceId, 'profile-invalid');
      return {
        ok: false,
        reason: 'profile-invalid',
        ...(recordableDeviceId ? { deviceId: recordableDeviceId } : {}),
        updates: {}
      };
    }

    const updates: DeviceCookieUpdates = includeFullStableUpdates
      ? {
          _MHYUUID: ensured.profile.deviceId,
          DEVICEFP_SEED_ID: ensured.profile.seedId,
          DEVICEFP_SEED_TIME: ensured.profile.seedTime
        }
      : ensured.updates;
    const hasStableUpdates = Object.keys(updates).length > 0;
    if (hasStableUpdates && persistence === 'partition') {
      try {
        await this.cookieWriter.writeDeviceCookies(updates);
      } catch {
        this.safeRecordFailure(ensured.profile.deviceId, 'persist');
        return {
          ok: false,
          reason: 'persist',
          deviceId: ensured.profile.deviceId,
          updates
        };
      }
    }

    return {
      ok: true,
      profile: ensured.profile,
      updates
    };
  }

  private inspectCooldown(cookie: string, deviceId: string): DeviceFpResult | undefined {
    let inspection: DeviceFpCooldownInspection;
    try {
      inspection = this.cooldown.inspect(deviceId);
    } catch {
      this.safeRecordFailure(deviceId, 'persist');
      return failureResult(cookie, 'persist', deviceId);
    }
    if (!inspection.active) return undefined;
    return failureResult(cookie, 'cooldown', deviceId, inspection.retryAt);
  }

  private safeRecordFailure(deviceId: string, reason: DeviceFpFailureKind): void {
    try {
      this.cooldown.recordFailure(deviceId, reason);
    } catch {
      // Cooldown persistence must not replace the operation's original classification.
    }
  }

  private safeClearFailure(deviceId: string): void {
    try {
      this.cooldown.clearFailure(deviceId);
    } catch {
      // Replay bookkeeping must not interfere with the caller's request lifecycle.
    }
  }

  private async refreshFingerprint(
    cookie: string,
    profile: StableDeviceProfile,
    persistence: DeviceFpPersistence
  ): Promise<DeviceFpResult> {
    const refreshed = await this.runFingerprintRefresh(profile, persistence);
    if (!refreshed.ok) return failureResult(cookie, refreshed.reason, profile.deviceId);

    return {
      ok: true,
      cookie: mergeDeviceCookies(cookie, { DEVICEFP: refreshed.deviceFp }),
      deviceHash: publicDeviceHash(profile.deviceId),
      refreshed: true
    };
  }

  private runFingerprintRefresh(
    profile: StableDeviceProfile,
    persistence: DeviceFpPersistence
  ): Promise<SharedFingerprintResult> {
    const key = this.scopedProfileKey(
      persistence,
      internalProfileKey(profile.deviceId, profile.seedId, profile.seedTime)
    );
    const current = this.inFlightByDevice.get(key);
    if (current) return current;

    const pending = this.performFingerprintRefresh(profile, key, persistence).finally(() => {
      if (this.inFlightByDevice.get(key) === pending) this.inFlightByDevice.delete(key);
    });
    this.inFlightByDevice.set(key, pending);
    return pending;
  }

  private async performFingerprintRefresh(
    profile: StableDeviceProfile,
    key: string,
    persistence: DeviceFpPersistence
  ): Promise<SharedFingerprintResult> {
    const fetched = await this.requestFingerprint(profile);
    if (!fetched.ok) {
      this.safeRecordFailure(profile.deviceId, fetched.reason);
      return fetched;
    }

    return this.enqueueFingerprintMutation(key, async () => {
      if (persistence === 'partition') {
        try {
          await this.cookieWriter.writeDeviceCookies({ DEVICEFP: fetched.deviceFp });
        } catch {
          this.safeRecordFailure(profile.deviceId, 'persist');
          return { ok: false, reason: 'persist' };
        }
      }

      this.latestFingerprintByDevice.set(key, fetched.deviceFp);
      this.recentRefreshByDevice.set(key, {
        deviceFp: fetched.deviceFp,
        refreshedAt: this.now()
      });
      return fetched;
    });
  }

  private restoreKnownFingerprint(
    profile: StableDeviceProfile,
    profileKey: string,
    requestedFingerprint: string,
    persistence: DeviceFpPersistence
  ): Promise<SharedFingerprintResult> {
    const restoreKey = internalRestoreKey(profileKey, requestedFingerprint);
    const current = this.restoreInFlightByProfile.get(restoreKey);
    if (current) return current;

    const pending = this.enqueueFingerprintMutation<SharedFingerprintResult>(
      profileKey,
      async () => {
        let fingerprintToPersist =
          this.latestFingerprintByDevice.get(profileKey) ?? requestedFingerprint;
        if (persistence === 'memory-only') {
          return { ok: true, deviceFp: fingerprintToPersist };
        }
        while (true) {
          try {
            await this.cookieWriter.writeDeviceCookies({ DEVICEFP: fingerprintToPersist });
          } catch {
            this.safeRecordFailure(profile.deviceId, 'persist');
            return { ok: false, reason: 'persist' };
          }
          const latestFingerprint =
            this.latestFingerprintByDevice.get(profileKey) ?? fingerprintToPersist;
          if (latestFingerprint === fingerprintToPersist) {
            return { ok: true, deviceFp: fingerprintToPersist };
          }
          fingerprintToPersist = latestFingerprint;
        }
      }
    ).finally(() => {
      if (this.restoreInFlightByProfile.get(restoreKey) === pending) {
        this.restoreInFlightByProfile.delete(restoreKey);
      }
    });
    this.restoreInFlightByProfile.set(restoreKey, pending);
    return pending;
  }

  private currentPersistence(explicit?: DeviceFpPersistence): DeviceFpPersistence {
    return explicit ?? this.persistenceScope.getStore() ?? 'partition';
  }

  private scopedProfileKey(persistence: DeviceFpPersistence, profileKey: string): string {
    return `${persistence}:${profileKey}`;
  }

  private enqueueFingerprintMutation<T>(
    profileKey: string,
    mutation: () => Promise<T>
  ): Promise<T> {
    const previous = this.fingerprintMutationTailByProfile.get(profileKey) ?? Promise.resolve();
    const result = previous.then(mutation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.fingerprintMutationTailByProfile.set(profileKey, tail);
    void tail.then(() => {
      if (this.fingerprintMutationTailByProfile.get(profileKey) === tail) {
        this.fingerprintMutationTailByProfile.delete(profileKey);
      }
    });
    return result;
  }

  private async requestFingerprint(profile: StableDeviceProfile): Promise<SharedFingerprintResult> {
    let response: { statusCode: number; bodyText: string };
    try {
      response = await this.transport(buildDeviceFpPayload(profile));
    } catch {
      return { ok: false, reason: 'network' };
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return { ok: false, reason: 'upstream' };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.bodyText);
    } catch {
      return { ok: false, reason: 'schema-drift' };
    }
    if (!isRecord(payload) || payload.retcode !== 0) {
      return { ok: false, reason: 'upstream' };
    }
    const data = payload.data;
    if (!isRecord(data) || data.code !== 200) {
      return { ok: false, reason: 'upstream' };
    }
    const deviceFp = data.device_fp;
    if (typeof deviceFp !== 'string' || !DEVICE_FP_PATTERN.test(deviceFp)) {
      return { ok: false, reason: 'schema-drift' };
    }
    return { ok: true, deviceFp };
  }
}
