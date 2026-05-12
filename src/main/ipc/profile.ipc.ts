import { z } from 'zod';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import type {
  BindCookieResult,
  PersistedProfile,
  ProfileSource,
  RefreshSourceStatus,
  RefreshSummary
} from '../../shared/domain.js';
import type { EnkaClient } from '../services/enka-client.js';
import type {
  LoginSessionStore,
  RosterSessionStore
} from '../services/login-session-store.js';
import type { MiyousheClient } from '../services/miyoushe-client.js';
import type {
  MiyousheCharacterDetail,
  MiyousheFetchError,
  MiyousheGameRecordClient
} from '../services/miyoushe-game-record.js';
import type { MiyousheBrowserBridge } from '../services/miyoushe/browser-bridge.js';
import type { MiyousheLoginWindow } from '../services/miyoushe-login-window.js';
import type { ProfileStore } from '../services/profile-store.js';
import { mergeProfile } from '../services/profile-merger.js';
import { registerHandler } from './registry.js';

const cookieSchema = z.object({
  cookie: z.string().min(10, 'Cookie 长度异常')
});

const importSchema = z.object({
  cookie: z.string().min(10, 'Cookie 长度异常'),
  uid: z.string().regex(/^\d{9}$/, 'UID 必须为 9 位数字').optional()
});

const uidSchema = z.object({
  uid: z.string().regex(/^\d{9}$/, 'UID 必须为 9 位数字')
});

const importFromSessionSchema = z.object({
  sessionId: z.string().min(8),
  uid: z.string().regex(/^\d{9}$/, 'UID 必须为 9 位数字').optional()
});

export interface ProfileIpcDeps {
  miyoushe: MiyousheClient;
  miyousheGameRecord: MiyousheGameRecordClient;
  miyousheBridge: MiyousheBrowserBridge;
  loginWindow: MiyousheLoginWindow;
  loginSessions: LoginSessionStore;
  rosterSessions: RosterSessionStore;
  enka: EnkaClient;
  store: ProfileStore;
}

export function registerProfileIpc({
  miyoushe,
  miyousheGameRecord,
  miyousheBridge,
  loginWindow,
  loginSessions,
  rosterSessions,
  enka,
  store
}: ProfileIpcDeps): void {
  /**
   * Three-stage roster fetch:
   *   1. Direct HTTP — fastest, works when session is already GeeTest-warm.
   *   2. Hidden BrowserBridge — loads Battle Chronicle silently; works when
   *      the partition is warm but our HTTP recipe is slightly off.
   *   3. Visible BrowserBridge — surfaces the window so the user can solve
   *      mihoyo's anti-bot captcha. This is the only reliable path for a
   *      cold session; without it 5003 will persist indefinitely.
   *
   * Auth/rate-limit errors short-circuit before the visible step because
   * they're cookie/IP problems that another fetch can't fix.
   */
  async function fetchMiyousheRoster(
    uid: string,
    cookie: string | undefined
  ): Promise<
    | { ok: true; characters: MiyousheCharacterDetail[]; via: 'http' | 'bridge-hidden' | 'bridge-visible' }
    | { ok: false; via: 'http' | 'bridge'; failure: MiyousheFetchError | { kind: 'bridge'; message: string } }
  > {
    if (cookie) {
      const direct = await miyousheGameRecord.fetchCharacterDetails(uid, cookie);
      if (direct.ok) {
        return { ok: true, characters: direct.data, via: 'http' };
      }
      if (direct.error.kind === 'auth-expired' || direct.error.kind === 'rate-limited') {
        return { ok: false, via: 'http', failure: direct.error };
      }
    }

    // Hidden attempt — quick, no user-facing window if session is warm.
    const hidden = await miyousheBridge.fetchRoster({ visible: false });
    if (hidden.ok && hidden.mode === 'data') {
      if (hidden.uid && hidden.uid !== uid) {
        return {
          ok: false,
          via: 'bridge',
          failure: {
            kind: 'bridge',
            message: `Battle Chronicle 当前显示 UID ${hidden.uid}，与请求的 UID ${uid} 不一致；请在米游社内切换默认账号后重试`
          }
        };
      }
      return { ok: true, characters: hidden.characters, via: 'bridge-hidden' };
    }

    // Hidden failed (or returned warmup-only, which it shouldn't). Escalate
    // to visible warmup so the user can solve captcha; then retry direct HTTP.
    const hiddenFailed =
      !hidden.ok && (hidden.reason === 'timeout' || hidden.reason === 'upstream' || hidden.reason === 'navigation');
    if (hiddenFailed) {
      const visible = await miyousheBridge.fetchRoster({ visible: true });
      if (!visible.ok) {
        return {
          ok: false,
          via: 'bridge',
          failure: { kind: 'bridge', message: `验证窗口失败：${visible.message}` }
        };
      }
      // Warmup completed (user closed window / we saw /index 200). Retry HTTP.
      if (cookie) {
        const retry = await miyousheGameRecord.fetchCharacterDetails(uid, cookie);
        if (retry.ok) {
          return { ok: true, characters: retry.data, via: 'bridge-visible' };
        }
      }
      return {
        ok: false,
        via: 'bridge',
        failure: {
          kind: 'bridge',
          message:
            visible.mode === 'warmup' && visible.indexCalled
              ? '已观察到验证页 /index 调用，但后端 API 仍返回 5003。可能 IP 仍被限流，请稍后再试。'
              : '未观察到 /index 成功调用 — 请在验证窗口中点击进入「原神战绩」后再关闭窗口。'
        }
      };
    }

    return {
      ok: false,
      via: 'bridge',
      failure: { kind: 'bridge', message: hidden.ok ? '内部错误：hidden 模式返回 warmup' : hidden.message }
    };
  }

  registerHandler('miyoushe:bind', async (payload) => {
    const parsed = cookieSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(IpcErrorCodes.ValidationFailed, formatIssues(parsed.error.issues));
    }
    return miyoushe.fetchRoles(parsed.data.cookie);
  });

  registerHandler('miyoushe:login-via-browser', async () => {
    const outcome = await loginWindow.runOnce();
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason, message: outcome.message };
    }

    const bind = await miyoushe.fetchRoles(outcome.cookie);
    if (!bind.ok || bind.roles.length === 0) {
      return {
        ok: false,
        reason: 'bind-failed' as const,
        message: bind.message ?? '登录成功但获取角色列表失败'
      };
    }

    // Cookie is also persisted by Electron's session partition; seed the
    // in-memory roster store for every UID the account owns so refreshes
    // work immediately.
    for (const role of bind.roles) {
      rosterSessions.put(role.gameUid, outcome.cookie);
    }

    const sessionId = loginSessions.put(outcome.cookie);
    return { ok: true, bind: stripCookieFromBind(bind), sessionId };
  });

  registerHandler('miyoushe:logout', async () => {
    await loginWindow.clearPersistedCookie();
    rosterSessions.clear();
    return { ok: true } as const;
  });

  registerHandler('miyoushe:auth-state', async () => {
    const cookie = await loginWindow.readPersistedCookie();
    if (!cookie) {
      return { hasCookie: false, uids: [] };
    }
    const uids: string[] = [];
    const state = store.getStateView();
    for (const profile of state.profiles) {
      if (rosterSessions.hasCookie(profile.uid)) {
        uids.push(profile.uid);
      }
    }
    return { hasCookie: true, uids };
  });

  registerHandler('miyoushe:ping', async (payload) => {
    const parsed = uidSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, reason: formatIssues(parsed.error.issues) };
    }
    const cookie =
      rosterSessions.peek(parsed.data.uid) ?? (await loginWindow.readPersistedCookie());
    if (!cookie) {
      return { ok: false, reason: '没有可用的米游社登录态，请先登录' };
    }
    const result = await miyousheGameRecord.ping(parsed.data.uid, cookie);
    if (!result.ok) {
      return {
        ok: false,
        reason: `${result.error.kind}: ${result.error.message}`,
        retcode: 'retcode' in result.error ? result.error.retcode : undefined
      };
    }
    return {
      ok: true,
      nickname: result.data.nickname,
      worldLevel: result.data.worldLevel,
      totalCharacters: result.data.totalCharacters
    };
  });

  registerHandler('profile:state', async () => store.getStateView());

  registerHandler('profile:get', async (payload) => {
    const parsed = uidSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(IpcErrorCodes.ValidationFailed, formatIssues(parsed.error.issues));
    }
    return store.get(parsed.data.uid) ?? null;
  });

  registerHandler('profile:set-active', async (payload) => {
    const parsed = uidSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(IpcErrorCodes.ValidationFailed, formatIssues(parsed.error.issues));
    }
    try {
      store.setActive(parsed.data.uid);
    } catch (error) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        error instanceof Error ? error.message : 'Failed to set active UID'
      );
    }
    return { ok: true } as const;
  });

  registerHandler('profile:refresh', async (payload) => {
    const parsed = uidSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(IpcErrorCodes.ValidationFailed, formatIssues(parsed.error.issues));
    }

    const uid = parsed.data.uid;
    const existing = store.get(uid);

    let enkaCharacters: PersistedProfile['characters'] = existing?.characters ?? [];
    let enkaNickname: string | undefined = existing?.nickname;
    let enkaLevel: number | undefined = existing?.level;
    let enkaRegion: string | undefined = existing?.region;
    let enkaOk = false;
    let enkaError: string | undefined;
    try {
      const result = await enka.fetchProfile(uid);
      enkaCharacters = result.characters;
      enkaNickname = result.nickname ?? enkaNickname;
      enkaLevel = result.level ?? enkaLevel;
      enkaRegion = result.region ?? enkaRegion;
      enkaOk = true;
    } catch (error) {
      enkaError = error instanceof Error ? error.message : 'Enka request failed';
      if (!existing) {
        throw new IpcError(IpcErrorCodes.UpstreamUnavailable, enkaError, error);
      }
    }

    let miyousheCharacters: MiyousheCharacterDetail[] | undefined;
    let miyousheFailure: MiyousheFetchError | { kind: 'bridge'; message: string } | undefined;
    const cookie = rosterSessions.peek(uid);
    const result = await fetchMiyousheRoster(uid, cookie);
    if (result.ok) {
      miyousheCharacters = result.characters;
    } else {
      miyousheFailure = result.failure;
      if (
        'kind' in result.failure &&
        result.failure.kind === 'auth-expired'
      ) {
        rosterSessions.revoke(uid);
      }
    }

    const enkaFreshCount = enkaOk ? enkaCharacters.length : 0;
    const merged = mergeProfile({
      enkaCharacters,
      miyousheCharacters
    });

    const source = resolveRefreshSource({
      previous: existing?.source,
      hasEnka: enkaOk && enkaCharacters.length > 0,
      hasMiyoushe: miyousheCharacters !== undefined,
      miyousheStale: miyousheFailure !== undefined
    });

    const profile: PersistedProfile = {
      uid,
      region: enkaRegion,
      nickname: enkaNickname,
      level: enkaLevel,
      source,
      fetchedAt: new Date().toISOString(),
      characters: merged.characters
    };
    store.upsert(profile);

    const summary: RefreshSummary = {
      enka: enkaOk ? 'ok' : 'failed',
      enkaCharacterCount: enkaFreshCount,
      enkaError,
      miyoushe: miyousheStatus({
        hasCookie: cookie !== undefined,
        failure: miyousheFailure,
        ok: miyousheCharacters !== undefined
      }),
      miyousheCharacterCount: miyousheCharacters?.length ?? 0,
      miyousheError: miyousheFailure?.message,
      totalCharacterCount: profile.characters.length
    };

    return { profile, summary };
  });

  registerHandler('profile:delete', async (payload) => {
    const parsed = uidSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(IpcErrorCodes.ValidationFailed, formatIssues(parsed.error.issues));
    }
    store.remove(parsed.data.uid);
    return { ok: true } as const;
  });

  registerHandler('profile:import-from-cookie', async (payload) => {
    const parsed = importSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(IpcErrorCodes.ValidationFailed, formatIssues(parsed.error.issues));
    }
    return importWithCookie({ cookie: parsed.data.cookie, uid: parsed.data.uid });
  });

  registerHandler('profile:import-from-session', async (payload) => {
    const parsed = importFromSessionSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(IpcErrorCodes.ValidationFailed, formatIssues(parsed.error.issues));
    }

    const cookie = loginSessions.consume(parsed.data.sessionId);
    if (!cookie) {
      throw new IpcError(IpcErrorCodes.Unauthorized, '登录会话已过期，请重新登录');
    }

    return importWithCookie({ cookie, uid: parsed.data.uid });
  });

  async function importWithCookie(input: {
    cookie: string;
    uid?: string;
  }): Promise<PersistedProfile> {
    const bind = await miyoushe.fetchRoles(input.cookie);
    if (!bind.ok || bind.roles.length === 0) {
      throw new IpcError(
        IpcErrorCodes.Unauthorized,
        bind.message ?? '米游社绑定失败，请检查 Cookie 是否完整'
      );
    }

    const target =
      (input.uid ? bind.roles.find((role) => role.gameUid === input.uid) : undefined) ??
      bind.roles.slice().sort((a, b) => (b.level ?? 0) - (a.level ?? 0))[0] ??
      bind.roles[0];

    if (!target) {
      throw new IpcError(IpcErrorCodes.Internal, '无法选择 UID');
    }

    // Cache cookie under every UID this miyoushe account owns BEFORE trying
    // the roster fetch, so the bridge fallback (which reads cookies from the
    // partition) sees the right state.
    for (const role of bind.roles) {
      rosterSessions.put(role.gameUid, input.cookie);
    }

    // Pull full roster (game_record HTTP → BrowserBridge fallback).
    const recordResult = await fetchMiyousheRoster(target.gameUid, input.cookie);
    const miyousheCharacters = recordResult.ok ? recordResult.characters : undefined;
    const miyousheFailure = recordResult.ok ? undefined : recordResult.failure;

    // Pull Enka showcase for precise stats.
    let enkaCharacters: PersistedProfile['characters'] = [];
    let enkaNickname: string | undefined;
    let enkaLevel: number | undefined;
    let enkaOk = false;
    try {
      const enkaResult = await enka.fetchProfile(target.gameUid);
      enkaCharacters = enkaResult.characters;
      enkaNickname = enkaResult.nickname;
      enkaLevel = enkaResult.level;
      enkaOk = enkaResult.characters.length > 0;
    } catch {
      // Enka miss is OK; miyoushe alone is still useful.
    }

    const merged = mergeProfile({ enkaCharacters, miyousheCharacters });
    const source = resolveImportSource({
      hasEnka: enkaOk,
      hasMiyoushe: miyousheCharacters !== undefined,
      miyousheStale: miyousheFailure !== undefined
    });

    const profile: PersistedProfile = {
      uid: target.gameUid,
      region: target.region,
      nickname: enkaNickname ?? target.nickname,
      level: enkaLevel ?? target.level,
      source,
      fetchedAt: new Date().toISOString(),
      characters: merged.characters
    };

    store.upsert(profile);
    store.setActive(profile.uid);
    return profile;
  }
}

function stripCookieFromBind(bind: BindCookieResult): BindCookieResult {
  return {
    ok: bind.ok,
    retcode: bind.retcode,
    message: bind.message,
    roles: bind.roles
  };
}

function miyousheStatus(input: {
  hasCookie: boolean;
  ok: boolean;
  failure: MiyousheFetchError | { kind: 'bridge'; message: string } | undefined;
}): RefreshSourceStatus {
  if (input.ok) return 'ok';
  if (!input.hasCookie) return 'no-cookie';
  if (input.failure && 'kind' in input.failure) {
    if (input.failure.kind === 'auth-expired') return 'auth-expired';
    if (input.failure.kind === 'captcha-required') return 'captcha-required';
    if (input.failure.kind === 'rate-limited') return 'rate-limited';
  }
  return 'failed';
}

function resolveImportSource(input: {
  hasEnka: boolean;
  hasMiyoushe: boolean;
  miyousheStale: boolean;
}): ProfileSource {
  if (input.hasEnka && input.hasMiyoushe) return 'merged';
  if (input.hasMiyoushe) return 'miyoushe';
  if (input.hasEnka) return 'miyoushe+enka';
  if (input.miyousheStale) return 'miyoushe-stale';
  return 'miyoushe';
}

function resolveRefreshSource(input: {
  previous?: ProfileSource;
  hasEnka: boolean;
  hasMiyoushe: boolean;
  miyousheStale: boolean;
}): ProfileSource {
  if (input.hasEnka && input.hasMiyoushe) return 'merged';
  if (input.hasMiyoushe) return 'miyoushe';
  if (input.hasEnka) {
    return input.previous === 'merged' || input.previous === 'miyoushe-stale'
      ? 'miyoushe-stale'
      : input.previous ?? 'enka';
  }
  if (input.miyousheStale) return 'miyoushe-stale';
  return input.previous ?? 'enka';
}

function formatIssues(issues: Array<{ message: string }>): string {
  return issues.map((issue) => issue.message).join('; ');
}
