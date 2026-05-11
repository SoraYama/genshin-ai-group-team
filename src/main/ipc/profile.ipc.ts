import { z } from 'zod';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import type { BindCookieResult, PersistedProfile, ProfileSource } from '../../shared/domain.js';
import type { EnkaClient } from '../services/enka-client.js';
import type { LoginSessionStore } from '../services/login-session-store.js';
import type { MiyousheClient } from '../services/miyoushe-client.js';
import type { MiyousheLoginWindow } from '../services/miyoushe-login-window.js';
import type { ProfileStore } from '../services/profile-store.js';
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
  loginWindow: MiyousheLoginWindow;
  loginSessions: LoginSessionStore;
  enka: EnkaClient;
  store: ProfileStore;
}

export function registerProfileIpc({
  miyoushe,
  loginWindow,
  loginSessions,
  enka,
  store
}: ProfileIpcDeps): void {
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

    const sessionId = loginSessions.put(outcome.cookie);
    return { ok: true, bind: stripCookieFromBind(bind), sessionId };
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

    const existing = store.get(parsed.data.uid);
    let result;
    try {
      result = await enka.fetchProfile(parsed.data.uid);
    } catch (error) {
      throw new IpcError(
        IpcErrorCodes.UpstreamUnavailable,
        error instanceof Error ? error.message : 'Enka request failed',
        error
      );
    }

    const profile: PersistedProfile = {
      uid: result.uid,
      region: result.region ?? existing?.region,
      nickname: result.nickname ?? existing?.nickname,
      level: result.level ?? existing?.level,
      source: pickSource(existing?.source, 'enka'),
      fetchedAt: new Date().toISOString(),
      characters: result.characters
    };
    store.upsert(profile);
    return profile;
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

    let enkaCharacters: PersistedProfile['characters'] = [];
    let enkaNickname: string | undefined;
    let enkaLevel: number | undefined;
    let source: ProfileSource = 'miyoushe';

    try {
      const enkaResult = await enka.fetchProfile(target.gameUid);
      enkaCharacters = enkaResult.characters;
      enkaNickname = enkaResult.nickname;
      enkaLevel = enkaResult.level;
      source = enkaCharacters.length > 0 ? 'miyoushe+enka' : 'miyoushe';
    } catch {
      // Enka 失败保留 miyoushe-only 数据
    }

    const profile: PersistedProfile = {
      uid: target.gameUid,
      region: target.region,
      nickname: enkaNickname ?? target.nickname,
      level: enkaLevel ?? target.level,
      source,
      fetchedAt: new Date().toISOString(),
      characters: enkaCharacters
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

function pickSource(prev: ProfileSource | undefined, next: ProfileSource): ProfileSource {
  if (prev === 'miyoushe+enka' && next === 'enka') {
    return 'miyoushe+enka';
  }
  if (prev === 'miyoushe' && next === 'enka') {
    return 'miyoushe+enka';
  }
  return next;
}

function formatIssues(issues: Array<{ message: string }>): string {
  return issues.map((issue) => issue.message).join('; ');
}
