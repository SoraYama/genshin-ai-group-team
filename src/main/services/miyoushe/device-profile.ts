import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const DEVICE_COOKIE_NAMES = [
  '_MHYUUID',
  'DEVICEFP',
  'DEVICEFP_SEED_ID',
  'DEVICEFP_SEED_TIME'
] as const;

export type MiyousheDeviceCookieName = (typeof DEVICE_COOKIE_NAMES)[number];
export type DeviceCookieUpdates = Partial<Record<MiyousheDeviceCookieName, string>>;

export interface StableDeviceProfile {
  deviceId: string;
  deviceFp: string;
  seedId: string;
  seedTime: string;
}

export interface DeviceProfileDependencies {
  now: () => number;
  randomUuid: () => string;
  randomHex: () => string;
}

const DEFAULT_DEPENDENCIES: DeviceProfileDependencies = {
  now: Date.now,
  randomUuid: randomUUID,
  randomHex: () => randomBytes(16).toString('hex')
};

function parseCookies(cookie: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) values.set(name, value);
  }
  return values;
}

function present(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function ensureStableDeviceProfile(
  cookie: string,
  deps: DeviceProfileDependencies = DEFAULT_DEPENDENCIES
): { profile: StableDeviceProfile; updates: DeviceCookieUpdates } {
  const cookies = parseCookies(cookie);
  const updates: DeviceCookieUpdates = {};

  const deviceId = cookies.get('_MHYUUID');
  const resolvedDeviceId = present(deviceId) ? deviceId : deps.randomUuid();
  if (!present(deviceId)) updates._MHYUUID = resolvedDeviceId;

  const deviceFp = cookies.get('DEVICEFP');
  const resolvedDeviceFp = present(deviceFp) ? deviceFp : sha256(resolvedDeviceId).slice(0, 13);

  const seedId = cookies.get('DEVICEFP_SEED_ID');
  const resolvedSeedId = present(seedId) ? seedId : deps.randomHex();
  if (!present(seedId)) updates.DEVICEFP_SEED_ID = resolvedSeedId;

  const seedTime = cookies.get('DEVICEFP_SEED_TIME');
  const resolvedSeedTime = present(seedTime) ? seedTime : String(deps.now());
  if (!present(seedTime)) updates.DEVICEFP_SEED_TIME = resolvedSeedTime;

  return {
    profile: {
      deviceId: resolvedDeviceId,
      deviceFp: resolvedDeviceFp,
      seedId: resolvedSeedId,
      seedTime: resolvedSeedTime
    },
    updates
  };
}

export function mergeDeviceCookies(cookie: string, updates: DeviceCookieUpdates): string {
  const replaced = new Set<MiyousheDeviceCookieName>();
  const merged = cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return part;
      const name = part.slice(0, separator).trim() as MiyousheDeviceCookieName;
      const value = updates[name];
      if (value === undefined || !(DEVICE_COOKIE_NAMES as readonly string[]).includes(name)) {
        return part;
      }
      replaced.add(name);
      return `${name}=${value}`;
    });

  for (const name of DEVICE_COOKIE_NAMES) {
    const value = updates[name];
    if (value !== undefined && !replaced.has(name)) merged.push(`${name}=${value}`);
  }

  return merged.join('; ');
}

export function buildDeviceFpPayload(profile: StableDeviceProfile): {
  device_id: string;
  seed_id: string;
  seed_time: string;
  platform: '2';
  device_fp: string;
  app_name: 'bbs_cn';
  ext_fields: string;
} {
  const fingerprint = sha256(profile.deviceId);
  const deviceSuffix = fingerprint.slice(0, 12);
  const extFields = {
    cpuType: 'arm64-v8a',
    romCapacity: '128',
    productName: `M2102J20SC-${deviceSuffix}`,
    romRemain: '64',
    manufacturer: 'Xiaomi',
    appMemory: '512',
    hostname: `android-${fingerprint.slice(12, 24)}`,
    screenSize: '1080x2400',
    osVersion: '12',
    aaid: fingerprint.slice(0, 32),
    vendor: 'Xiaomi',
    accelerometer: 'LSM6DSM Acceleration Sensor',
    buildTags: 'release-keys',
    model: `M2102J20SC-${fingerprint.slice(24, 32)}`,
    brand: 'Xiaomi',
    oaid: fingerprint.slice(8, 40),
    hardware: 'qcom',
    deviceType: 'phone',
    devId: profile.deviceId,
    serialNumber: fingerprint.slice(40, 56),
    buildTime: '1646092800000',
    buildUser: 'builder',
    ramCapacity: '8',
    magnetometer: 'AKM AK09918C Magnetometer',
    display: 'SKQ1.211006.001',
    ramRemain: '4',
    deviceInfo: `Xiaomi/${fingerprint.slice(0, 8)}`,
    gyroscope: 'LSM6DSM Gyroscope Sensor',
    vaid: fingerprint.slice(16, 48),
    buildType: 'user',
    sdkVersion: '31',
    board: 'kona'
  };

  return {
    device_id: profile.deviceId,
    seed_id: profile.seedId,
    seed_time: profile.seedTime,
    platform: '2',
    device_fp: profile.deviceFp,
    app_name: 'bbs_cn',
    ext_fields: JSON.stringify(extFields)
  };
}
