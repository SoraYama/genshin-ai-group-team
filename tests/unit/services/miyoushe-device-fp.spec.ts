import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('undici', () => ({
  request: requestMock
}));

import {
  MiyousheDeviceFpService,
  type DeviceFpCooldown,
  type DeviceFpCookieWriter,
  type DeviceFpTransport
} from '../../../src/main/services/miyoushe/device-fp.js';
import type { DeviceFpCooldownInspection } from '../../../src/main/services/miyoushe/device-fp-recovery-store.js';
import {
  buildDeviceFpPayload,
  type DeviceProfileDependencies
} from '../../../src/main/services/miyoushe/device-profile.js';

const NOW = 1_720_000_000_000;
const DEVICE_ID = 'device-id-123';
const SEED_ID = 'seed-id-123';
const SEED_TIME = String(NOW);
const OLD_FP = 'OLDFP1234567';
const NEW_FP = 'NEWFP1234567890';
const SECOND_FP = 'SECOND1234567890';

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function fallbackFp(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 13);
}

function completeCookie(auth = 'auth-token', deviceFp = OLD_FP): string {
  return [
    `ltoken_v2=${auth}`,
    'ltuid_v2=123456789',
    `_MHYUUID=${DEVICE_ID}`,
    `DEVICEFP=${deviceFp}`,
    `DEVICEFP_SEED_ID=${SEED_ID}`,
    `DEVICEFP_SEED_TIME=${SEED_TIME}`
  ].join('; ');
}

function refreshableCookie(auth = 'auth-token'): string {
  return [
    `ltoken_v2=${auth}`,
    'ltuid_v2=123456789',
    `_MHYUUID=${DEVICE_ID}`,
    `DEVICEFP=${OLD_FP}`,
    `DEVICEFP_SEED_ID=${SEED_ID}`,
    `DEVICEFP_SEED_TIME=${SEED_TIME}`
  ].join('; ');
}

function validResponse(deviceFp = NEW_FP): { statusCode: number; bodyText: string } {
  return {
    statusCode: 200,
    bodyText: JSON.stringify({ retcode: 0, data: { code: 200, device_fp: deviceFp } })
  };
}

function fixedProfileDependencies(): DeviceProfileDependencies {
  return {
    now: () => NOW,
    randomUuid: () => DEVICE_ID,
    randomHex: () => SEED_ID
  };
}

function createCooldown(
  inspection: DeviceFpCooldownInspection = { active: false }
): DeviceFpCooldown & {
  inspect: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
  clearFailure: ReturnType<typeof vi.fn>;
} {
  return {
    inspect: vi.fn((_deviceId: string) => inspection),
    recordFailure: vi.fn(),
    clearFailure: vi.fn()
  };
}

function createWriter(): DeviceFpCookieWriter & {
  writeDeviceCookies: ReturnType<typeof vi.fn>;
} {
  return { writeDeviceCookies: vi.fn(async () => undefined) };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('MiyousheDeviceFpService', () => {
  it('reuses a complete four-field profile without IO and preserves authentication', async () => {
    const writer = createWriter();
    const cooldown = createCooldown();
    const transport = vi.fn<DeviceFpTransport>();
    const cookie = completeCookie();
    const service = new MiyousheDeviceFpService({ cookieWriter: writer, cooldown, transport });

    const result = await service.ensureForSession(cookie);

    expect(result).toEqual({
      ok: true,
      cookie,
      deviceHash: shortHash(DEVICE_ID),
      refreshed: false
    });
    expect(result.cookie).toContain('ltoken_v2=auth-token');
    expect(writer.writeDeviceCookies).not.toHaveBeenCalled();
    expect(cooldown.inspect).not.toHaveBeenCalled();
    expect(cooldown.recordFailure).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('persists generated stable fields before getFp, sends the exact payload, then persists only DEVICEFP', async () => {
    const events: string[] = [];
    const writer: DeviceFpCookieWriter = {
      writeDeviceCookies: vi.fn(async (updates: Readonly<Record<string, string>>) => {
        events.push(`write:${Object.keys(updates).join(',')}`);
      })
    };
    const cooldown = createCooldown();
    const expectedPayload = buildDeviceFpPayload({
      deviceId: DEVICE_ID,
      deviceFp: fallbackFp(DEVICE_ID),
      seedId: SEED_ID,
      seedTime: SEED_TIME
    });
    const transport = vi.fn<DeviceFpTransport>(async (payload) => {
      events.push('transport');
      expect(payload).toEqual(expectedPayload);
      return validResponse();
    });
    const service = new MiyousheDeviceFpService({
      cookieWriter: writer,
      cooldown,
      transport,
      profileDependencies: fixedProfileDependencies()
    });

    const result = await service.ensureForSession(
      'ltoken_v2=auth-token; ltuid_v2=123456789; ltmid_v2=member-token'
    );

    expect(events).toEqual([
      'write:_MHYUUID,DEVICEFP_SEED_ID,DEVICEFP_SEED_TIME',
      'transport',
      'write:DEVICEFP'
    ]);
    expect(writer.writeDeviceCookies).toHaveBeenNthCalledWith(1, {
      _MHYUUID: DEVICE_ID,
      DEVICEFP_SEED_ID: SEED_ID,
      DEVICEFP_SEED_TIME: SEED_TIME
    });
    expect(writer.writeDeviceCookies).toHaveBeenNthCalledWith(2, { DEVICEFP: NEW_FP });
    expect(result).toMatchObject({
      ok: true,
      deviceHash: shortHash(DEVICE_ID),
      refreshed: true
    });
    expect(result.cookie).toContain('ltoken_v2=auth-token');
    expect(result.cookie).toContain('ltuid_v2=123456789');
    expect(result.cookie).toContain('ltmid_v2=member-token');
    expect(result.cookie).toContain(`_MHYUUID=${DEVICE_ID}`);
    expect(result.cookie).toContain(`DEVICEFP=${NEW_FP}`);
    expect(result.cookie).toContain(`DEVICEFP_SEED_ID=${SEED_ID}`);
    expect(result.cookie).toContain(`DEVICEFP_SEED_TIME=${SEED_TIME}`);
  });

  it('uses the controlled default undici transport without reading a JSON helper', async () => {
    const text = vi.fn(async () => validResponse().bodyText);
    requestMock.mockResolvedValueOnce({ statusCode: 200, body: { text } });
    const writer = createWriter();
    const cooldown = createCooldown();
    const service = new MiyousheDeviceFpService({ cookieWriter: writer, cooldown });
    const cookie = [
      'ltoken_v2=auth-token',
      `_MHYUUID=${DEVICE_ID}`,
      `DEVICEFP_SEED_ID=${SEED_ID}`,
      `DEVICEFP_SEED_TIME=${SEED_TIME}`
    ].join('; ');
    const expectedPayload = buildDeviceFpPayload({
      deviceId: DEVICE_ID,
      deviceFp: fallbackFp(DEVICE_ID),
      seedId: SEED_ID,
      seedTime: SEED_TIME
    });

    await expect(service.ensureForSession(cookie)).resolves.toMatchObject({
      ok: true,
      refreshed: true
    });

    expect(requestMock).toHaveBeenCalledWith(
      'https://public-data-api.mihoyo.com/device-fp/api/getFp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(expectedPayload),
        bodyTimeout: 8_000,
        headersTimeout: 8_000
      }
    );
    expect(text).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'network throw',
      expected: 'network' as const,
      secret: 'secret-network-message',
      response: async () => {
        throw new Error('secret-network-message');
      }
    },
    {
      name: 'non-2xx status',
      expected: 'upstream' as const,
      secret: 'secret-upstream-body',
      response: async () => ({ statusCode: 503, bodyText: 'secret-upstream-body' })
    },
    {
      name: 'non-JSON body',
      expected: 'schema-drift' as const,
      secret: 'secret-non-json-body',
      response: async () => ({ statusCode: 200, bodyText: 'secret-non-json-body' })
    },
    {
      name: 'nonzero retcode',
      expected: 'upstream' as const,
      secret: 'secret-retcode-message',
      response: async () => ({
        statusCode: 200,
        bodyText: JSON.stringify({ retcode: -1, message: 'secret-retcode-message' })
      })
    },
    {
      name: 'non-200 data code',
      expected: 'upstream' as const,
      secret: 'secret-data-code-message',
      response: async () => ({
        statusCode: 200,
        bodyText: JSON.stringify({
          retcode: 0,
          data: { code: 500, message: 'secret-data-code-message' }
        })
      })
    },
    {
      name: 'invalid fingerprint',
      expected: 'schema-drift' as const,
      secret: 'invalid-fp-secret!',
      response: async () => ({
        statusCode: 200,
        bodyText: JSON.stringify({
          retcode: 0,
          data: { code: 200, device_fp: 'invalid-fp-secret!' }
        })
      })
    }
  ])(
    'classifies $name without exposing upstream secrets',
    async ({ expected, secret, response }) => {
      const writer = createWriter();
      const cooldown = createCooldown();
      const transport = vi.fn<DeviceFpTransport>(response);
      const service = new MiyousheDeviceFpService({ cookieWriter: writer, cooldown, transport });
      const cookie = [
        'ltoken_v2=private-auth-token',
        `_MHYUUID=${DEVICE_ID}`,
        `DEVICEFP_SEED_ID=${SEED_ID}`,
        `DEVICEFP_SEED_TIME=${SEED_TIME}`
      ].join('; ');

      const result = await service.ensureForSession(cookie);

      expect(result).toMatchObject({
        ok: false,
        cookie,
        deviceHash: shortHash(DEVICE_ID),
        reason: expected
      });
      expect(cooldown.recordFailure).toHaveBeenCalledWith(DEVICE_ID, expected);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  );

  it('classifies final DEVICEFP persistence failure and does not cache the unpersisted value', async () => {
    const writer: DeviceFpCookieWriter = {
      writeDeviceCookies: vi.fn(async () => {
        throw new Error('secret-persist-message');
      })
    };
    const cooldown = createCooldown();
    const transport = vi.fn<DeviceFpTransport>(async () => validResponse());
    const service = new MiyousheDeviceFpService({ cookieWriter: writer, cooldown, transport });
    const cookie = [
      'ltoken_v2=auth-token',
      `_MHYUUID=${DEVICE_ID}`,
      `DEVICEFP_SEED_ID=${SEED_ID}`,
      `DEVICEFP_SEED_TIME=${SEED_TIME}`
    ].join('; ');

    const result = await service.ensureForSession(cookie);

    expect(result).toMatchObject({
      ok: false,
      cookie,
      deviceHash: shortHash(DEVICE_ID),
      reason: 'persist'
    });
    expect(cooldown.recordFailure).toHaveBeenCalledWith(DEVICE_ID, 'persist');
    expect(service.applyKnownFingerprint(completeCookie('auth-token', OLD_FP))).toBe(
      completeCookie('auth-token', OLD_FP)
    );
    expect(JSON.stringify(result)).not.toContain('secret-persist-message');
  });

  it('returns an active cooldown with retryAt without contacting getFp', async () => {
    const retryAt = NOW + 60_000;
    const writer = createWriter();
    const cooldown = createCooldown({ active: true, retryAt, reason: 'network' });
    const transport = vi.fn<DeviceFpTransport>();
    const service = new MiyousheDeviceFpService({ cookieWriter: writer, cooldown, transport });
    const cookie = [
      'ltoken_v2=auth-token',
      `_MHYUUID=${DEVICE_ID}`,
      `DEVICEFP_SEED_ID=${SEED_ID}`,
      `DEVICEFP_SEED_TIME=${SEED_TIME}`
    ].join('; ');

    await expect(service.ensureForSession(cookie)).resolves.toEqual({
      ok: false,
      cookie,
      deviceHash: shortHash(DEVICE_ID),
      reason: 'cooldown',
      retryAt
    });
    expect(cooldown.inspect).toHaveBeenCalledWith(DEVICE_ID);
    expect(transport).not.toHaveBeenCalled();
    expect(writer.writeDeviceCookies).not.toHaveBeenCalled();
  });

  it('single-flights concurrent recovery by device without sharing either caller Cookie', async () => {
    let resolveTransport: ((value: { statusCode: number; bodyText: string }) => void) | undefined;
    const transport = vi.fn<DeviceFpTransport>(
      () =>
        new Promise((resolve) => {
          resolveTransport = resolve;
        })
    );
    const writer = createWriter();
    const cooldown = createCooldown();
    const service = new MiyousheDeviceFpService({ cookieWriter: writer, cooldown, transport });
    const cookieA = refreshableCookie('account-a-secret');
    const cookieB = refreshableCookie('account-b-secret');

    const resultAPromise = service.recoverFrom5003(cookieA);
    const resultBPromise = service.recoverFrom5003(cookieB);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    resolveTransport?.(validResponse());

    const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);
    expect(resultA).toMatchObject({ ok: true, refreshed: true });
    expect(resultB).toMatchObject({ ok: true, refreshed: true });
    expect(resultA.cookie).toContain('ltoken_v2=account-a-secret');
    expect(resultA.cookie).not.toContain('account-b-secret');
    expect(resultB.cookie).toContain('ltoken_v2=account-b-secret');
    expect(resultB.cookie).not.toContain('account-a-secret');
    expect(resultA.cookie).toContain(`DEVICEFP=${NEW_FP}`);
    expect(resultB.cookie).toContain(`DEVICEFP=${NEW_FP}`);
    expect(writer.writeDeviceCookies).toHaveBeenCalledTimes(2);
    expect(writer.writeDeviceCookies).toHaveBeenNthCalledWith(1, { DEVICEFP: NEW_FP });
    expect(writer.writeDeviceCookies).toHaveBeenNthCalledWith(2, { DEVICEFP: NEW_FP });
  });

  it('reuses a just-refreshed fingerprint for five minutes and refreshes again at the boundary', async () => {
    let now = NOW;
    const transport = vi
      .fn<DeviceFpTransport>()
      .mockResolvedValueOnce(validResponse(NEW_FP))
      .mockResolvedValueOnce(validResponse(SECOND_FP));
    const writer = createWriter();
    const cooldown = createCooldown();
    const service = new MiyousheDeviceFpService({
      cookieWriter: writer,
      cooldown,
      transport,
      now: () => now
    });
    const cookie = [
      'ltoken_v2=auth-token',
      `_MHYUUID=${DEVICE_ID}`,
      `DEVICEFP_SEED_ID=${SEED_ID}`,
      `DEVICEFP_SEED_TIME=${SEED_TIME}`
    ].join('; ');

    const ensured = await service.ensureForSession(cookie);
    expect(ensured).toMatchObject({ ok: true, refreshed: true });
    now += 5 * 60_000 - 1;
    const recentRecovery = await service.recoverFrom5003(ensured.cookie);
    expect(recentRecovery).toMatchObject({ ok: true, refreshed: false });
    expect(recentRecovery.cookie).toContain(`DEVICEFP=${NEW_FP}`);
    expect(transport).toHaveBeenCalledTimes(1);

    now = NOW + 5 * 60_000;
    const boundaryRecovery = await service.recoverFrom5003(ensured.cookie);
    expect(boundaryRecovery).toMatchObject({ ok: true, refreshed: true });
    expect(boundaryRecovery.cookie).toContain(`DEVICEFP=${SECOND_FP}`);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('overwrites a stale known-device fingerprint but leaves unknown or ID-less Cookies unchanged', async () => {
    const writer = createWriter();
    const cooldown = createCooldown();
    const transport = vi.fn<DeviceFpTransport>(async () => validResponse());
    const service = new MiyousheDeviceFpService({ cookieWriter: writer, cooldown, transport });
    const cookieWithoutFp = [
      'ltoken_v2=auth-token',
      `_MHYUUID=${DEVICE_ID}`,
      `DEVICEFP_SEED_ID=${SEED_ID}`,
      `DEVICEFP_SEED_TIME=${SEED_TIME}`
    ].join('; ');
    await service.ensureForSession(cookieWithoutFp);

    expect(service.applyKnownFingerprint(completeCookie('auth-token', OLD_FP))).toBe(
      completeCookie('auth-token', NEW_FP)
    );
    const unknown = completeCookie('other-auth', OLD_FP).replace(DEVICE_ID, 'unknown-device');
    expect(service.applyKnownFingerprint(unknown)).toBe(unknown);
    const idless = 'ltoken_v2=auth-token; DEVICEFP=stale-fp';
    expect(service.applyKnownFingerprint(idless)).toBe(idless);
  });

  it('finishes replay by clearing success, recording 5003, and ignoring other outcomes', () => {
    const writer = createWriter();
    const cooldown = createCooldown();
    const service = new MiyousheDeviceFpService({ cookieWriter: writer, cooldown });
    const cookie = completeCookie('private-auth-token');

    service.finishReplay(cookie, 'success');
    service.finishReplay(cookie, '5003');
    service.finishReplay(cookie, 'other-error');
    service.finishReplay('ltoken_v2=private-auth-token', 'success');

    expect(cooldown.clearFailure).toHaveBeenCalledTimes(1);
    expect(cooldown.clearFailure).toHaveBeenCalledWith(DEVICE_ID);
    expect(cooldown.recordFailure).toHaveBeenCalledTimes(1);
    expect(cooldown.recordFailure).toHaveBeenCalledWith(DEVICE_ID, 'upstream');
  });

  it('never throws if cooldown persistence fails while finishing replay', () => {
    const cooldown: DeviceFpCooldown = {
      inspect: () => ({ active: false }),
      recordFailure: () => {
        throw new Error('private-record-error');
      },
      clearFailure: () => {
        throw new Error('private-clear-error');
      }
    };
    const service = new MiyousheDeviceFpService({ cookieWriter: createWriter(), cooldown });

    expect(() => service.finishReplay(completeCookie('private-auth'), 'success')).not.toThrow();
    expect(() => service.finishReplay(completeCookie('private-auth'), '5003')).not.toThrow();
  });

  it('classifies profile construction exceptions without exposing them and records a known device', async () => {
    const writer = createWriter();
    const cooldown = createCooldown();
    const transport = vi.fn<DeviceFpTransport>();
    const service = new MiyousheDeviceFpService({
      cookieWriter: writer,
      cooldown,
      transport,
      profileDependencies: {
        now: () => NOW,
        randomUuid: () => {
          throw new Error('unexpected UUID generation');
        },
        randomHex: () => {
          throw new Error('secret-profile-message');
        }
      }
    });
    const cookie = `ltoken_v2=private-auth-token; _MHYUUID=${DEVICE_ID}`;

    const result = await service.ensureForSession(cookie);

    expect(result).toEqual({
      ok: false,
      cookie,
      deviceHash: shortHash(DEVICE_ID),
      reason: 'profile-invalid'
    });
    expect(cooldown.recordFailure).toHaveBeenCalledWith(DEVICE_ID, 'profile-invalid');
    expect(writer.writeDeviceCookies).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret-profile-message');
  });

  it('contains invalid runtime profile values as profile-invalid instead of rejecting', async () => {
    const writer = createWriter();
    const cooldown = createCooldown();
    const transport = vi.fn<DeviceFpTransport>();
    const service = new MiyousheDeviceFpService({
      cookieWriter: writer,
      cooldown,
      transport,
      profileDependencies: {
        now: () => NOW,
        randomUuid: () => Symbol('secret-invalid-profile') as unknown as string,
        randomHex: () => SEED_ID
      }
    });
    const cookie = [
      'ltoken_v2=private-auth-token',
      `DEVICEFP=${OLD_FP}`,
      `DEVICEFP_SEED_ID=${SEED_ID}`,
      `DEVICEFP_SEED_TIME=${SEED_TIME}`
    ].join('; ');

    await expect(service.ensureForSession(cookie)).resolves.toEqual({
      ok: false,
      cookie,
      reason: 'profile-invalid'
    });
    expect(cooldown.recordFailure).not.toHaveBeenCalled();
    expect(writer.writeDeviceCookies).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('stops after initial profile persistence fails', async () => {
    const writer: DeviceFpCookieWriter = {
      writeDeviceCookies: vi.fn(async () => {
        throw new Error('secret-initial-persist-message');
      })
    };
    const cooldown = createCooldown();
    const transport = vi.fn<DeviceFpTransport>();
    const service = new MiyousheDeviceFpService({
      cookieWriter: writer,
      cooldown,
      transport,
      profileDependencies: fixedProfileDependencies()
    });
    const input = 'ltoken_v2=private-auth-token; ltuid_v2=123456789';

    const result = await service.ensureForSession(input);

    expect(result).toMatchObject({
      ok: false,
      deviceHash: shortHash(DEVICE_ID),
      reason: 'persist'
    });
    expect(result.cookie).toContain('ltoken_v2=private-auth-token');
    expect(cooldown.recordFailure).toHaveBeenCalledWith(DEVICE_ID, 'persist');
    expect(transport).not.toHaveBeenCalled();
    expect(service.applyKnownFingerprint(input)).toBe(input);
    expect(JSON.stringify(result)).not.toContain('secret-initial-persist-message');
  });
});
