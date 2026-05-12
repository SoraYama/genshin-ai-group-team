import { BrowserWindow, session } from 'electron';
import { MIYOUSHE_LOGIN_PARTITION } from '../miyoushe-login-window.js';
import type { MiyousheCharacterDetail } from '../miyoushe-game-record.js';

/**
 * Battle Chronicle web app — the same SPA used inside the miyoushe app's "战绩"
 * tab. Loading this URL with the user's auth cookies causes the page to fetch
 * the player's game_record/index (and a few other endpoints) on its own JS
 * runtime, complete with DS signatures and whatever device fingerprinting
 * mihoyo's anti-bot demands this week.
 *
 * We intercept the response via Chrome DevTools Protocol — no signature
 * computation on our side, no salt rotation maintenance, no header guessing.
 */
// Two URL strategies:
//
// - HIDDEN_URL: the miyoushe app's mobile Battle Chronicle webview. When
//   loaded in an "app-like" UA, it auto-fetches /index on init. Renders blank
//   in a standalone PC browser (missing the mihoyo JS bridge), but as long as
//   it fires the API call the data-interception still works in hidden mode.
//
// - VISIBLE_URL: the miyoushe.com Genshin page — a real desktop site that
//   renders correctly. When a user is logged in they can navigate to their
//   profile/战绩 from here; when that page makes its /index call we intercept
//   it. The user-visible window also lets them complete any GeeTest captcha
//   mihoyo throws at first-touch sessions.
const HIDDEN_URL =
  'https://webstatic.mihoyo.com/app/community-game-records/index.html?bbs_presentation_style=fullscreen#/ys';
const VISIBLE_URL = 'https://www.miyoushe.com/ys/';

// Mobile webview UA — convinces Battle Chronicle JS to render even outside
// the actual mihoyo app. Required for hidden-mode loading to be useful.
const MOBILE_WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 13; M2101K9C Build/TKQ1.220829.002; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/108.0.5359.128 ' +
  'Mobile Safari/537.36 miHoYoBBS/2.71.1';

// Real desktop Chrome UA — same shape miyoushe.com sees from a normal Chrome
// browser. Without this the page either renders a blank "browser not
// supported" state or trips mihoyo's anti-bot heuristics.
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Script injected before page scripts run; masks the remaining Electron
// tells beyond what `disable-blink-features=AutomationControlled` covers.
const STEALTH_SCRIPT = `
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (window.chrome === undefined) {
      window.chrome = { runtime: {} };
    }
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en']
    });
  } catch (_) {}
`;

const DEFAULT_HIDDEN_TIMEOUT_MS = 15_000;
const DEFAULT_VISIBLE_TIMEOUT_MS = 180_000;
const TARGET_PATH = '/game_record/app/genshin/api/index';

const COOKIE_KEYS = ['ltoken_v2', 'ltuid_v2', 'ltmid_v2'] as const;

const VERBOSE_LOG = process.env.MIYOUSHE_DEBUG !== '0';
function logInfo(message: string): void {
  if (VERBOSE_LOG) console.info(`[miyoushe-bridge] ${message}`);
}
function logWarn(message: string): void {
  if (VERBOSE_LOG) console.warn(`[miyoushe-bridge] ${message}`);
}

/**
 * Mirror the three auth cookies from `.miyoushe.com` (where login sets them)
 * to `.mihoyo.com` (where webstatic + game_record live). Without this, the
 * browser won't send them when loading `webstatic.mihoyo.com` and the page
 * thinks the user isn't logged in.
 */
async function replicateCookiesAcrossDomains(ses: Electron.Session): Promise<void> {
  try {
    const sourceCookies = await ses.cookies.get({ domain: '.miyoushe.com' });
    for (const cookie of sourceCookies) {
      if (!(COOKIE_KEYS as readonly string[]).includes(cookie.name)) continue;
      // Skip if a mihoyo.com copy already exists with the same value.
      const existing = await ses.cookies.get({
        domain: '.mihoyo.com',
        name: cookie.name
      });
      if (existing.some((c) => c.value === cookie.value)) continue;
      await ses.cookies.set({
        url: 'https://www.mihoyo.com',
        name: cookie.name,
        value: cookie.value,
        domain: '.mihoyo.com',
        path: '/',
        secure: true,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate ?? Math.floor(Date.now() / 1000) + 86400 * 30,
        sameSite: 'no_restriction'
      });
      logInfo(`replicated ${cookie.name} from .miyoushe.com → .mihoyo.com`);
    }
  } catch (error) {
    logWarn(`cookie replication failed: ${error instanceof Error ? error.message : error}`);
  }
}

export interface BrowserBridgeOptions {
  partition?: string;
}

export interface FetchRosterOptions {
  /**
   * Show the window so the user can complete any GeeTest / risk-control
   * challenge mihoyo throws. Defaults to hidden — try the warm-session
   * path first, fall back to a visible attempt if that fails.
   */
  visible?: boolean;
  timeoutMs?: number;
}

export type BrowserBridgeResult =
  | { ok: true; mode: 'data'; uid: string; nickname?: string; characters: MiyousheCharacterDetail[] }
  | { ok: true; mode: 'warmup'; indexCalled: boolean }
  | { ok: false; reason: 'timeout' | 'navigation' | 'parse' | 'upstream'; message: string };

interface CdpRequestWillBeSent {
  requestId: string;
  request: { url: string };
}
interface CdpLoadingFinished {
  requestId: string;
}
interface CdpResponseBody {
  body: string;
  base64Encoded: boolean;
}

interface IndexResponse {
  retcode?: number;
  message?: string;
  data?: {
    role?: { nickname?: string; game_uid?: string; region?: string };
    avatars?: Array<{
      id?: number;
      name?: string;
      element?: string;
      level?: number;
      rarity?: number;
      icon?: string;
      image?: string;
      actived_constellation_num?: number;
      fetter?: number;
    }>;
  };
}

export class MiyousheBrowserBridge {
  private readonly partition: string;
  private inflight: Promise<BrowserBridgeResult> | undefined;

  constructor(options: BrowserBridgeOptions = {}) {
    this.partition = options.partition ?? MIYOUSHE_LOGIN_PARTITION;
  }

  /**
   * Returns the player's roster as the Battle Chronicle sees it. We don't
   * select a specific UID — the page uses whichever account is set as default
   * for the logged-in miyoushe user. The caller compares the returned `uid`
   * against what they expected; mismatch is a user-resolvable problem (need
   * to switch the default UID inside miyoushe's app), not an API bug.
   *
   * Pass `visible: true` to surface the window so the user can complete any
   * GeeTest captcha mihoyo throws at "unverified" sessions. Mihoyo's
   * anti-bot returns retcode 5003 for sessions that haven't completed a
   * challenge — the only way to recover is to let the user solve it in a
   * real interactive window.
   */
  async fetchRoster(options: FetchRosterOptions = {}): Promise<BrowserBridgeResult> {
    if (this.inflight) {
      return this.inflight;
    }
    const task = options.visible ? this.runWarmupVisible(options) : this.runInterceptHidden(options);
    this.inflight = task.finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Visible warm-up: open a real interactive window so the user can solve any
   * GeeTest challenge mihoyo serves. We DO NOT attach `webContents.debugger`
   * — that would block DevTools (single CDP slot per webContents) and seems
   * to leave the page in a stuck state for some renderer pipelines. Instead
   * we observe via `session.webRequest.onCompleted` (a separate API with no
   * CDP conflict). When we see the page successfully complete an /index
   * request, we signal "warmup done"; the caller retries direct HTTP.
   */
  private async runWarmupVisible(options: FetchRosterOptions): Promise<BrowserBridgeResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_VISIBLE_TIMEOUT_MS;
    const url = VISIBLE_URL;
    const ses = session.fromPartition(this.partition);
    await replicateCookiesAcrossDomains(ses);

    const win = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      autoHideMenuBar: true,
      backgroundColor: '#16191f',
      title: '米游社验证 — 请打开「我的」→「原神战绩」，加载完成后可关闭此窗口',
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    win.webContents.setUserAgent(DESKTOP_CHROME_UA);
    win.webContents.on('dom-ready', () => {
      void win.webContents.executeJavaScript(STEALTH_SCRIPT, true).catch(() => {});
    });
    win.webContents.on('did-finish-load', () => {
      logInfo(`[visible] did-finish-load: ${win.webContents.getURL()}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
      logWarn(`[visible] did-fail-load ${code} ${desc} url=${validatedURL}`);
    });
    win.webContents.on('console-message', (_event, level, message, _line, source) => {
      logInfo(`[visible page L${level}] ${message.slice(0, 240)} (${source})`);
    });

    // DevTools is safe in this mode because we never attach our own debugger.
    win.webContents.openDevTools({ mode: 'detach' });
    logInfo(`opened VISIBLE window → ${url}`);

    return new Promise<BrowserBridgeResult>((resolve) => {
      let settled = false;
      let indexCalled = false;

      const filter = {
        urls: [
          '*://*.mihoyo.com/game_record/app/genshin/api/index*',
          '*://*.miyoushe.com/game_record/app/genshin/api/index*'
        ]
      };

      const requestHook = (details: Electron.OnCompletedListenerDetails) => {
        logInfo(`[visible webRequest] ${details.method} ${details.url.slice(0, 100)} → HTTP ${details.statusCode}`);
        if (details.statusCode === 200) {
          indexCalled = true;
          // Don't auto-close — user might still be solving captcha. Give them
          // a moment and then auto-close once we're confident the session is
          // warm.
          setTimeout(() => {
            finish({ ok: true, mode: 'warmup', indexCalled: true });
          }, 1500);
        }
      };
      ses.webRequest.onCompleted(filter, requestHook);

      const timer = setTimeout(() => {
        finish({
          ok: false,
          reason: 'timeout',
          message: `验证窗口超时（${timeoutMs}ms 内未观察到 /index 调用）`
        });
      }, timeoutMs);

      const finish = (result: BrowserBridgeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Deregister webRequest hook on this session.
        ses.webRequest.onCompleted(filter, null);
        if (!win.isDestroyed()) {
          win.removeAllListeners('closed');
          win.close();
        }
        resolve(result);
      };

      win.on('closed', () => {
        // User dismissed the window. Treat as best-effort warmup; caller will
        // retry direct HTTP and find out if the session is actually warm.
        finish({ ok: true, mode: 'warmup', indexCalled });
      });

      void win.loadURL(url);
    });
  }

  private async runInterceptHidden(options: FetchRosterOptions): Promise<BrowserBridgeResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_HIDDEN_TIMEOUT_MS;
    const url = HIDDEN_URL;
    const ses = session.fromPartition(this.partition);

    // Cookies set during login land on `.miyoushe.com`. The hidden URL lives
    // on `.mihoyo.com` and won't see those cookies unless we replicate them.
    await replicateCookiesAcrossDomains(ses);

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      backgroundColor: '#16191f',
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });

    // Mobile webview UA — convinces Battle Chronicle JS to fire its /index
    // request even outside the actual mihoyo app shell.
    win.webContents.setUserAgent(MOBILE_WEBVIEW_UA);

    win.webContents.on('dom-ready', () => {
      void win.webContents.executeJavaScript(STEALTH_SCRIPT, true).catch(() => {});
    });
    win.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
      logWarn(`[hidden] did-fail-load ${code} ${desc} url=${validatedURL}`);
    });
    win.webContents.on('render-process-gone', (_e, details) =>
      logWarn(`[hidden] render-process-gone reason=${details.reason}`)
    );

    logInfo(`opened hidden window → ${url}`);

    const dbg = win.webContents.debugger;
    const requestUrls = new Map<string, string>();
    let settled = false;

    const cleanup = () => {
      if (!win.isDestroyed()) win.close();
      try {
        dbg.detach();
      } catch {
        // already detached
      }
    };

    return new Promise<BrowserBridgeResult>((resolve) => {
      const finish = (result: BrowserBridgeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          reason: 'timeout',
          message: `Battle Chronicle 页面在 ${timeoutMs}ms 内没有返回 /index 响应`
        });
      }, timeoutMs);

      try {
        dbg.attach('1.3');
      } catch (error) {
        finish({
          ok: false,
          reason: 'navigation',
          message: `无法附加 debugger：${error instanceof Error ? error.message : error}`
        });
        return;
      }

      dbg.on('message', (_event, method, params) => {
        if (settled) return;
        void this.handleCdpMessage(dbg, method, params, requestUrls, finish);
      });

      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        if (validatedURL.startsWith('https://webstatic.mihoyo.com')) {
          finish({
            ok: false,
            reason: 'navigation',
            message: `Battle Chronicle 加载失败 (${errorCode}): ${errorDescription}`
          });
        }
      });

      logInfo('Network.enable → sendCommand');
      dbg
        .sendCommand('Network.enable')
        .then(() => {
          logInfo(`Network.enable OK → loadURL ${url}`);
          return win.loadURL(url);
        })
        .then(() => {
          logInfo('loadURL resolved');
        })
        .catch((error) => {
          logWarn(`navigation pipeline failed: ${error instanceof Error ? error.message : error}`);
          finish({
            ok: false,
            reason: 'navigation',
            message: error instanceof Error ? error.message : String(error)
          });
        });
    });
  }

  private async handleCdpMessage(
    dbg: Electron.Debugger,
    method: string,
    params: unknown,
    requestUrls: Map<string, string>,
    finish: (r: BrowserBridgeResult) => void
  ): Promise<void> {
    try {
      if (method === 'Network.requestWillBeSent') {
        const p = params as CdpRequestWillBeSent;
        requestUrls.set(p.requestId, p.request.url);
        return;
      }
      if (method === 'Network.loadingFinished') {
        const p = params as CdpLoadingFinished;
        const url = requestUrls.get(p.requestId);
        if (!url) return;
        requestUrls.delete(p.requestId);
        if (!url.includes(TARGET_PATH)) return;
        logInfo(`intercepted ${TARGET_PATH} for requestId ${p.requestId}`);
        const raw = (await dbg.sendCommand('Network.getResponseBody', {
          requestId: p.requestId
        })) as CdpResponseBody;
        const text = raw.base64Encoded
          ? Buffer.from(raw.body, 'base64').toString('utf8')
          : raw.body;
        let parsed: IndexResponse;
        try {
          parsed = JSON.parse(text) as IndexResponse;
        } catch {
          finish({ ok: false, reason: 'parse', message: `非 JSON 响应：${text.slice(0, 200)}` });
          return;
        }
        if (parsed.retcode !== 0) {
          finish({
            ok: false,
            reason: 'upstream',
            message: `Battle Chronicle /index retcode=${parsed.retcode ?? 'unknown'} ${parsed.message ?? ''}`
          });
          return;
        }
        const role = parsed.data?.role;
        const avatars = parsed.data?.avatars ?? [];
        finish({
          ok: true,
          mode: 'data',
          uid: typeof role?.game_uid === 'string' ? role.game_uid : '',
          nickname: role?.nickname,
          characters: avatars
            .filter((a): a is NonNullable<typeof a> & { id: number } => typeof a?.id === 'number')
            .map((a) => ({
              id: a.id,
              name: a.name ?? '',
              element: a.element ?? '',
              level: a.level ?? 0,
              rarity: a.rarity ?? 0,
              iconUrl: a.icon ?? '',
              imageUrl: a.image,
              constellation: a.actived_constellation_num ?? 0,
              friendship: a.fetter ?? 0,
              artifacts: []
            }))
        });
      }
    } catch (error) {
      logWarn(
        `cdp message handler error: ${error instanceof Error ? error.message : error} (method=${method})`
      );
    }
  }
}
