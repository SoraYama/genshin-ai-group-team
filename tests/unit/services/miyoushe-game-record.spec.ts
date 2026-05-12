import { describe, expect, it, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();

vi.mock('undici', () => ({
  request: requestMock
}));

function mockJson(status: number, payload: unknown) {
  return {
    statusCode: status,
    body: { text: async () => JSON.stringify(payload) }
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('regionFromUid', () => {
  it('maps UID prefixes to expected servers', async () => {
    const { regionFromUid } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    expect(regionFromUid('100000001').region).toBe('cn_gf01');
    expect(regionFromUid('200000001').region).toBe('cn_gf01');
    expect(regionFromUid('500000001').region).toBe('cn_qd01');
    expect(regionFromUid('600000001')).toEqual({ region: 'os_usa', isGlobal: true });
    expect(regionFromUid('700000001')).toEqual({ region: 'os_euro', isGlobal: true });
    expect(regionFromUid('800000001')).toEqual({ region: 'os_asia', isGlobal: true });
    expect(regionFromUid('900000001')).toEqual({ region: 'os_cht', isGlobal: true });
  });
});

describe('MiyousheGameRecordClient.fetchCharacterDetails', () => {
  it('reads the avatars array from /index and maps it to character details', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );

    requestMock.mockResolvedValueOnce(
      mockJson(200, {
        retcode: 0,
        message: 'OK',
        data: {
          role: { nickname: 'Test' },
          stats: { active_day_number: 100, world_level: 9, avatar_number: 2 },
          avatars: [
            {
              id: 10000046,
              name: 'Hu Tao',
              element: 'Pyro',
              level: 90,
              rarity: 5,
              icon: 'icon-hutao.png',
              image: 'image-hutao.png',
              actived_constellation_num: 0,
              fetter: 9
            },
            {
              id: 10000037,
              name: 'Ganyu',
              element: 'Cryo',
              level: 80,
              rarity: 5,
              icon: 'icon-ganyu.png',
              actived_constellation_num: 1,
              fetter: 5
            }
          ]
        }
      })
    );

    const client = new MiyousheGameRecordClient();
    const result = await client.fetchCharacterDetails('100000001', 'ltoken=x; ltuid=y');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    const first = result.data[0]!;
    expect(first.id).toBe(10000046);
    expect(first.name).toBe('Hu Tao');
    expect(first.iconUrl).toBe('icon-hutao.png');
    expect(first.imageUrl).toBe('image-hutao.png');
    expect(first.constellation).toBe(0);
    expect(first.friendship).toBe(9);
    // Artifacts and talents are not available via /index — leave empty/undefined.
    expect(first.artifacts).toEqual([]);
    expect(first.talents).toBeUndefined();

    expect(requestMock).toHaveBeenCalledTimes(1);
    const call = requestMock.mock.calls[0]!;
    expect(String(call[0])).toContain('/game_record/app/genshin/api/index');
    expect(String(call[0])).toContain('role_id=100000001');
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers.cookie).toBe('ltoken=x; ltuid=y');
    expect(headers.DS).toMatch(/^\d+,\d{6},[a-f0-9]{32}$/);
    expect(headers['x-rpc-client_type']).toBe('5');
    expect(headers['x-rpc-app_version']).toBeTruthy();
    // We deliberately do NOT send device_id / device_fp — see comments in
    // miyoushe-game-record.ts buildHeaders().
    expect(headers['x-rpc-device_id']).toBeUndefined();
    expect(headers['x-rpc-device_fp']).toBeUndefined();
  });

  it('classifies retcode -100 as auth-expired and retries once with a fresh DS', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );

    requestMock
      .mockResolvedValueOnce(mockJson(200, { retcode: -100, message: 'login expired' }))
      .mockResolvedValueOnce(mockJson(200, { retcode: -100, message: 'login expired' }));

    const client = new MiyousheGameRecordClient();
    const result = await client.fetchCharacterDetails('100000001', 'cookie=stale');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('auth-expired');
    // /index + 1 auth retry.
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('classifies retcode 1034 as captcha-required without retrying', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );

    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 1034, message: 'verify' }));

    const client = new MiyousheGameRecordClient();
    const result = await client.fetchCharacterDetails('100000001', 'c=1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('captcha-required');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
