import { BrowserWindow, session } from 'electron';

const KEY_COOKIE_NAMES = ['ltoken_v2', 'ltuid_v2', 'ltmid_v2'] as const;
const COOKIE_DOMAINS = ['.miyoushe.com', '.mihoyo.com'];
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

  constructor(partition: string = MIYOUSHE_LOGIN_PARTITION) {
    this.partition = partition;
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
    const map = await collectKeyCookies(ses);
    if (map.size !== KEY_COOKIE_NAMES.length) return undefined;
    return KEY_COOKIE_NAMES.map((name) => `${name}=${map.get(name)}`).join('; ');
  }

  /** User-initiated logout: drops every cookie on the persistent partition. */
  async clearPersistedCookie(): Promise<void> {
    const ses = session.fromPartition(this.partition);
    await ses.clearStorageData({ storages: ['cookies'] });
  }

  async runOnce(options: LoginWindowOptions = {}): Promise<LoginOutcome> {
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
        sandbox: true
      }
    });
    win.webContents.setUserAgent(DESKTOP_CHROME_UA);
    win.webContents.on('did-start-navigation', () => {
      void win.webContents.executeJavaScript(STEALTH_SCRIPT, true).catch(() => {});
    });

    return new Promise<LoginOutcome>((resolve) => {
      let settled = false;

      const settle = (outcome: LoginOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        if (!win.isDestroyed()) {
          win.removeAllListeners('closed');
          win.close();
        }
        resolve(outcome);
      };

      const pollTimer = setInterval(() => {
        void (async () => {
          if (win.isDestroyed()) {
            return;
          }
          const cookieMap = await collectKeyCookies(ses);
          if (cookieMap.size === KEY_COOKIE_NAMES.length) {
            const cookieStr = KEY_COOKIE_NAMES.map((name) => `${name}=${cookieMap.get(name)}`).join('; ');
            settle({ ok: true, cookie: cookieStr });
          }
        })();
      }, POLL_INTERVAL_MS);

      const timeoutTimer = setTimeout(() => {
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

async function collectKeyCookies(ses: Electron.Session): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const domain of COOKIE_DOMAINS) {
    const cookies = await ses.cookies.get({ domain });
    for (const cookie of cookies) {
      if ((KEY_COOKIE_NAMES as readonly string[]).includes(cookie.name) && !found.has(cookie.name)) {
        found.set(cookie.name, cookie.value);
      }
    }
  }
  return found;
}
