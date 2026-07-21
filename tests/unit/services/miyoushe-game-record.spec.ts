import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_TYPE_WEB, resolveSalt } from '../../../src/main/services/miyoushe/ds-token.js';

const requestMock = vi.fn();

vi.mock('undici', () => ({
  request: requestMock
}));

function mockJson(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return {
    statusCode: status,
    headers,
    body: { text: async () => JSON.stringify(payload) }
  };
}

function mockText(status: number, text: string) {
  return {
    statusCode: status,
    body: { text: async () => text }
  };
}

function mockBrowserJson(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return {
    statusCode: status,
    headers,
    bodyText: JSON.stringify(payload)
  };
}

function expectValidDs(header: unknown, query: string, body: string): string {
  expect(typeof header).toBe('string');
  const value = String(header);
  const [timestamp, nonce, digest] = value.split(',');
  expect(timestamp).toMatch(/^\d+$/);
  expect(nonce).toMatch(/^\d{6}$/);
  expect(digest).toBe(
    createHash('md5')
      .update(`salt=${resolveSalt(CLIENT_TYPE_WEB)}&t=${timestamp}&r=${nonce}&b=${body}&q=${query}`)
      .digest('hex')
  );
  return value;
}

const OLD_FP = 'old-device-fingerprint';
const NEW_FP = 'new-device-fingerprint';
const OLD_COOKIE = [
  'ltoken_v2=private-auth-token',
  '_MHYUUID=device-id',
  `DEVICEFP=${OLD_FP}`,
  'DEVICEFP_SEED_ID=seed-id',
  'DEVICEFP_SEED_TIME=1700000000'
].join('; ');
const NEW_COOKIE = OLD_COOKIE.replace(`DEVICEFP=${OLD_FP}`, `DEVICEFP=${NEW_FP}`);

const indexSuccess = {
  retcode: 0,
  data: {
    role: { nickname: 'Traveler' },
    stats: { world_level: 9, avatar_number: 80 }
  }
};

const list = [
  {
    id: 10000046,
    name: 'Character A',
    element: 'Pyro',
    level: 90,
    rarity: 5,
    icon: 'icon-a.png',
    actived_constellation_num: 1,
    fetter: 10
  },
  {
    id: 10000037,
    name: 'Character B',
    element: 'Cryo',
    level: 80,
    rarity: 5,
    icon: 'icon-b.png',
    actived_constellation_num: 0,
    fetter: 8
  }
];

beforeEach(() => {
  requestMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('regionFromUid', () => {
  it('maps UID prefixes to expected servers', async () => {
    const { regionFromUid } = await import('../../../src/main/services/miyoushe-game-record.js');
    expect(regionFromUid('100000001').region).toBe('cn_gf01');
    expect(regionFromUid('500000001').region).toBe('cn_qd01');
    expect(regionFromUid('600000001')).toEqual({ region: 'os_usa', isGlobal: true });
    expect(regionFromUid('700000001')).toEqual({ region: 'os_euro', isGlobal: true });
    expect(regionFromUid('800000001')).toEqual({ region: 'os_asia', isGlobal: true });
    expect(regionFromUid('900000001')).toEqual({ region: 'os_cht', isGlobal: true });
  });
});

describe('deviceHeadersFromCookie', () => {
  it('uses only a complete device id/fingerprint pair from the same cookie context', async () => {
    const { deviceHeadersFromCookie } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    expect(
      deviceHeadersFromCookie('ltoken_v2=token; _MHYUUID=device-id; DEVICEFP=device-fingerprint')
    ).toEqual({
      'x-rpc-device_id': 'device-id',
      'x-rpc-device_fp': 'device-fingerprint'
    });
    expect(deviceHeadersFromCookie('ltoken_v2=token; _MHYUUID=device-id')).toEqual({});
    expect(deviceHeadersFromCookie('ltoken_v2=token; DEVICEFP=device-fingerprint')).toEqual({});
  });
});

describe('Chromium transport fallback', () => {
  it('retries retcode 1034 once through the browser session', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(
      mockJson(
        200,
        { retcode: 1034, message: '访问异常，请稍后重试' },
        { 'x-trace-id': 'node-risk-trace' }
      )
    );
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const client = new MiyousheGameRecordClient({ browserTransport });

    await expect(client.ping('100000001', 'cookie=valid-enough')).resolves.toEqual({
      ok: true,
      data: {
        nickname: 'Traveler',
        worldLevel: 9,
        activeDays: undefined,
        totalCharacters: 80
      }
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(browserTransport.mock.calls[0]?.[1].headers).toHaveProperty('DS');
  });
});

describe('device fingerprint application boundaries', () => {
  it.each([
    ['ping', indexSuccess],
    ['fetchDetailedRoster', { retcode: 0, data: { list: [] } }]
  ] as const)(
    'falls back to the original cookie when apply throws during %s',
    async (api, payload) => {
      const { MiyousheGameRecordClient } =
        await import('../../../src/main/services/miyoushe-game-record.js');
      requestMock.mockResolvedValueOnce(mockJson(200, payload));
      const deviceFp = {
        applyKnownFingerprint: vi.fn(() => {
          throw new Error('secret device fingerprint material');
        }),
        recoverFrom5003: vi.fn(),
        finishReplay: vi.fn()
      };
      const client = new MiyousheGameRecordClient({ deviceFp });

      const pending =
        api === 'ping'
          ? client.ping('100000001', OLD_COOKIE)
          : client.fetchDetailedRoster('100000001', OLD_COOKIE);
      await expect(pending).resolves.toMatchObject({ ok: true });
      const result = await pending;

      expect(JSON.stringify(result)).not.toContain('secret device fingerprint material');
      expect(deviceFp.applyKnownFingerprint).toHaveBeenCalledTimes(1);
      expect(deviceFp.recoverFrom5003).not.toHaveBeenCalled();
      const headers = (requestMock.mock.calls[0]?.[1] as { headers: Record<string, string> })
        .headers;
      expect(headers.cookie).toBe(OLD_COOKIE);
    }
  );
});

describe('CN 5003 device fingerprint recovery', () => {
  it('enters a gate cooldown after a detail replay remains 5003 and skips the next roster replay', async () => {
    const { MiyousheDetailGateDeviceFpCoordinator } =
      await import('../../../src/main/gates/miyoushe-detail-recovery.js');
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    const retryAt = 1_800_000_000_000 + 72 * 60 * 60 * 1000;
    const rawDeviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      ensureForSession: vi.fn(async () => ({
        ok: true as const,
        cookie: OLD_COOKIE,
        deviceHash: 'device-hash',
        refreshed: false
      })),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };
    const deviceFp = new MiyousheDetailGateDeviceFpCoordinator(rawDeviceFp, {
      now: () => 1_800_000_000_000
    });
    await deviceFp.ensureForSession(OLD_COOKIE);
    requestMock
      .mockResolvedValueOnce(mockJson(200, { retcode: 0, data: { list: [list[0]] } }))
      .mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'detail blocked' }))
      .mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'roster blocked' }));
    const browserTransport = vi
      .fn()
      .mockResolvedValueOnce(mockBrowserJson(200, { retcode: 5003, message: 'replay blocked' }));
    const events: unknown[] = [];
    const client = new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent: (event) => events.push(event)
    });

    const first = await client.fetchDetailedRoster('100000001', OLD_COOKIE);
    const second = await client.fetchDetailedRoster('100000001', OLD_COOKIE);

    expect(first).toMatchObject({
      ok: true,
      data: { coverage: { partial: true, failedBatches: [{ batchIndex: 0 }] } }
    });
    expect(second).toMatchObject({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003 }
    });
    expect(rawDeviceFp.recoverFrom5003).toHaveBeenCalledTimes(1);
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { phase: 'detected', retcode: 5003 },
      { phase: 'replayed', final: '5003' },
      { phase: 'detected', retcode: 5003 },
      { phase: 'skipped', reason: 'cooldown', retryAt }
    ]);
  });

  it.each([
    ['more than five minutes later', 1_800_000_000_000 + 6 * 60_000],
    ['after a clock rollback', 1_799_999_000_000]
  ])('replays the startup fingerprint without a second getFp %s', async (_case, replayTime) => {
    const { MiyousheDetailGateDeviceFpCoordinator } =
      await import('../../../src/main/gates/miyoushe-detail-recovery.js');
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    let now = 1_800_000_000_000;
    let refreshedAt = 0;
    let rawGetFpCalls = 0;
    const refreshed = {
      ok: true as const,
      cookie: NEW_COOKIE,
      deviceHash: 'device-hash',
      refreshed: true
    };
    const rawDeviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) =>
        rawGetFpCalls > 0 ? cookie.replace(`DEVICEFP=${OLD_FP}`, `DEVICEFP=${NEW_FP}`) : cookie
      ),
      ensureForSession: vi.fn(async () => {
        rawGetFpCalls += 1;
        refreshedAt = now;
        return refreshed;
      }),
      recoverFrom5003: vi.fn(async () => {
        const age = now - refreshedAt;
        expect(age < 0 || age >= 5 * 60_000).toBe(true);
        rawGetFpCalls += 1;
        return refreshed;
      }),
      finishReplay: vi.fn()
    };
    const deviceFp = new MiyousheDetailGateDeviceFpCoordinator(rawDeviceFp);
    expect(await deviceFp.ensureForSession(OLD_COOKIE)).toBe(refreshed);
    now = replayTime;
    expect(now).toBe(replayTime);

    requestMock.mockResolvedValueOnce(
      mockJson(200, { retcode: 5003, message: 'private risk response' })
    );
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const events: unknown[] = [];
    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent: (event) => events.push(event)
    }).ping('100000001', OLD_COOKIE);

    expect(result.ok).toBe(true);
    expect(rawGetFpCalls).toBe(1);
    expect(rawDeviceFp.recoverFrom5003).not.toHaveBeenCalled();
    expect(browserTransport.mock.calls[0]?.[1].headers.cookie).toBe(NEW_COOKIE);
    expect(events).toEqual([
      { phase: 'detected', retcode: 5003 },
      { phase: 'replayed', final: 'success' }
    ]);
  });

  it('emits detected then skipped while reusing a startup cooldown result', async () => {
    const { MiyousheDetailGateDeviceFpCoordinator } =
      await import('../../../src/main/gates/miyoushe-detail-recovery.js');
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    const cooldownResult = {
      ok: false as const,
      cookie: OLD_COOKIE,
      reason: 'cooldown' as const,
      retryAt: 1_900_000_000_000
    };
    const rawDeviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      ensureForSession: vi.fn(async () => cooldownResult),
      recoverFrom5003: vi.fn(),
      finishReplay: vi.fn()
    };
    const deviceFp = new MiyousheDetailGateDeviceFpCoordinator(rawDeviceFp);
    expect(await deviceFp.ensureForSession(OLD_COOKIE)).toBe(cooldownResult);
    requestMock.mockResolvedValueOnce(
      mockJson(200, { retcode: 5003, message: 'private risk response' })
    );
    const browserTransport = vi.fn();
    const events: unknown[] = [];

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent: (event) => events.push(event)
    }).ping('100000001', OLD_COOKIE);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003 }
    });
    expect(rawDeviceFp.recoverFrom5003).not.toHaveBeenCalled();
    expect(browserTransport).not.toHaveBeenCalled();
    expect(events).toEqual([
      { phase: 'detected', retcode: 5003 },
      { phase: 'skipped', reason: 'cooldown', retryAt: 1_900_000_000_000 }
    ]);
  });

  it('emits only sanitized detected and replayed events for a successful recovery', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'secret upstream' }));
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'private-device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };
    const events: unknown[] = [];

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent: (event: unknown) => events.push(event)
    }).ping('100000001', OLD_COOKIE);

    expect(result.ok).toBe(true);
    expect(events).toEqual([
      { phase: 'detected', retcode: 5003 },
      { phase: 'replayed', final: 'success' }
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /private-auth-token|device-id|device-fingerprint|seed-id|private-device-hash|secret upstream|https?:\/\//
    );
  });

  it('emits a sanitized skipped event when recovery is in cooldown', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'secret upstream' }));
    const browserTransport = vi.fn();
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: false as const,
        cookie: OLD_COOKIE,
        deviceHash: 'private-device-hash',
        reason: 'cooldown' as const,
        retryAt: 1_800_000_000_000
      })),
      finishReplay: vi.fn()
    };
    const events: unknown[] = [];

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent: (event: unknown) => events.push(event)
    }).ping('100000001', OLD_COOKIE);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003 }
    });
    expect(events).toEqual([
      { phase: 'detected', retcode: 5003 },
      { phase: 'skipped', reason: 'cooldown', retryAt: 1_800_000_000_000 }
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /private-auth-token|device-id|device-fingerprint|seed-id|private-device-hash|secret upstream|https?:\/\//
    );
  });

  it('emits a terminal network skip when the recovery dependency throws', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'secret upstream' }));
    const browserTransport = vi.fn();
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => {
        throw new Error('private recovery response');
      }),
      finishReplay: vi.fn()
    };
    const events: unknown[] = [];

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent: (event) => events.push(event)
    }).ping('100000001', OLD_COOKIE);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003 }
    });
    expect(events).toEqual([
      { phase: 'detected', retcode: 5003 },
      { phase: 'skipped', reason: 'network' }
    ]);
    expect(JSON.stringify(events)).not.toMatch(/secret upstream|private recovery response/);
    expect(browserTransport).not.toHaveBeenCalled();
  });

  it('contains a throwing event callback when recovery also throws', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial' }));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => {
        throw new Error('private recovery response');
      }),
      finishReplay: vi.fn()
    };
    const onDeviceRecoveryEvent = vi.fn(() => {
      throw new Error('private callback response');
    });

    const result = await new MiyousheGameRecordClient({
      browserTransport: vi.fn(),
      deviceFp,
      onDeviceRecoveryEvent
    }).ping('100000001', OLD_COOKIE);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003 }
    });
    expect(onDeviceRecoveryEvent).toHaveBeenCalledTimes(2);
  });

  it('does not let a throwing recovery event callback alter the request result', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial' }));
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };
    const onDeviceRecoveryEvent = vi.fn(() => {
      throw new Error('private callback failure');
    });

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent
    }).ping('100000001', OLD_COOKIE);

    expect(result.ok).toBe(true);
    expect(onDeviceRecoveryEvent).toHaveBeenCalledTimes(2);
  });

  it('recovers once and replays the same index request through Chromium with the new fingerprint', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'original 5003' }));
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };
    const client = new MiyousheGameRecordClient({ browserTransport, deviceFp });

    await expect(client.ping('100000001', OLD_COOKIE)).resolves.toEqual({
      ok: true,
      data: {
        nickname: 'Traveler',
        worldLevel: 9,
        activeDays: undefined,
        totalCharacters: 80
      }
    });

    expect(deviceFp.recoverFrom5003).toHaveBeenCalledTimes(1);
    expect(deviceFp.recoverFrom5003).toHaveBeenCalledWith(OLD_COOKIE);
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(deviceFp.finishReplay).toHaveBeenCalledWith(NEW_COOKIE, 'success');

    const query = 'role_id=100000001&server=cn_gf01';
    const nodeUrl = String(requestMock.mock.calls[0]?.[0]);
    const nodeRequest = requestMock.mock.calls[0]?.[1] as {
      method: string;
      headers: Record<string, string>;
      body?: string;
    };
    const browserUrl = String(browserTransport.mock.calls[0]?.[0]);
    const browserRequest = browserTransport.mock.calls[0]?.[1];
    expect(browserUrl).toBe(nodeUrl);
    expect(browserUrl).toContain(`?${query}`);
    expect(browserRequest.method).toBe(nodeRequest.method);
    expect(browserRequest.body).toBe(nodeRequest.body);
    expect(nodeRequest.headers.cookie).toBe(OLD_COOKIE);
    expect(browserRequest.headers.cookie).toBe(NEW_COOKIE);
    expect(browserRequest.headers['x-rpc-device_id']).toBe('device-id');
    expect(browserRequest.headers['x-rpc-device_fp']).toBe(NEW_FP);

    const nodeDs = expectValidDs(nodeRequest.headers.DS, query, '');
    const browserDs = expectValidDs(browserRequest.headers.DS, query, '');
    expect(browserDs).not.toBe(nodeDs);
  });

  it('preserves POST bytes and business headers when replaying character/list with a fresh DS', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'original 5003' }));
    const browserTransport = vi
      .fn()
      .mockResolvedValue(mockBrowserJson(200, { retcode: 0, data: { list: [] } }));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp
    }).fetchDetailedRoster('100000001', OLD_COOKIE);

    expect(result.ok).toBe(true);
    const nodeUrl = String(requestMock.mock.calls[0]?.[0]);
    const nodeRequest = requestMock.mock.calls[0]?.[1] as {
      method: string;
      body: string;
      headers: Record<string, string>;
    };
    const browserUrl = String(browserTransport.mock.calls[0]?.[0]);
    const browserRequest = browserTransport.mock.calls[0]?.[1];
    const exactBody = JSON.stringify({ role_id: '100000001', server: 'cn_gf01' });
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(browserUrl).toBe(nodeUrl);
    expect(browserUrl).not.toContain('?');
    expect(browserRequest.method).toBe('POST');
    expect(nodeRequest.body).toBe(exactBody);
    expect(browserRequest.body).toBe(exactBody);
    for (const headerName of [
      'content-type',
      'x-rpc-app_version',
      'x-rpc-client_type',
      'x-rpc-language',
      'x-rpc-page',
      'x-rpc-tool_verison',
      'Referer',
      'Origin'
    ]) {
      expect(browserRequest.headers[headerName]).toBe(nodeRequest.headers[headerName]);
    }
    expect(browserRequest.headers['x-rpc-device_id']).toBe('device-id');
    expect(browserRequest.headers['x-rpc-device_fp']).toBe(NEW_FP);
    const nodeDs = expectValidDs(nodeRequest.headers.DS, '', exactBody);
    const browserDs = expectValidDs(browserRequest.headers.DS, '', exactBody);
    expect(browserDs).not.toBe(nodeDs);
    expect(deviceFp.finishReplay).toHaveBeenCalledTimes(1);
    expect(deviceFp.finishReplay).toHaveBeenCalledWith(NEW_COOKIE, 'success');
  });

  it('falls back to the recovered cookie when apply throws during replay', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial' }));
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const deviceFp = {
      applyKnownFingerprint: vi
        .fn<(cookie: string) => string>()
        .mockImplementationOnce((cookie) => cookie)
        .mockImplementationOnce(() => {
          throw new Error('secret replay device material');
        }),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };

    const pending = new MiyousheGameRecordClient({ browserTransport, deviceFp }).ping(
      '100000001',
      OLD_COOKIE
    );
    await expect(pending).resolves.toMatchObject({ ok: true });
    const result = await pending;

    expect(JSON.stringify(result)).not.toContain('secret replay device material');
    expect(deviceFp.applyKnownFingerprint).toHaveBeenCalledTimes(2);
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(browserTransport.mock.calls[0]?.[1].headers.cookie).toBe(NEW_COOKIE);
    expect(deviceFp.finishReplay).toHaveBeenCalledTimes(1);
    expect(deviceFp.finishReplay).toHaveBeenCalledWith(NEW_COOKIE, 'success');
  });

  it('settles a redacted network result and finishReplay when replay recursion throws', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockImplementationOnce(() => {
        throw new Error('secret recursive signing material');
      });
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial' }));
    const browserTransport = vi.fn();
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };

    const pending = new MiyousheGameRecordClient({ browserTransport, deviceFp }).ping(
      '100000001',
      OLD_COOKIE
    );
    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'network' } });
    const result = await pending;

    expect(JSON.stringify(result)).not.toContain('secret recursive signing material');
    expect(browserTransport).not.toHaveBeenCalled();
    expect(deviceFp.finishReplay).toHaveBeenCalledTimes(1);
    expect(deviceFp.finishReplay).toHaveBeenCalledWith(NEW_COOKIE, 'other-error');
  });

  it('returns a second 5003 without another recovery or transport loop', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial 5003' }));
    const browserTransport = vi
      .fn()
      .mockResolvedValue(mockBrowserJson(200, { retcode: 5003, message: 'replay 5003' }));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp
    }).ping('100000001', OLD_COOKIE);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003, message: 'replay 5003' }
    });
    expect(deviceFp.recoverFrom5003).toHaveBeenCalledTimes(1);
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(deviceFp.finishReplay).toHaveBeenCalledWith(NEW_COOKIE, '5003');
  });

  it.each([
    ['parse', async () => ({ statusCode: 200, headers: {}, bodyText: 'not-json' }), 'parse'],
    [
      'network',
      async () => {
        throw new Error('browser transport unavailable');
      },
      'network'
    ]
  ] as const)(
    'settles replay %s errors as other-error',
    async (_case, replayTransport, expectedKind) => {
      const { MiyousheGameRecordClient } =
        await import('../../../src/main/services/miyoushe-game-record.js');
      requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial' }));
      const browserTransport = vi.fn(replayTransport);
      const deviceFp = {
        applyKnownFingerprint: vi.fn((cookie: string) => cookie),
        recoverFrom5003: vi.fn(async () => ({
          ok: true as const,
          cookie: NEW_COOKIE,
          deviceHash: 'device-hash',
          refreshed: true
        })),
        finishReplay: vi.fn()
      };

      const result = await new MiyousheGameRecordClient({
        browserTransport,
        deviceFp
      }).ping('100000001', OLD_COOKIE);

      expect(result).toMatchObject({ ok: false, error: { kind: expectedKind } });
      expect(browserTransport).toHaveBeenCalledTimes(1);
      expect(deviceFp.finishReplay).toHaveBeenCalledTimes(1);
      expect(deviceFp.finishReplay).toHaveBeenCalledWith(NEW_COOKIE, 'other-error');
    }
  );

  it('returns the original classified 5003 when recovery fails without browser fallback', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(
      mockJson(200, { retcode: 5003, message: 'original public message' })
    );
    const browserTransport = vi.fn();
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: false as const,
        cookie: OLD_COOKIE,
        reason: 'cooldown' as const,
        retryAt: 999
      })),
      finishReplay: vi.fn()
    };

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp
    }).ping('100000001', OLD_COOKIE);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003, message: 'original public message' }
    });
    expect(JSON.stringify(result)).not.toContain('cooldown');
    expect(deviceFp.recoverFrom5003).toHaveBeenCalledTimes(1);
    expect(browserTransport).not.toHaveBeenCalled();
    expect(deviceFp.finishReplay).not.toHaveBeenCalled();
  });

  it('does not recover retcode 1034 when a device service is configured', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 1034, message: 'captcha' }));
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(),
      finishReplay: vi.fn()
    };

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp
    }).ping('100000001', OLD_COOKIE);

    expect(result.ok).toBe(true);
    expect(deviceFp.recoverFrom5003).not.toHaveBeenCalled();
    expect(browserTransport).toHaveBeenCalledTimes(1);
  });

  it('does not recover a browser 5003 reached through the 1034 fallback', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 1034, message: 'captcha' }));
    const browserTransport = vi
      .fn()
      .mockResolvedValueOnce(mockBrowserJson(200, { retcode: 5003, message: 'browser risk' }));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };

    const onDeviceRecoveryEvent = vi.fn();
    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent
    }).ping('100000001', OLD_COOKIE);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003, message: 'browser risk' }
    });
    expect(deviceFp.recoverFrom5003).not.toHaveBeenCalled();
    expect(deviceFp.finishReplay).not.toHaveBeenCalled();
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(onDeviceRecoveryEvent).not.toHaveBeenCalled();
  });

  it('keeps the existing browser fallback for global UID 5003 without recovery', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'global risk' }));
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(),
      finishReplay: vi.fn()
    };

    const onDeviceRecoveryEvent = vi.fn();
    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp,
      onDeviceRecoveryEvent
    }).ping('800000001', OLD_COOKIE);

    expect(result.ok).toBe(true);
    expect(deviceFp.applyKnownFingerprint).not.toHaveBeenCalled();
    expect(deviceFp.recoverFrom5003).not.toHaveBeenCalled();
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(onDeviceRecoveryEvent).not.toHaveBeenCalled();
  });

  it('keeps the existing browser fallback for CN 5003 without a device service', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'CN risk' }));
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    const onDeviceRecoveryEvent = vi.fn();

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      onDeviceRecoveryEvent
    }).ping('100000001', OLD_COOKIE);

    expect(result.ok).toBe(true);
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(onDeviceRecoveryEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['success', indexSuccess, true, 'success'],
    ['failure', { retcode: 5003, message: 'still blocked' }, false, '5003']
  ] as const)(
    'does not let a throwing finishReplay change the %s result',
    async (_case, replayPayload, expectedOk, expectedOutcome) => {
      const { MiyousheGameRecordClient } =
        await import('../../../src/main/services/miyoushe-game-record.js');
      requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial' }));
      const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, replayPayload));
      const deviceFp = {
        applyKnownFingerprint: vi.fn((cookie: string) => cookie),
        recoverFrom5003: vi.fn(async () => ({
          ok: true as const,
          cookie: NEW_COOKIE,
          deviceHash: 'device-hash',
          refreshed: true
        })),
        finishReplay: vi.fn(() => {
          throw new Error('private bookkeeping error');
        })
      };

      const result = await new MiyousheGameRecordClient({
        browserTransport,
        deviceFp
      }).ping('100000001', OLD_COOKIE);

      expect(result.ok).toBe(expectedOk);
      if (!result.ok) {
        expect('retcode' in result.error ? result.error.retcode : undefined).toBe(5003);
      }
      expect(deviceFp.finishReplay).toHaveBeenCalledWith(NEW_COOKIE, expectedOutcome);
    }
  );

  it('applies the recovered fingerprint to later list and detail requests using the old cookie', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock
      .mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial' }))
      .mockResolvedValueOnce(mockJson(200, { retcode: 0, data: { list: [list[0]] } }))
      .mockResolvedValueOnce(mockJson(200, { retcode: 0, data: { list: [{ base: list[0] }] } }));
    const browserTransport = vi.fn().mockResolvedValue(mockBrowserJson(200, indexSuccess));
    let recovered = false;
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) =>
        recovered ? cookie.replace(`DEVICEFP=${OLD_FP}`, `DEVICEFP=${NEW_FP}`) : cookie
      ),
      recoverFrom5003: vi.fn(async () => {
        recovered = true;
        return {
          ok: true as const,
          cookie: NEW_COOKIE,
          deviceHash: 'device-hash',
          refreshed: true
        };
      }),
      finishReplay: vi.fn()
    };
    const client = new MiyousheGameRecordClient({ browserTransport, deviceFp });

    expect((await client.ping('100000001', OLD_COOKIE)).ok).toBe(true);
    expect((await client.fetchDetailedRoster('100000001', OLD_COOKIE)).ok).toBe(true);

    expect(deviceFp.recoverFrom5003).toHaveBeenCalledTimes(1);
    expect(browserTransport).toHaveBeenCalledTimes(1);
    for (const call of requestMock.mock.calls.slice(1)) {
      const headers = (call[1] as { headers: Record<string, string> }).headers;
      expect(headers.cookie).toBe(NEW_COOKIE);
      expect(headers['x-rpc-device_id']).toBe('device-id');
      expect(headers['x-rpc-device_fp']).toBe(NEW_FP);
    }
  });

  it('preserves the recovery guard across a Chromium 5xx retry with a fresh DS', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.75);
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'initial' }));
    const browserTransport = vi
      .fn()
      .mockResolvedValueOnce(mockBrowserJson(503, { retcode: -1, message: 'temporary' }))
      .mockResolvedValueOnce(mockBrowserJson(200, { retcode: 5003, message: 'still blocked' }));
    const deviceFp = {
      applyKnownFingerprint: vi.fn((cookie: string) => cookie),
      recoverFrom5003: vi.fn(async () => ({
        ok: true as const,
        cookie: NEW_COOKIE,
        deviceHash: 'device-hash',
        refreshed: true
      })),
      finishReplay: vi.fn()
    };

    const result = await new MiyousheGameRecordClient({
      browserTransport,
      deviceFp
    }).ping('100000001', OLD_COOKIE);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003, message: 'still blocked' }
    });
    expect(deviceFp.recoverFrom5003).toHaveBeenCalledTimes(1);
    expect(browserTransport).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(deviceFp.finishReplay).toHaveBeenCalledWith(NEW_COOKIE, '5003');
    const query = 'role_id=100000001&server=cn_gf01';
    const firstDs = expectValidDs(browserTransport.mock.calls[0]?.[1].headers.DS, query, '');
    const retryDs = expectValidDs(browserTransport.mock.calls[1]?.[1].headers.DS, query, '');
    expect(retryDs).not.toBe(firstDs);
  });
});

describe('Battle Chronicle request profile', () => {
  it('matches the current official index request shape', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(
      mockJson(200, {
        retcode: 0,
        data: { role: { nickname: 'Traveler' }, stats: { avatar_number: 80 } }
      })
    );

    await new MiyousheGameRecordClient().ping(
      '100000001',
      'ltoken_v2=token; _MHYUUID=device-id; DEVICEFP=device-fingerprint'
    );

    const headers = (
      requestMock.mock.calls[0]?.[1] as {
        headers: Record<string, string>;
      }
    ).headers;
    expect(headers['x-rpc-app_version']).toBe('2.111.0');
    expect(headers['user-agent']).toContain('miHoYoBBS/2.111.0');
    expect(headers['x-rpc-tool_verison']).toBe('v6.7.2-gr-cn');
    expect(headers['x-rpc-page']).toBe('v6.7.2-gr-cn_#/ys');
    expect(headers).not.toHaveProperty('content-type');
  });
});

describe('browser bridge payload mappers', () => {
  it('uses the same list/detail mapping contract as direct HTTP', async () => {
    const { mapMiyousheCharacterDetailData, mapMiyousheCharacterListData } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    expect(mapMiyousheCharacterListData({ list })?.map((character) => character.id)).toEqual([
      10000046, 10000037
    ]);
    const detailed = mapMiyousheCharacterDetailData({
      list: [
        {
          base: list[0],
          weapon: { id: 1, name: 'Bridge Weapon', level: 90, rarity: 5, affix_level: 3 },
          relics: [],
          skills: [
            { skill_type: 1, level: 6 },
            { skill_type: 2, level: 8 },
            { skill_type: 3, level: 9 }
          ],
          selected_properties: [{ property_type: 20, final: '0.55' }]
        }
      ]
    });
    expect(detailed?.[0]).toMatchObject({
      id: 10000046,
      weapon: { name: 'Bridge Weapon', refinement: 3 },
      talents: { normalAttack: 6, elementalSkill: 8, elementalBurst: 9 },
      stats: { critRate: 55 }
    });
    expect(mapMiyousheCharacterDetailData({ wrong: [] })).toBeUndefined();
  });
});

describe('MiyousheGameRecordClient.fetchDetailedRoster', () => {
  it('POSTs list/detail with the exact body, preserves order, and maps build fields', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');

    requestMock
      .mockResolvedValueOnce(mockJson(200, { retcode: 0, data: { list } }))
      .mockResolvedValueOnce(
        mockJson(200, {
          retcode: 0,
          data: {
            property_map: {
              '20': { property_type: 20, name: 'CRIT Rate' },
              '22': { property_type: 22, name: 'CRIT DMG' }
            },
            list: [
              {
                base: list[1],
                weapon: {
                  id: 11501,
                  name: 'Weapon B',
                  icon: 'weapon-b.png',
                  rarity: 5,
                  level: 90,
                  affix_level: 2,
                  main_property: { property_type: 4, final: '608' },
                  sub_property: { property_type: 22, final: '66.2%' }
                },
                relics: [
                  {
                    id: 50120,
                    pos: 3,
                    rarity: 5,
                    level: 20,
                    set: { id: 15001, name: 'Test Set' },
                    main_property: { property_type: 23, value: '51.8%' },
                    sub_property_list: [{ property_type: 20, value: '3.9%' }]
                  }
                ],
                skills: [
                  { skill_type: 1, level: 6, is_unlock: true },
                  { skill_type: 2, level: 9, is_unlock: true },
                  { skill_type: 3, level: 10, is_unlock: true }
                ],
                selected_properties: [
                  { property_type: 20, final: '0.612' },
                  { property_type: 22, final: '1.84' },
                  { property_type: 23, final: '1.35' }
                ]
              },
              {
                base: list[0],
                weapon: {
                  id: 13501,
                  name: 'Weapon A',
                  icon: 'weapon-a.png',
                  rarity: 5,
                  level: 90,
                  affix_level: 1
                },
                relics: [],
                skills: [
                  { skill_type: 1, level: 6 },
                  { skill_type: 2, level: 8 },
                  { skill_type: 3, level: 8 }
                ],
                base_properties: [
                  { property_type: 1, final: '32000' },
                  { property_type: 4, final: '1800' },
                  { property_type: 7, final: '900' }
                ]
              }
            ]
          }
        })
      );

    const client = new MiyousheGameRecordClient();
    const result = await client.fetchDetailedRoster('100000001', 'ltoken=x; ltuid=y', {
      expectedOwnedCount: 2
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.characters.map((character) => character.id)).toEqual([10000046, 10000037]);
    expect(result.data.characters[0]?.weapon?.name).toBe('Weapon A');
    expect(result.data.characters[1]?.artifacts[0]).toMatchObject({
      slot: 'sands',
      setName: 'Test Set',
      mainStat: { key: 'energyRecharge', value: 51.8 }
    });
    expect(result.data.characters[1]?.talents).toEqual({
      normalAttack: 6,
      elementalSkill: 9,
      elementalBurst: 10
    });
    expect(result.data.characters[1]?.stats).toEqual({
      critRate: 61.2,
      critDmg: 184,
      energyRecharge: 135
    });
    expect(result.data.coverage).toMatchObject({
      expectedOwnedCount: 2,
      listedCount: 2,
      detailedCount: 2,
      partial: false,
      fields: { weapon: 2, artifacts: 1, talents: 2, stats: 2 }
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    const listCall = requestMock.mock.calls[0]!;
    expect(String(listCall[0])).toContain('/game_record/app/genshin/api/character/list');
    expect((listCall[1] as { body: string }).body).toBe(
      JSON.stringify({ role_id: '100000001', server: 'cn_gf01' })
    );
    expect((listCall[1] as { headers: Record<string, string> }).headers['content-type']).toBe(
      'application/json;charset=UTF-8'
    );
    expect((listCall[1] as { headers: Record<string, string> }).headers).not.toHaveProperty(
      'x-rpc-device_id'
    );
    const detailCall = requestMock.mock.calls[1]!;
    expect((detailCall[1] as { body: string }).body).toBe(
      JSON.stringify({
        role_id: '100000001',
        server: 'cn_gf01',
        character_ids: [10000046, 10000037]
      })
    );
    const headers = (detailCall[1] as { headers: Record<string, string> }).headers;
    expect(headers.DS).toMatch(/^\d+,\d{6},[a-f0-9]{32}$/);
    expect(headers['x-rpc-device_id']).toBeUndefined();
    expect(headers['x-rpc-device_fp']).toBeUndefined();
  });

  it('batches detail requests and reports missing/duplicate IDs as partial', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock
      .mockResolvedValueOnce(
        mockJson(200, { retcode: 0, data: { list: [list[0], list[0], list[1]] } })
      )
      .mockResolvedValueOnce(mockJson(200, { retcode: 0, data: { list: [{ base: list[0] }] } }))
      .mockResolvedValueOnce(mockJson(429, { retcode: 0, message: 'too many requests' }));

    const client = new MiyousheGameRecordClient();
    const result = await client.fetchDetailedRoster('100000001', 'cookie=valid-enough', {
      expectedOwnedCount: 3,
      batchSize: 1
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.characters).toHaveLength(2);
    expect(result.data.coverage).toMatchObject({
      listedCount: 2,
      detailedCount: 1,
      duplicateCharacterIds: [10000046],
      missingCharacterIds: [10000037],
      failedBatches: [{ batchIndex: 1, kind: 'rate-limited' }],
      partial: true
    });
    expect(result.data.characters[1]?.artifacts).toEqual([]);
    expect(result.data.characters[1]?.talents).toBeUndefined();
  });

  it.each([
    [5003, 200, 'captcha-required'],
    [1034, 200, 'captcha-required'],
    [-5003, 200, 'signature'],
    [-100, 200, 'auth-expired'],
    [10101, 200, 'rate-limited']
  ])('classifies retcode %s as %s', async (retcode, status, expectedKind) => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(status, { retcode, message: 'failure' }));
    const result = await new MiyousheGameRecordClient().fetchDetailedRoster(
      '100000001',
      'cookie=valid-enough'
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe(expectedKind);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('classifies non-JSON without leaking response text', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockText(403, 'secret upstream response body'));
    const result = await new MiyousheGameRecordClient().fetchDetailedRoster(
      '100000001',
      'cookie=valid-enough'
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse');
    expect(result.error.message).not.toContain('secret upstream response body');
  });

  it('uses the current sg-public-api route for global UIDs', async () => {
    const { MiyousheGameRecordClient } =
      await import('../../../src/main/services/miyoushe-game-record.js');
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 0, data: { list: [] } }));
    const result = await new MiyousheGameRecordClient().fetchDetailedRoster(
      '800000001',
      'cookie=valid-enough'
    );
    expect(result.ok).toBe(true);
    expect(String(requestMock.mock.calls[0]?.[0])).toBe(
      'https://sg-public-api.hoyolab.com/event/game_record/app/genshin/api/character/list'
    );
  });
});
