import { z } from 'zod';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import type {
  BindCookieResult,
  PersistedProfile,
  RefreshSourceStatus,
  RefreshSummary
} from '../../shared/domain.js';
import type { EnkaClient } from '../services/enka-client.js';
import type { LoginSessionStore, RosterSessionStore } from '../services/login-session-store.js';
import type { MiyousheClient } from '../services/miyoushe-client.js';
import type { MiyousheCalculatorClient } from '../services/miyoushe-calculator.js';
import type {
  MiyousheCharacterDetail,
  MiyousheFetchError,
  MiyousheGameRecordClient,
  MiyousheRosterCoverage
} from '../services/miyoushe-game-record.js';
import type { MiyousheBrowserBridge } from '../services/miyoushe/browser-bridge.js';
import type {
  LifecycleMiyousheDeviceFp,
  MiyoushePartitionLifecycle
} from '../services/miyoushe/partition-lifecycle.js';
import type { MiyousheLoginWindow } from '../services/miyoushe-login-window.js';
import type { ProfileStore } from '../services/profile-store.js';
import { mergeProfile } from '../services/profile-merger.js';
import { registerHandler } from './registry.js';

const cookieSchema = z.object({
  cookie: z.string().min(10, 'Cookie 长度异常')
});

const importSchema = z.object({
  cookie: z.string().min(10, 'Cookie 长度异常'),
  uid: z
    .string()
    .regex(/^\d{9}$/, 'UID 必须为 9 位数字')
    .optional()
});

const uidSchema = z.object({
  uid: z.string().regex(/^\d{9}$/, 'UID 必须为 9 位数字')
});

const importFromSessionSchema = z.object({
  sessionId: z.string().min(8),
  uid: z
    .string()
    .regex(/^\d{9}$/, 'UID 必须为 9 位数字')
    .optional()
});

export interface ProfileIpcDeps {
  miyoushe: MiyousheClient;
  miyousheGameRecord: MiyousheGameRecordClient;
  miyousheCalculator: MiyousheCalculatorClient;
  miyousheBridge: MiyousheBrowserBridge;
  deviceFp: Pick<LifecycleMiyousheDeviceFp, 'ensureForSessionAt'>;
  partitionLifecycle: Pick<
    MiyoushePartitionLifecycle,
    'capture' | 'transition' | 'isCurrent' | 'runAt'
  >;
  loginWindow: MiyousheLoginWindow;
  loginSessions: LoginSessionStore;
  rosterSessions: RosterSessionStore;
  enka: EnkaClient;
  store: ProfileStore;
}

export function registerProfileIpc({
  miyoushe,
  miyousheGameRecord,
  miyousheCalculator,
  miyousheBridge,
  deviceFp,
  partitionLifecycle,
  loginWindow,
  loginSessions,
  rosterSessions,
  enka,
  store
}: ProfileIpcDeps): void {
  /**
   * Roster fetch order:
   *   1. Battle Chronicle HTTP for the richest official detail payload.
   *   2. Enhancement-calculator sync for authoritative ownership when the
   *      Battle Chronicle endpoint is pinned at 5003.
   *   3. BrowserBridge only for non-captcha transport/page failures.
   *
   * Auth/rate-limit errors short-circuit because another transport cannot
   * repair the account session or IP limit. A direct 5003 never opens a
   * futile captcha loop: calculator success wins; calculator failure is
   * surfaced verbatim.
   */
  async function fetchMiyousheRoster(
    uid: string,
    cookie: string | undefined
  ): Promise<
    | {
        ok: true;
        characters: MiyousheCharacterDetail[];
        coverage: MiyousheRosterCoverage;
        via: 'http' | 'calculator' | 'bridge-hidden' | 'bridge-visible';
      }
    | {
        ok: false;
        via: 'http' | 'bridge';
        failure: MiyousheFetchError | { kind: 'bridge'; message: string };
      }
  > {
    if (!cookie) {
      return {
        ok: false,
        via: 'bridge',
        failure: { kind: 'bridge', message: '没有可用的米游社登录态，请先登录' }
      };
    }

    const index = await miyousheGameRecord.fetchPlayerIndex(uid, cookie);
    const direct = index.ok
      ? await miyousheGameRecord.fetchDetailedRoster(uid, cookie, {
          expectedOwnedCount: index.data.totalCharacters
        })
      : index;
    if (direct.ok) {
      return {
        ok: true,
        characters: direct.data.characters,
        coverage: direct.data.coverage,
        via: 'http'
      };
    }
    if (direct.error.kind === 'auth-expired' || direct.error.kind === 'rate-limited') {
      return { ok: false, via: 'http', failure: direct.error };
    }

    // The enhancement calculator has its own signed sync endpoint and risk
    // policy. It returns the complete owned roster (plus weapon/talent basics)
    // even when Battle Chronicle is pinned at 5003. This is now the supported
    // 5003 recovery path; promoting 5003 into the H5's 1034 GeeTest branch was
    // tested live and the official verifier correctly rejected it as 10306.
    const calculator = await miyousheCalculator.fetchOwnedRoster(uid, cookie);
    if (calculator.ok) {
      return {
        ok: true,
        characters: calculator.data.characters,
        coverage: calculator.data.coverage,
        via: 'calculator'
      };
    }
    if (direct.error.kind === 'captcha-required') {
      return { ok: false, via: 'http', failure: calculator.error };
    }

    const hidden = await miyousheBridge.fetchRoster({ visible: false, uid });
    if (hidden?.ok && hidden.mode === 'data') {
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
      return {
        ok: true,
        characters: hidden.characters,
        coverage: hidden.coverage,
        via: 'bridge-hidden'
      };
    }

    // Hidden failed (or returned warmup-only, which it shouldn't). Escalate
    // to visible warmup so the user can solve captcha; then retry direct HTTP.
    const hiddenFailed =
      !hidden.ok &&
      (hidden.reason === 'timeout' ||
        hidden.reason === 'upstream' ||
        hidden.reason === 'navigation' ||
        hidden.reason === 'parse');
    if (hiddenFailed) {
      const visible = await miyousheBridge.fetchRoster({ visible: true, uid });
      if (!visible.ok) {
        return {
          ok: false,
          via: 'bridge',
          failure: { kind: 'bridge', message: `验证窗口失败：${visible.message}` }
        };
      }
      // Warmup completed (user closed window / we saw /index 200). Retry HTTP.
      const refreshedCookie = (await loginWindow.readPersistedCookie()) ?? cookie;
      if (refreshedCookie) {
        rosterSessions.put(uid, refreshedCookie);
        const index = await miyousheGameRecord.fetchPlayerIndex(uid, refreshedCookie);
        const retry = index.ok
          ? await miyousheGameRecord.fetchDetailedRoster(uid, refreshedCookie, {
              expectedOwnedCount: index.data.totalCharacters
            })
          : index;
        if (retry.ok) {
          return {
            ok: true,
            characters: retry.data.characters,
            coverage: retry.data.coverage,
            via: 'bridge-visible'
          };
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
      failure: {
        kind: 'bridge',
        message: hidden.ok ? '内部错误：hidden 模式返回 warmup' : hidden.message
      }
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
    const { generation } = await partitionLifecycle.transition(undefined, {
      beforeDrain: () => loginWindow.cancelActiveLogin()
    });
    const outcome = await partitionLifecycle.runAt(generation, () => loginWindow.runOnce());
    if (!outcome || !partitionLifecycle.isCurrent(generation)) {
      return { ok: false, reason: 'cancelled' as const };
    }
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason, message: outcome.message };
    }

    let cookie = outcome.cookie;
    try {
      const deviceResult = await deviceFp.ensureForSessionAt(generation, cookie);
      if (!deviceResult || !partitionLifecycle.isCurrent(generation)) {
        return { ok: false, reason: 'cancelled' as const };
      }
      cookie = deviceResult.cookie;
    } catch {
      if (!partitionLifecycle.isCurrent(generation)) {
        return { ok: false, reason: 'cancelled' as const };
      }
      // Device recovery is best-effort. Keep the authenticated browser Cookie
      // and do not log a potentially sensitive rejection.
    }

    const bind = await miyoushe.fetchRoles(cookie);
    if (!partitionLifecycle.isCurrent(generation)) {
      return { ok: false, reason: 'cancelled' as const };
    }
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
      rosterSessions.put(role.gameUid, cookie);
    }

    const sessionId = loginSessions.put(cookie);
    return { ok: true, bind: stripCookieFromBind(bind), sessionId };
  });

  registerHandler('miyoushe:logout', async () => {
    loginSessions.clear();
    rosterSessions.clear();
    try {
      await partitionLifecycle.transition(() => loginWindow.clearPersistedCookie(), {
        beforeDrain: () => loginWindow.cancelActiveLogin()
      });
    } finally {
      // A stale request may have reached an internal roster fallback before
      // its generation check. Clear after tracked operations drain or fail.
      rosterSessions.clear();
    }
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
    const generation = partitionLifecycle.capture();
    const cookie =
      rosterSessions.peek(parsed.data.uid) ?? (await loginWindow.readPersistedCookie());
    if (!partitionLifecycle.isCurrent(generation)) {
      return staleMiyousheRequestResult();
    }
    if (!cookie) {
      return { ok: false, reason: '没有可用的米游社登录态，请先登录' };
    }
    const result = await partitionLifecycle.runAt(generation, () =>
      miyousheGameRecord.ping(parsed.data.uid, cookie)
    );
    if (!result || !partitionLifecycle.isCurrent(generation)) {
      return staleMiyousheRequestResult();
    }
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

    const generation = partitionLifecycle.capture();
    const assertCurrent = () => {
      if (!partitionLifecycle.isCurrent(generation)) throw staleMiyousheRequestError();
    };
    const uid = parsed.data.uid;
    const existing = store.get(uid);

    let enkaCharacters: PersistedProfile['characters'] = [];
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
        assertCurrent();
        throw new IpcError(IpcErrorCodes.UpstreamUnavailable, enkaError, error);
      }
    }
    assertCurrent();

    let miyousheCharacters: MiyousheCharacterDetail[] | undefined;
    let miyousheCoverage: MiyousheRosterCoverage | undefined;
    let miyousheFailure: MiyousheFetchError | { kind: 'bridge'; message: string } | undefined;
    const cookie = rosterSessions.peek(uid) ?? (await loginWindow.readPersistedCookie());
    assertCurrent();
    if (cookie && !rosterSessions.hasCookie(uid)) {
      rosterSessions.put(uid, cookie);
    }
    const result = await partitionLifecycle.runAt(generation, () =>
      fetchMiyousheRoster(uid, cookie)
    );
    if (!result || !partitionLifecycle.isCurrent(generation)) {
      throw staleMiyousheRequestError();
    }
    if (result.ok) {
      miyousheCharacters = result.characters;
      miyousheCoverage = result.coverage;
    } else {
      miyousheFailure = result.failure;
      if ('kind' in result.failure && result.failure.kind === 'auth-expired') {
        rosterSessions.revoke(uid);
      }
    }

    const enkaFreshCount = enkaOk ? enkaCharacters.length : 0;
    if (!enkaOk && miyousheCharacters === undefined && existing) {
      return {
        profile: existing,
        summary: {
          enka: 'failed',
          enkaCharacterCount: 0,
          enkaError,
          miyoushe: miyousheStatus({
            hasCookie: cookie !== undefined,
            failure: miyousheFailure,
            ok: false
          }),
          miyousheCharacterCount: 0,
          miyousheError: miyousheFailure?.message,
          totalCharacterCount: existing.characters.length
        }
      };
    }
    const merged = mergeProfile({
      enkaCharacters,
      miyousheCharacters,
      miyousheCoverage,
      cachedProfile: existing
        ? { characters: existing.characters, coverage: existing.coverage }
        : undefined,
      ownershipSource: result.ok ? 'miyoushe-list' : 'miyoushe-index'
    });

    const profile: PersistedProfile = {
      schemaVersion: 2,
      uid,
      region: enkaRegion,
      nickname: enkaNickname,
      level: enkaLevel,
      source: merged.source,
      fetchedAt: new Date().toISOString(),
      characters: merged.characters,
      coverage: merged.coverage
    };
    assertCurrent();
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
    const generation = partitionLifecycle.capture();
    const imported = await partitionLifecycle.runAt(generation, () =>
      importWithCookie({ cookie: parsed.data.cookie, uid: parsed.data.uid, generation })
    );
    if (!imported) throw staleMiyousheRequestError();
    return imported;
  });

  registerHandler('profile:import-from-session', async (payload) => {
    const parsed = importFromSessionSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(IpcErrorCodes.ValidationFailed, formatIssues(parsed.error.issues));
    }

    const generation = partitionLifecycle.capture();
    const cookie = loginSessions.consume(parsed.data.sessionId);
    if (!cookie) {
      throw expiredLoginSessionError();
    }

    const imported = await partitionLifecycle.runAt(generation, () =>
      importWithCookie({ cookie, uid: parsed.data.uid, generation })
    );
    if (!imported) throw expiredLoginSessionError();
    return imported;
  });

  async function importWithCookie(input: {
    cookie: string;
    uid?: string;
    generation: number;
  }): Promise<PersistedProfile> {
    const assertCurrent = () => {
      if (!partitionLifecycle.isCurrent(input.generation)) {
        throw staleMiyousheRequestError();
      }
    };

    assertCurrent();
    const bind = await miyoushe.fetchRoles(input.cookie);
    assertCurrent();
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

    const existing = store.get(target.gameUid);

    // Cache cookie under every UID this miyoushe account owns BEFORE trying
    // the roster fetch, so the bridge fallback (which reads cookies from the
    // partition) sees the right state.
    assertCurrent();
    for (const role of bind.roles) {
      rosterSessions.put(role.gameUid, input.cookie);
    }

    // Pull full roster (game_record HTTP → calculator sync → bridge).
    const recordResult = await fetchMiyousheRoster(target.gameUid, input.cookie);
    assertCurrent();
    const miyousheCharacters = recordResult.ok ? recordResult.characters : undefined;

    // Pull Enka showcase for precise stats.
    let enkaCharacters: PersistedProfile['characters'] = [];
    let enkaNickname: string | undefined;
    let enkaLevel: number | undefined;
    try {
      const enkaResult = await enka.fetchProfile(target.gameUid);
      enkaCharacters = enkaResult.characters;
      enkaNickname = enkaResult.nickname;
      enkaLevel = enkaResult.level;
    } catch {
      // Enka miss is OK; miyoushe alone is still useful.
    }
    assertCurrent();

    const merged = mergeProfile({
      enkaCharacters,
      miyousheCharacters,
      miyousheCoverage: recordResult.ok ? recordResult.coverage : undefined,
      cachedProfile: existing
        ? { characters: existing.characters, coverage: existing.coverage }
        : undefined,
      ownershipSource: recordResult.ok ? 'miyoushe-list' : 'miyoushe-index'
    });

    const profile: PersistedProfile = {
      schemaVersion: 2,
      uid: target.gameUid,
      region: target.region,
      nickname: enkaNickname ?? target.nickname,
      level: enkaLevel ?? target.level,
      source: merged.source,
      fetchedAt: new Date().toISOString(),
      characters: merged.characters,
      coverage: merged.coverage
    };

    assertCurrent();
    store.upsert(profile);
    assertCurrent();
    store.setActive(profile.uid);
    return profile;
  }
}

function expiredLoginSessionError(): IpcError {
  return new IpcError(IpcErrorCodes.Unauthorized, '登录会话已过期，请重新登录');
}

function staleMiyousheRequestError(): IpcError {
  return new IpcError(IpcErrorCodes.Unauthorized, '米游社登录状态已变更，请重试');
}

function staleMiyousheRequestResult(): { ok: false; reason: string } {
  return { ok: false, reason: '米游社登录状态已变更，请重试' };
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

function formatIssues(issues: Array<{ message: string }>): string {
  return issues.map((issue) => issue.message).join('; ');
}
