import { BrowserWindow, session } from 'electron';
import { MIYOUSHE_LOGIN_PARTITION } from '../miyoushe-login-window.js';
import {
  mapMiyousheCharacterDetailData,
  mapMiyousheCharacterListData,
  type MiyousheCharacterDetail,
  type MiyousheRosterCoverage
} from '../miyoushe-game-record.js';

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
const TARGET_INDEX_PATH = '/game_record/app/genshin/api/index';
const TARGET_LIST_PATH = '/game_record/app/genshin/api/character/list';
const TARGET_DETAIL_PATH = '/game_record/app/genshin/api/character/detail';

const COOKIE_KEYS = [
  'ltoken_v2',
  'ltuid_v2',
  'ltmid_v2',
  '_MHYUUID',
  'DEVICEFP',
  'DEVICEFP_SEED_ID',
  'DEVICEFP_SEED_TIME'
] as const;

const VERBOSE_LOG = process.env.MIYOUSHE_DEBUG === '1';
function logInfo(message: string): void {
  if (VERBOSE_LOG) console.info(`[miyoushe-bridge] ${message}`);
}
function logWarn(message: string): void {
  if (VERBOSE_LOG) console.warn(`[miyoushe-bridge] ${message}`);
}

function isTrustedMiyousheUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'miyoushe.com' ||
        url.hostname.endsWith('.miyoushe.com') ||
        url.hostname === 'mihoyo.com' ||
        url.hostname.endsWith('.mihoyo.com'))
    );
  } catch {
    return false;
  }
}

function configureTrustedNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The desktop site opens Battle Chronicle with target=_blank. Keep it in
    // the isolated verification window instead of creating an unmanaged one.
    if (isTrustedMiyousheUrl(url)) void win.loadURL(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedMiyousheUrl(url)) event.preventDefault();
  });
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
  | {
      ok: true;
      mode: 'data';
      uid: string;
      nickname?: string;
      characters: MiyousheCharacterDetail[];
      coverage: MiyousheRosterCoverage;
    }
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
    stats?: { avatar_number?: number };
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

interface BridgeApiResponse {
  retcode?: number;
  message?: string;
  data?: unknown;
}

interface BridgeInterceptState {
  index?: IndexResponse;
  listed?: MiyousheCharacterDetail[];
  detailedById: Map<number, MiyousheCharacterDetail>;
}

function buildBridgeResult(state: BridgeInterceptState): BrowserBridgeResult | undefined {
  const indexData = state.index?.data;
  const role = indexData?.role;
  const indexCharacters = (indexData?.avatars ?? [])
    .filter((item): item is NonNullable<typeof item> & { id: number } => typeof item?.id === 'number')
    .map(
      (item): MiyousheCharacterDetail => ({
        id: item.id,
        name: item.name ?? '',
        element: item.element ?? '',
        level: item.level ?? 0,
        rarity: item.rarity ?? 0,
        iconUrl: item.icon ?? '',
        imageUrl: item.image,
        constellation: item.actived_constellation_num ?? 0,
        friendship: item.fetter ?? 0,
        artifacts: []
      })
    );
  const baseCharacters = state.listed ?? indexCharacters;
  if (!state.index && baseCharacters.length === 0) return undefined;

  const characters = baseCharacters.map(
    (character) => state.detailedById.get(character.id) ?? character
  );
  const listedIds = new Set(baseCharacters.map((character) => character.id));
  const unexpectedCharacterIds = [...state.detailedById.keys()].filter((id) => !listedIds.has(id));
  const missingCharacterIds = baseCharacters
    .filter((character) => !state.detailedById.has(character.id))
    .map((character) => character.id);
  const expectedOwnedCount = indexData?.stats?.avatar_number;
  const listedCount = baseCharacters.length;
  const fields = {
    weapon: characters.filter((character) => character.weapon !== undefined).length,
    artifacts: characters.filter((character) => character.artifacts.length > 0).length,
    talents: characters.filter((character) => character.talents !== undefined).length,
    stats: characters.filter((character) => character.stats !== undefined).length
  };
  return {
    ok: true,
    mode: 'data',
    uid: typeof role?.game_uid === 'string' ? role.game_uid : '',
    nickname: role?.nickname,
    characters,
    coverage: {
      expectedOwnedCount,
      listedCount,
      detailedCount: characters.length - missingCharacterIds.length,
      missingCharacterIds,
      duplicateCharacterIds: [],
      unexpectedCharacterIds,
      failedBatches: [],
      fields,
      partial:
        missingCharacterIds.length > 0 ||
        unexpectedCharacterIds.length > 0 ||
        (expectedOwnedCount !== undefined && expectedOwnedCount !== listedCount)
    }
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
    configureTrustedNavigation(win);
    win.on('page-title-updated', (event) => event.preventDefault());
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

    // Keep the verification surface identical to a normal browser unless the
    // developer explicitly asks for diagnostics.
    if (VERBOSE_LOG) win.webContents.openDevTools({ mode: 'detach' });
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
          // HTTP 200 does not mean business success: mihoyo returns retcode
          // 5003 inside a 200 response. Keep the window open so the user can
          // complete verification, then let an explicit close trigger retry.
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
    configureTrustedNavigation(win);

    // Electron 43 can leave debugger commands pending when the initial
    // renderer target has not been committed yet. Commit an isolated blank
    // document first, then attach/enable CDP before navigating to the real
    // Battle Chronicle URL so no target requests are missed.
    try {
      await win.loadURL('about:blank');
    } catch (error) {
      if (!win.isDestroyed()) win.close();
      return {
        ok: false,
        reason: 'navigation',
        message: `无法初始化 Battle Chronicle：${error instanceof Error ? error.message : error}`
      };
    }

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
    const interceptState: BridgeInterceptState = { detailedById: new Map() };
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (graceTimer) clearTimeout(graceTimer);
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
        finish(
          buildBridgeResult(interceptState) ?? {
            ok: false,
            reason: 'timeout',
            message: `Battle Chronicle 页面在 ${timeoutMs}ms 内没有返回角色数据`
          }
        );
      }, timeoutMs);

      const scheduleBestResult = () => {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          const best = buildBridgeResult(interceptState);
          if (best) finish(best);
        }, 1_500);
      };

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
        void this.handleCdpMessage(
          dbg,
          method,
          params,
          requestUrls,
          interceptState,
          scheduleBestResult,
          finish
        );
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
    state: BridgeInterceptState,
    scheduleBestResult: () => void,
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
        const targetPath = [TARGET_INDEX_PATH, TARGET_LIST_PATH, TARGET_DETAIL_PATH].find((path) =>
          url.includes(path)
        );
        if (!targetPath) return;
        logInfo(`intercepted ${targetPath} for requestId ${p.requestId}`);
        const raw = (await dbg.sendCommand('Network.getResponseBody', {
          requestId: p.requestId
        })) as CdpResponseBody;
        const text = raw.base64Encoded
          ? Buffer.from(raw.body, 'base64').toString('utf8')
          : raw.body;
        let parsed: BridgeApiResponse;
        try {
          parsed = JSON.parse(text) as BridgeApiResponse;
        } catch {
          finish({
            ok: false,
            reason: 'parse',
            message: `Battle Chronicle 返回了非 JSON 响应（${text.length} bytes）`
          });
          return;
        }
        if (parsed.retcode !== 0) {
          finish({
            ok: false,
            reason: 'upstream',
            message: `Battle Chronicle ${targetPath} retcode=${parsed.retcode ?? 'unknown'} ${parsed.message ?? ''}`
          });
          return;
        }
        if (targetPath === TARGET_INDEX_PATH) {
          state.index = parsed as IndexResponse;
        } else if (targetPath === TARGET_LIST_PATH) {
          const listed = mapMiyousheCharacterListData(parsed.data);
          if (!listed) {
            finish({ ok: false, reason: 'parse', message: 'character/list 缺少 list 数组' });
            return;
          }
          state.listed = listed;
        } else {
          const detailed = mapMiyousheCharacterDetailData(parsed.data);
          if (!detailed) {
            finish({ ok: false, reason: 'parse', message: 'character/detail 缺少 list 数组' });
            return;
          }
          for (const character of detailed) state.detailedById.set(character.id, character);
        }

        const complete =
          state.listed !== undefined &&
          state.listed.length > 0 &&
          state.listed.every((character) => state.detailedById.has(character.id));
        const best = buildBridgeResult(state);
        if (complete && best) finish(best);
        else scheduleBestResult();
      }
    } catch (error) {
      logWarn(
        `cdp message handler error: ${error instanceof Error ? error.message : error} (method=${method})`
      );
    }
  }
}
