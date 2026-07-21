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
const DEFAULT_RECENT_REFRESH_MS = 5 * 60_000;
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

function parseCookies(cookie: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) values.set(name, value);
  }
  return values;
}

function fullDeviceHash(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

function publicDeviceHash(deviceId: string): string {
  return fullDeviceHash(deviceId).slice(0, 12);
}

function hasCompleteDeviceProfile(cookie: string): boolean {
  const cookies = parseCookies(cookie);
  return REQUIRED_DEVICE_COOKIES.every((name) => cookies.has(name));
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
    headersTimeout: REQUEST_TIMEOUT_MS
  });
  return { statusCode: response.statusCode, bodyText: await response.body.text() };
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
    this.recentRefreshMs = options.recentRefreshMs ?? DEFAULT_RECENT_REFRESH_MS;
  }

  applyKnownFingerprint(cookie: string): string {
    const cookies = parseCookies(cookie);
    const deviceId = cookies.get('_MHYUUID');
    if (!deviceId) return cookie;

    const knownFingerprint = this.latestFingerprintByDevice.get(fullDeviceHash(deviceId));
    if (!knownFingerprint || cookies.get('DEVICEFP') === knownFingerprint) return cookie;
    return mergeDeviceCookies(cookie, { DEVICEFP: knownFingerprint });
  }

  async ensureForSession(cookie: string): Promise<DeviceFpResult> {
    const appliedCookie = this.applyKnownFingerprint(cookie);
    const prepared = await this.prepareProfile(appliedCookie);
    if (!prepared.ok) return prepared.result;

    const { cookie: preparedCookie, profile, wasComplete } = prepared.value;
    if (wasComplete) {
      this.latestFingerprintByDevice.set(fullDeviceHash(profile.deviceId), profile.deviceFp);
      return {
        ok: true,
        cookie: preparedCookie,
        deviceHash: publicDeviceHash(profile.deviceId),
        refreshed: false
      };
    }

    const cooldownResult = this.inspectCooldown(preparedCookie, profile.deviceId);
    if (cooldownResult) return cooldownResult;
    return this.refreshFingerprint(preparedCookie, profile);
  }

  async recoverFrom5003(cookie: string): Promise<DeviceFpResult> {
    const appliedCookie = this.applyKnownFingerprint(cookie);
    const prepared = await this.prepareProfile(appliedCookie);
    if (!prepared.ok) return prepared.result;

    const { cookie: preparedCookie, profile } = prepared.value;
    const cooldownResult = this.inspectCooldown(preparedCookie, profile.deviceId);
    if (cooldownResult) return cooldownResult;

    const recent = this.recentRefreshByDevice.get(fullDeviceHash(profile.deviceId));
    if (recent && this.now() - recent.refreshedAt < this.recentRefreshMs) {
      return {
        ok: true,
        cookie: mergeDeviceCookies(preparedCookie, { DEVICEFP: recent.deviceFp }),
        deviceHash: publicDeviceHash(profile.deviceId),
        refreshed: false
      };
    }

    return this.refreshFingerprint(preparedCookie, profile);
  }

  finishReplay(cookie: string, outcome: 'success' | '5003' | 'other-error'): void {
    try {
      const deviceId = parseCookies(cookie).get('_MHYUUID');
      if (!deviceId || outcome === 'other-error') return;
      if (outcome === 'success') {
        this.cooldown.clearFailure(deviceId);
      } else {
        this.cooldown.recordFailure(deviceId, 'upstream');
      }
    } catch {
      // Replay bookkeeping must never interfere with the caller's request lifecycle.
    }
  }

  private async prepareProfile(
    cookie: string
  ): Promise<{ ok: true; value: PreparedProfile } | { ok: false; result: DeviceFpResult }> {
    const knownDeviceId = parseCookies(cookie).get('_MHYUUID');
    let ensured: ReturnType<typeof ensureStableDeviceProfile>;
    let mergedCookie: string;
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
      mergedCookie = mergeDeviceCookies(cookie, ensured.updates);
    } catch {
      if (recordableDeviceId) this.cooldown.recordFailure(recordableDeviceId, 'profile-invalid');
      return {
        ok: false,
        result: failureResult(cookie, 'profile-invalid', recordableDeviceId)
      };
    }

    const wasComplete = hasCompleteDeviceProfile(cookie);
    if (Object.keys(ensured.updates).length > 0) {
      try {
        await this.cookieWriter.writeDeviceCookies(ensured.updates);
      } catch {
        this.cooldown.recordFailure(ensured.profile.deviceId, 'persist');
        return {
          ok: false,
          result: failureResult(mergedCookie, 'persist', ensured.profile.deviceId)
        };
      }
    }

    return {
      ok: true,
      value: { cookie: mergedCookie, profile: ensured.profile, wasComplete }
    };
  }

  private inspectCooldown(cookie: string, deviceId: string): DeviceFpResult | undefined {
    const inspection = this.cooldown.inspect(deviceId);
    if (!inspection.active) return undefined;
    return failureResult(cookie, 'cooldown', deviceId, inspection.retryAt);
  }

  private async refreshFingerprint(
    cookie: string,
    profile: StableDeviceProfile
  ): Promise<DeviceFpResult> {
    const fetched = await this.fetchFingerprint(profile);
    if (!fetched.ok) {
      this.cooldown.recordFailure(profile.deviceId, fetched.reason);
      return failureResult(cookie, fetched.reason, profile.deviceId);
    }

    const updates: DeviceCookieUpdates = { DEVICEFP: fetched.deviceFp };
    try {
      await this.cookieWriter.writeDeviceCookies(updates);
    } catch {
      this.cooldown.recordFailure(profile.deviceId, 'persist');
      return failureResult(cookie, 'persist', profile.deviceId);
    }

    const key = fullDeviceHash(profile.deviceId);
    this.latestFingerprintByDevice.set(key, fetched.deviceFp);
    this.recentRefreshByDevice.set(key, {
      deviceFp: fetched.deviceFp,
      refreshedAt: this.now()
    });
    return {
      ok: true,
      cookie: mergeDeviceCookies(cookie, updates),
      deviceHash: publicDeviceHash(profile.deviceId),
      refreshed: true
    };
  }

  private fetchFingerprint(profile: StableDeviceProfile): Promise<SharedFingerprintResult> {
    const key = fullDeviceHash(profile.deviceId);
    const current = this.inFlightByDevice.get(key);
    if (current) return current;

    const pending = this.requestFingerprint(profile).finally(() => {
      if (this.inFlightByDevice.get(key) === pending) this.inFlightByDevice.delete(key);
    });
    this.inFlightByDevice.set(key, pending);
    return pending;
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
