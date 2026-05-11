import { BrowserWindow, session } from 'electron';

const KEY_COOKIE_NAMES = ['ltoken_v2', 'ltuid_v2', 'ltmid_v2'] as const;
const COOKIE_DOMAINS = ['.miyoushe.com', '.mihoyo.com'];
const LOGIN_URL = 'https://www.miyoushe.com/ys/';
const POLL_INTERVAL_MS = 800;
const MAX_WAIT_MS = 5 * 60 * 1000;

export type LoginOutcome =
  | { ok: true; cookie: string }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'load-failed'; message?: string };

export interface LoginWindowOptions {
  partition?: string;
  parentWindow?: BrowserWindow;
}

export class MiyousheLoginWindow {
  async runOnce(options: LoginWindowOptions = {}): Promise<LoginOutcome> {
    const partition = options.partition ?? 'miyoushe-login-ephemeral';
    const ses = session.fromPartition(partition);
    await ses.clearStorageData({ storages: ['cookies'] });

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
