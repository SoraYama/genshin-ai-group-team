import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockBrowserWindowView {
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
}

const { getCookies, setCookie, flushStore, clearStorageData, fromPartition, browserWindows } =
  vi.hoisted(() => {
    const getCookies = vi.fn();
    const setCookie = vi.fn();
    const flushStore = vi.fn();
    const clearStorageData = vi.fn();
    return {
      getCookies,
      setCookie,
      flushStore,
      clearStorageData,
      browserWindows: [] as MockBrowserWindowView[],
      fromPartition: vi.fn(() => ({
        cookies: { get: getCookies, set: setCookie, flushStore },
        clearStorageData,
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn()
      }))
    };
  });

vi.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    private destroyed = false;
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
      this.emit('closed');
    });
    readonly webContents = {
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(undefined)
    };

    constructor() {
      browserWindows.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    removeAllListeners(event: string): void {
      this.listeners.delete(event);
    }

    readonly close = vi.fn();

    loadURL(): Promise<void> {
      return Promise.resolve();
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  },
  session: {
    fromPartition
  }
}));

import { MiyousheLoginWindow } from '../../../src/main/services/miyoushe-login-window.js';

describe('MiyousheLoginWindow persisted cookie projection', () => {
  beforeEach(() => {
    getCookies.mockReset();
    setCookie.mockReset();
    flushStore.mockReset();
    clearStorageData.mockReset();
    fromPartition.mockClear();
    browserWindows.length = 0;
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
    expect(flushStore).toHaveBeenCalledTimes(1);
    const [flushOrder] = flushStore.mock.invocationCallOrder;
    expect(flushOrder).toBeGreaterThan(Math.max(...setCookie.mock.invocationCallOrder));
  });

  it('rejects a non-device cookie without writing it', async () => {
    await expect(
      new MiyousheLoginWindow().writeDeviceCookies({ ltoken_v2: 'credential' })
    ).rejects.toThrow('device cookie whitelist');

    expect(setCookie).not.toHaveBeenCalled();
    expect(flushStore).not.toHaveBeenCalled();
  });

  it('validates all device cookies before writing any of them', async () => {
    await expect(
      new MiyousheLoginWindow().writeDeviceCookies({
        DEVICEFP: 'device-fp',
        ltoken_v2: 'credential'
      })
    ).rejects.toThrow('device cookie whitelist');

    expect(setCookie).not.toHaveBeenCalled();
    expect(flushStore).not.toHaveBeenCalled();
  });

  it('rejects an empty allowlisted device cookie without writing it', async () => {
    await expect(new MiyousheLoginWindow().writeDeviceCookies({ DEVICEFP: '' })).rejects.toThrow(
      'device cookie whitelist'
    );

    expect(setCookie).not.toHaveBeenCalled();
    expect(flushStore).not.toHaveBeenCalled();
  });

  it('does not flush after a cookie write fails', async () => {
    setCookie
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk write failed'));

    await expect(
      new MiyousheLoginWindow().writeDeviceCookies({ DEVICEFP: 'device-fp' })
    ).rejects.toThrow('disk write failed');

    expect(setCookie).toHaveBeenCalledTimes(2);
    expect(flushStore).not.toHaveBeenCalled();
  });

  it('does not flush an empty device-cookie update', async () => {
    await new MiyousheLoginWindow().writeDeviceCookies({});

    expect(setCookie).not.toHaveBeenCalled();
    expect(flushStore).not.toHaveBeenCalled();
  });

  it('destroys an active login window and settles it as cancelled', async () => {
    const loginWindow = new MiyousheLoginWindow('persist:cancel-test');
    const login = loginWindow.runOnce();
    const activeWindow = browserWindows[0];

    loginWindow.cancelActiveLogin();

    await expect(login).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(activeWindow?.destroy).toHaveBeenCalledOnce();
    expect(activeWindow?.isDestroyed()).toBe(true);
  });

  it('destroys a successful login window even when close would be vetoed', async () => {
    vi.useFakeTimers();
    try {
      getCookies.mockResolvedValue([
        { name: 'ltoken_v2', value: 'token-v2' },
        { name: 'ltuid_v2', value: 'uid-v2' },
        { name: 'ltmid_v2', value: 'mid-v2' }
      ]);
      const loginWindow = new MiyousheLoginWindow('persist:close-veto-test');
      const login = loginWindow.runOnce();
      const activeWindow = browserWindows[0];

      await vi.advanceTimersByTimeAsync(800);

      await expect(login).resolves.toMatchObject({ ok: true });
      expect(activeWindow?.close).not.toHaveBeenCalled();
      expect(activeWindow?.destroy).toHaveBeenCalledOnce();
      expect(activeWindow?.isDestroyed()).toBe(true);

      const readsAfterSettle = getCookies.mock.calls.length;
      loginWindow.cancelActiveLogin();
      await vi.advanceTimersByTimeAsync(1_600);
      expect(getCookies).toHaveBeenCalledTimes(readsAfterSettle);
      expect(activeWindow?.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
