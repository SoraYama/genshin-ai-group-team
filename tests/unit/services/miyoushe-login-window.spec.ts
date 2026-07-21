import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCookies, setCookie, fromPartition } = vi.hoisted(() => {
  const getCookies = vi.fn();
  const setCookie = vi.fn();
  return {
    getCookies,
    setCookie,
    fromPartition: vi.fn(() => ({
      cookies: { get: getCookies, set: setCookie }
    }))
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {
    fromPartition
  }
}));

import { MiyousheLoginWindow } from '../../../src/main/services/miyoushe-login-window.js';

describe('MiyousheLoginWindow persisted cookie projection', () => {
  beforeEach(() => {
    getCookies.mockReset();
    setCookie.mockReset();
    fromPartition.mockClear();
  });

  it('keeps verification credentials in main while excluding unrelated cookies', async () => {
    getCookies.mockResolvedValue([
      { name: 'ltoken_v2', value: 'token-v2' },
      { name: 'ltuid_v2', value: 'uid-v2' },
      { name: 'ltmid_v2', value: 'mid-v2' },
      { name: 'account_id_v2', value: 'account-v2' },
      { name: 'cookie_token_v2', value: 'cookie-token-v2' },
      { name: '_MHYUUID', value: 'device-id' },
      { name: 'DEVICEFP', value: 'device-fp' },
      { name: 'acw_tc', value: 'unrelated' }
    ]);

    const cookie = await new MiyousheLoginWindow('persist:test').readPersistedCookie();

    expect(cookie).toContain('cookie_token_v2=cookie-token-v2');
    expect(cookie).toContain('account_id_v2=account-v2');
    expect(cookie).toContain('_MHYUUID=device-id');
    expect(cookie).not.toContain('acw_tc');
    expect(fromPartition).toHaveBeenCalledWith('persist:test');
  });

  it('writes allowlisted device cookies persistently to both trusted domains', async () => {
    const nowSeconds = Date.now() / 1000;

    await new MiyousheLoginWindow('persist:device-test').writeDeviceCookies({
      _MHYUUID: 'device-id',
      DEVICEFP: 'device-fp'
    });

    expect(fromPartition).toHaveBeenCalledWith('persist:device-test');
    expect(setCookie).toHaveBeenCalledTimes(4);
    expect(setCookie.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            url: 'https://www.miyoushe.com/',
            domain: '.miyoushe.com',
            name: '_MHYUUID',
            value: 'device-id',
            path: '/',
            secure: true,
            httpOnly: false,
            sameSite: 'no_restriction',
            expirationDate: expect.any(Number)
          })
        ],
        [
          expect.objectContaining({
            url: 'https://api-takumi.mihoyo.com/',
            domain: '.mihoyo.com',
            name: '_MHYUUID',
            value: 'device-id',
            path: '/',
            secure: true,
            httpOnly: false,
            sameSite: 'no_restriction',
            expirationDate: expect.any(Number)
          })
        ],
        [
          expect.objectContaining({
            url: 'https://www.miyoushe.com/',
            domain: '.miyoushe.com',
            name: 'DEVICEFP',
            value: 'device-fp',
            path: '/',
            secure: true,
            httpOnly: false,
            sameSite: 'no_restriction',
            expirationDate: expect.any(Number)
          })
        ],
        [
          expect.objectContaining({
            url: 'https://api-takumi.mihoyo.com/',
            domain: '.mihoyo.com',
            name: 'DEVICEFP',
            value: 'device-fp',
            path: '/',
            secure: true,
            httpOnly: false,
            sameSite: 'no_restriction',
            expirationDate: expect.any(Number)
          })
        ]
      ])
    );
    for (const [cookie] of setCookie.mock.calls) {
      expect(cookie.expirationDate).toBeGreaterThanOrEqual(nowSeconds + 364 * 24 * 60 * 60);
      expect(cookie.expirationDate).toBeLessThanOrEqual(nowSeconds + 366 * 24 * 60 * 60);
    }
  });

  it('rejects a non-device cookie without writing it', async () => {
    await expect(
      new MiyousheLoginWindow().writeDeviceCookies({ ltoken_v2: 'credential' })
    ).rejects.toThrow('device cookie whitelist');

    expect(setCookie).not.toHaveBeenCalled();
  });

  it('validates all device cookies before writing any of them', async () => {
    await expect(
      new MiyousheLoginWindow().writeDeviceCookies({
        DEVICEFP: 'device-fp',
        ltoken_v2: 'credential'
      })
    ).rejects.toThrow('device cookie whitelist');

    expect(setCookie).not.toHaveBeenCalled();
  });

  it('rejects an empty allowlisted device cookie without writing it', async () => {
    await expect(new MiyousheLoginWindow().writeDeviceCookies({ DEVICEFP: '' })).rejects.toThrow(
      'device cookie whitelist'
    );

    expect(setCookie).not.toHaveBeenCalled();
  });
});
