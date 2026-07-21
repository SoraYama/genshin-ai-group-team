import { BrowserWindow, session } from 'electron';
import { DEVICE_COOKIE_NAMES, type MiyousheDeviceCookieName } from './miyoushe/device-profile.js';

const REQUIRED_COOKIE_NAMES = ['ltoken_v2', 'ltuid_v2', 'ltmid_v2'] as const;
const AUTH_CONTEXT_COOKIE_NAMES = [
  'account_id',
  'account_id_v2',
  'account_mid_v2',
  'cookie_token',
  'cookie_token_v2',
  'ltoken',
  'ltuid'
] as const;
const SESSION_COOKIE_NAMES = [
  ...REQUIRED_COOKIE_NAMES,
  ...AUTH_CONTEXT_COOKIE_NAMES,
  ...DEVICE_COOKIE_NAMES
] as const;
const COOKIE_DOMAINS = ['.miyoushe.com', '.mihoyo.com'];
const DEVICE_COOKIE_TARGETS = [
  { url: 'https://www.miyoushe.com/', domain: '.miyoushe.com' },
  { url: 'https://api-takumi.mihoyo.com/', domain: '.mihoyo.com' }
] as const;
const DEVICE_COOKIE_EXPIRY_SECONDS = 365 * 24 * 60 * 60;
const LOGIN_URL = 'https://www.miyoushe.com/ys/';
const POLL_INTERVAL_MS = 800;
const MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * Persistent session partition for miyoushe login. Electron stores the
 * cookie database under `userData/Partitions/miyoushe-login/Cookies`, encrypted
 * by Chromium's `OSCrypt` (Keychain on macOS / DPAPI on Windows / kwallet on
 * Linux) — i.e. the same security primitive that `safeStorage` would give us.
 *
 * One partition = one miyoushe account. Re-logging in just overwrites the
 * cookie set; we treat single-account as the supported case (per product call).
 */
export const MIYOUSHE_LOGIN_PARTITION = 'persist:miyoushe-login';

// Real-Chrome UA + stealth script — see browser-bridge.ts for context. The
// login flow also needs this disguise so the session is "warm" from the
// start; otherwise the moment the user navigates to game_record-backed pages
// mihoyo's anti-bot has already flagged them.
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STEALTH_SCRIPT = `
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (window.chrome === undefined) {
      window.chrome = { runtime: {} };
    }
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
  } catch (_) {}
`;

export type LoginOutcome =
  | { ok: true; cookie: string }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'load-failed'; message?: string };

export interface LoginWindowOptions {
  parentWindow?: BrowserWindow;
}

export class MiyousheLoginWindow {
  private readonly partition: string;
  private cancelActiveLoginRequest: (() => void) | undefined;

  constructor(partition: string = MIYOUSHE_LOGIN_PARTITION) {
    this.partition = partition;
  }

  /** Force-close the current login window so it cannot mutate the partition later. */
  cancelActiveLogin(): void {
    this.cancelActiveLoginRequest?.();
  }

  /**
   * Read the currently-persisted miyoushe cookie (if any) without opening a
   * window. Used at app startup to recover the previous login state.
   *
   * Returns `undefined` if any of the three required keys is missing (which
   * Chromium will also do once the cookie passes its `expirationDate`).
   */
  async readPersistedCookie(): Promise<string | undefined> {
    const ses = session.fromPartition(this.partition);
    const map = await collectSessionCookies(ses);
    if (!hasRequiredCookies(map)) return undefined;
    return serializeSessionCookies(map);
  }

  /** User-initiated logout: drops every cookie on the persistent partition. */
  async clearPersistedCookie(): Promise<void> {
    const ses = session.fromPartition(this.partition);
    await ses.clearStorageData({ storages: ['cookies'] });
  }

  /** Persist only device-identification cookies needed by miyoushe risk controls. */
  async writeDeviceCookies(values: Readonly<Record<string, string>>): Promise<void> {
    const entries = Object.entries(values);
    const validatedEntries: Array<[MiyousheDeviceCookieName, string]> = [];

    for (const [name, value] of entries) {
      if (
        !(DEVICE_COOKIE_NAMES as readonly string[]).includes(name) ||
        typeof value !== 'string' ||
        !value.trim()
      ) {
        throw new Error(`Rejected device cookie outside device cookie whitelist: ${name}`);
      }
      validatedEntries.push([name as MiyousheDeviceCookieName, value]);
    }

    const ses = session.fromPartition(this.partition);
    const expirationDate = Math.floor(Date.now() / 1000) + DEVICE_COOKIE_EXPIRY_SECONDS;
    for (const [name, value] of validatedEntries) {
      for (const target of DEVICE_COOKIE_TARGETS) {
        await ses.cookies.set({
          ...target,
          name,
          value,
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'no_restriction',
          expirationDate
        });
      }
    }
    if (validatedEntries.length > 0) {
      await ses.cookies.flushStore();
    }
  }

  async runOnce(options: LoginWindowOptions = {}): Promise<LoginOutcome> {
    this.cancelActiveLogin();
    const ses = session.fromPartition(this.partition);

    const win = new BrowserWindow({
      width: 1024,
      height: 760,
      autoHideMenuBar: true,
      title: '登录米游社',
      backgroundColor: '#16191f',
      parent: options.parentWindow,
      modal: false,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    win.webContents.setUserAgent(DESKTOP_CHROME_UA);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('will-navigate', (event, targetUrl) => {
      try {
        const host = new URL(targetUrl).hostname;
        if (
          !host.endsWith('.miyoushe.com') &&
          host !== 'miyoushe.com' &&
          !host.endsWith('.mihoyo.com') &&
          host !== 'mihoyo.com'
        ) {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
    });
    win.webContents.on('did-start-navigation', () => {
      void win.webContents.executeJavaScript(STEALTH_SCRIPT, true).catch(() => {});
    });

    return new Promise<LoginOutcome>((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelCurrentLogin!: () => void;

      const settle = (outcome: LoginOutcome, forceDestroy = false) => {
        if (settled) {
          return;
        }
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (this.cancelActiveLoginRequest === cancelCurrentLogin) {
          this.cancelActiveLoginRequest = undefined;
        }
        if (!win.isDestroyed()) {
          win.removeAllListeners('closed');
          if (forceDestroy) win.destroy();
          else win.close();
        }
        resolve(outcome);
      };

      cancelCurrentLogin = () => {
        settle({ ok: false, reason: 'cancelled' }, true);
      };
      this.cancelActiveLoginRequest = cancelCurrentLogin;

      pollTimer = setInterval(() => {
        void (async () => {
          if (win.isDestroyed()) {
            return;
          }
          const cookieMap = await collectSessionCookies(ses);
          if (hasRequiredCookies(cookieMap)) {
            const cookieStr = serializeSessionCookies(cookieMap);
            settle({ ok: true, cookie: cookieStr });
          }
        })();
      }, POLL_INTERVAL_MS);

      timeoutTimer = setTimeout(() => {
        settle({ ok: false, reason: 'timeout', message: '登录超时（5 分钟未完成）' });
      }, MAX_WAIT_MS);

      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        if (validatedURL === LOGIN_URL || validatedURL.startsWith('https://www.miyoushe.com')) {
          settle({
            ok: false,
            reason: 'load-failed',
            message: `加载米游社失败 (${errorCode}): ${errorDescription}`
          });
        }
      });

      win.on('closed', () => {
        settle({ ok: false, reason: 'cancelled' });
      });

      void win.loadURL(LOGIN_URL);
    });
  }
}

async function collectSessionCookies(ses: Electron.Session): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const domain of COOKIE_DOMAINS) {
    const cookies = await ses.cookies.get({ domain });
    for (const cookie of cookies) {
      if (
        (SESSION_COOKIE_NAMES as readonly string[]).includes(cookie.name) &&
        !found.has(cookie.name)
      ) {
        found.set(cookie.name, cookie.value);
      }
    }
  }
  return found;
}

function hasRequiredCookies(cookies: ReadonlyMap<string, string>): boolean {
  return REQUIRED_COOKIE_NAMES.every((name) => cookies.has(name));
}

function serializeSessionCookies(cookies: ReadonlyMap<string, string>): string {
  return SESSION_COOKIE_NAMES.flatMap((name) => {
    const value = cookies.get(name);
    return value === undefined ? [] : [`${name}=${value}`];
  }).join('; ');
}
