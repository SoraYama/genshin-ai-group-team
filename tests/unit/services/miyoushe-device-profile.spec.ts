import { describe, expect, it } from 'vitest';
import {
  buildDeviceFpPayload,
  ensureStableDeviceProfile,
  mergeDeviceCookies
} from '../../../src/main/services/miyoushe/device-profile.js';

const REQUIRED_EXT_FIELDS = [
  'cpuType',
  'romCapacity',
  'productName',
  'romRemain',
  'manufacturer',
  'appMemory',
  'hostname',
  'screenSize',
  'osVersion',
  'aaid',
  'vendor',
  'accelerometer',
  'buildTags',
  'model',
  'brand',
  'oaid',
  'hardware',
  'deviceType',
  'devId',
  'serialNumber',
  'buildTime',
  'buildUser',
  'ramCapacity',
  'magnetometer',
  'display',
  'ramRemain',
  'deviceInfo',
  'gyroscope',
  'vaid',
  'buildType',
  'sdkVersion',
  'board'
] as const;

describe('stable Miyoushe device profiles', () => {
  it('reuses a complete device profile without calling generators', () => {
    const fail = (): never => {
      throw new Error('generator must not be called');
    };
    const cookie = [
      'ltoken_v2=auth-token',
      '_MHYUUID=existing-device',
      'DEVICEFP=existing-fp',
      'DEVICEFP_SEED_ID=existing-seed',
      'DEVICEFP_SEED_TIME=1715000000000'
    ].join('; ');

    expect(
      ensureStableDeviceProfile(cookie, { now: fail, randomUuid: fail, randomHex: fail })
    ).toEqual({
      profile: {
        deviceId: 'existing-device',
        deviceFp: 'existing-fp',
        seedId: 'existing-seed',
        seedTime: '1715000000000'
      },
      updates: {}
    });
  });

  it('adds only missing stable fields and preserves auth cookies after merging', () => {
    const cookie = 'ltoken_v2=auth-token; ltuid_v2=123456789; ltmid_v2=member-token';
    const ensured = ensureStableDeviceProfile(cookie, {
      now: () => 1_715_000_000_000,
      randomUuid: () => 'generated-device-id',
      randomHex: () => 'generated-seed-id'
    });

    expect(ensured.profile).toEqual({
      deviceId: 'generated-device-id',
      deviceFp: expect.stringMatching(/^[a-f0-9]{13}$/),
      seedId: 'generated-seed-id',
      seedTime: '1715000000000'
    });
    expect(ensured.updates).toEqual({
      _MHYUUID: 'generated-device-id',
      DEVICEFP_SEED_ID: 'generated-seed-id',
      DEVICEFP_SEED_TIME: '1715000000000'
    });

    const merged = mergeDeviceCookies(cookie, ensured.updates);
    expect(merged).toContain('ltoken_v2=auth-token');
    expect(merged).toContain('ltuid_v2=123456789');
    expect(merged).toContain('ltmid_v2=member-token');
    expect(ensureStableDeviceProfile(merged).updates).toEqual({});
  });

  it('builds a deterministic UIGF-shaped Android device-fingerprint payload', () => {
    const profile = {
      deviceId: 'device-123',
      deviceFp: 'fingerprint-123',
      seedId: 'seed-123',
      seedTime: '1715000000000'
    };

    const first = buildDeviceFpPayload(profile);
    const second = buildDeviceFpPayload(profile);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      device_id: 'device-123',
      seed_id: 'seed-123',
      seed_time: '1715000000000',
      platform: '2',
      device_fp: 'fingerprint-123',
      app_name: 'bbs_cn'
    });
    const extFields: unknown = JSON.parse(first.ext_fields);
    expect(extFields).toEqual(
      expect.objectContaining(
        Object.fromEntries(REQUIRED_EXT_FIELDS.map((key) => [key, expect.any(String)]))
      )
    );
    expect(first.ext_fields).not.toContain('auth-token');
  });
});
