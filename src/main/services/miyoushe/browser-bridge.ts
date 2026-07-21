import { app, BrowserWindow, session } from 'electron';
import { MIYOUSHE_LOGIN_PARTITION } from '../miyoushe-login-window.js';
import {
  mapMiyousheCharacterDetailData,
  mapMiyousheCharacterListData,
  regionFromUid,
  type MiyousheCharacterDetail,
  type MiyousheRosterCoverage
} from '../miyoushe-game-record.js';
import {
  buildOfficialRosterUrl,
  classifyOfficialRecordUrl,
  classifyOfficialVerificationUrl,
  OFFICIAL_PAGE_PRELOAD_SCRIPT
} from './official-page.js';

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
// Real desktop Chrome UA — same shape miyoushe.com sees from a normal Chrome
// browser. Without this the page either renders a blank "browser not
// supported" state or trips mihoyo's anti-bot heuristics.
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_HIDDEN_TIMEOUT_MS = 15_000;
const DEFAULT_VISIBLE_TIMEOUT_MS = 600_000;

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

function bringVerificationWindowToFront(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.center();
  win.show();
  win.setAlwaysOnTop(true, 'floating');
  win.moveTop();
  win.focus();
  app.focus({ steal: true });
  setTimeout(() => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(false);
  }, 2_000);
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
  /** In-game UID whose authoritative owned-character list should be opened. */
  uid?: string;
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

interface CdpRequestPaused {
  requestId: string;
  request: { url: string; method?: string };
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
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
  requestedUid: string;
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
  const expectedOwnedCount = indexData?.stats?.avatar_number ?? state.listed?.length;
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
    uid: typeof role?.game_uid === 'string' ? role.game_uid : state.requestedUid,
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

  /** Open MiHoYo's own all-character page and capture its sanitized data. */
  async fetchRoster(options: FetchRosterOptions = {}): Promise<BrowserBridgeResult> {
    if (this.inflight) {
      return this.inflight;
    }
    const task = this.runOfficialPage(options);
    this.inflight = task.finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async runOfficialPage(options: FetchRosterOptions): Promise<BrowserBridgeResult> {
    const visible = options.visible === true;
    const timeoutMs =
      options.timeoutMs ?? (visible ? DEFAULT_VISIBLE_TIMEOUT_MS : DEFAULT_HIDDEN_TIMEOUT_MS);
    const gameUid = options.uid;
    if (!gameUid) {
      return {
        ok: false,
        reason: 'navigation',
        message: '官方战绩页缺少目标游戏 UID'
      };
    }
    const ses = session.fromPartition(this.partition);

    await replicateCookiesAcrossDomains(ses);
    const accountCookies = await ses.cookies.get({ domain: '.mihoyo.com', name: 'ltuid_v2' });
    const communityUid = accountCookies[0]?.value;
    if (!communityUid) {
      return {
        ok: false,
        reason: 'upstream',
        message: '官方战绩页缺少 ltuid_v2 登录态，请重新登录米游社'
      };
    }
    const url = buildOfficialRosterUrl({
      communityUid,
      gameUid,
      region: regionFromUid(gameUid).region
    });

    const win = new BrowserWindow({
      show: visible,
      width: 1280,
      height: 800,
      autoHideMenuBar: true,
      backgroundColor: '#16191f',
      title: visible ? '米游社安全验证 — 完成后角色列表会自动导入' : undefined,
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
    if (visible) bringVerificationWindowToFront(win);

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

    win.webContents.setUserAgent(DESKTOP_CHROME_UA);
    win.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
      logWarn(`[official] did-fail-load ${code} ${desc} url=${validatedURL}`);
    });
    win.webContents.on('render-process-gone', (_e, details) =>
      logWarn(`[official] render-process-gone reason=${details.reason}`)
    );

    logInfo(`opened ${visible ? 'visible' : 'hidden'} official roster page for UID suffix ${gameUid.slice(-3)}`);

    const dbg = win.webContents.debugger;
    const interceptState: BridgeInterceptState = {
      requestedUid: gameUid,
      detailedById: new Map()
    };
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (graceTimer) clearTimeout(graceTimer);
      try {
        dbg.detach();
      } catch {
        // already detached
      }
      if (!win.isDestroyed()) win.close();
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
          interceptState,
          visible,
          scheduleBestResult,
          finish
        );
      });

      win.on('closed', () => {
        if (settled) return;
        finish(
          buildBridgeResult(interceptState) ?? {
            ok: false,
            reason: 'upstream',
            message: '用户关闭了官方验证页，尚未捕获完整角色列表'
          }
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

      logInfo('CDP Fetch/Page enable → official roster page');
      Promise.all([
        dbg.sendCommand('Page.enable'),
        dbg.sendCommand('Fetch.enable', {
          patterns: [
            {
              urlPattern:
                'https://api-takumi-record.mihoyo.com/game_record/*genshin/api/*',
              requestStage: 'Response'
            },
            {
              urlPattern:
                'https://api-takumi-record.mihoyo.com/game_record/card/wapi/*Verification*',
              requestStage: 'Response'
            }
          ]
        })
      ])
        .then(() =>
          dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: OFFICIAL_PAGE_PRELOAD_SCRIPT
          })
        )
        .then(() => {
          logInfo('official preload installed → loadURL');
          return win.loadURL(url);
        })
        .then(() => {
          logInfo('loadURL resolved');
          if (visible) bringVerificationWindowToFront(win);
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
    state: BridgeInterceptState,
    interactive: boolean,
    scheduleBestResult: () => void,
    finish: (r: BrowserBridgeResult) => void
  ): Promise<void> {
    try {
      if (method === 'Fetch.requestPaused') {
        const p = params as CdpRequestPaused;
        const targetKind = classifyOfficialRecordUrl(p.request.url);
        const verificationKind = classifyOfficialVerificationUrl(p.request.url);
        if (
          (!targetKind && !verificationKind) ||
          p.responseStatusCode === undefined ||
          !['GET', 'POST'].includes(p.request.method ?? '')
        ) {
          await dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId });
          return;
        }
        const responseLabel = targetKind ?? `verification-${verificationKind}`;
        logInfo(`paused official ${responseLabel} response for requestId ${p.requestId}`);
        const raw = (await dbg.sendCommand('Fetch.getResponseBody', {
          requestId: p.requestId
        })) as CdpResponseBody;
        const text = raw.base64Encoded
          ? Buffer.from(raw.body, 'base64').toString('utf8')
          : raw.body;
        if (text.length === 0) {
          await dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId });
          return;
        }
        let parsed: BridgeApiResponse;
        try {
          parsed = JSON.parse(text) as BridgeApiResponse;
        } catch {
          const contentEncoding = p.responseHeaders?.find(
            (header) => header.name.toLowerCase() === 'content-encoding'
          )?.value;
          logWarn(
            `official ${responseLabel} non-json body length=${text.length} base64=${raw.base64Encoded} encoding=${contentEncoding ?? 'none'} prefix=${Buffer.from(text).subarray(0, 8).toString('hex')}`
          );
          finish({
            ok: false,
            reason: 'parse',
            message: `Battle Chronicle 返回了非 JSON 响应（${text.length} bytes）`
          });
          return;
        }
        if (verificationKind) {
          logInfo(
            `official verification ${verificationKind} retcode=${parsed.retcode ?? 'unknown'}`
          );
          await dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId });
          return;
        }
        if (!targetKind) {
          await dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId });
          return;
        }
        await dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId });
        if (parsed.retcode !== 0) {
          if (interactive && [1034, 10306].includes(parsed.retcode ?? 0)) {
            logInfo(`official ${targetKind} remains in interactive verification`);
            return;
          }
          finish({
            ok: false,
            reason: 'upstream',
            message: `官方战绩页 ${targetKind} retcode=${parsed.retcode ?? 'unknown'} ${parsed.message ?? ''}`
          });
          return;
        }
        if (targetKind === 'index') {
          state.index = parsed as IndexResponse;
        } else if (targetKind === 'list') {
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
