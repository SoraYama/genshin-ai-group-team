import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CharacterProfile,
  PersistedProfile,
  RefreshOutcome
} from '../../../src/shared/domain.js';
import type {
  MiyousheCharacterDetail,
  MiyousheRosterCoverage
} from '../../../src/main/services/miyoushe-game-record.js';
import { MiyoushePartitionLifecycle } from '../../../src/main/services/miyoushe/partition-lifecycle.js';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
}));

vi.mock('../../../src/main/ipc/registry.js', () => ({
  registerHandler: (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) => {
    handlers.set(channel, handler);
  }
}));

import { registerProfileIpc, type ProfileIpcDeps } from '../../../src/main/ipc/profile.ipc.js';

const UID = '100000001';
const SECOND_UID = '100000002';
const FETCHED_AT = '2026-01-01T00:00:00.000Z';
const COOKIE = 'ltoken_v2=test; ltuid_v2=test; ltmid_v2=test';
const COMPLETED_COOKIE = `${COOKIE}; _MHYUUID=device; DEVICEFP=fingerprint`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 150): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const fullCoverageForTwo: MiyousheRosterCoverage = {
  expectedOwnedCount: 2,
  listedCount: 2,
  detailedCount: 2,
  missingCharacterIds: [],
  duplicateCharacterIds: [],
  unexpectedCharacterIds: [],
  failedBatches: [],
  partial: false,
  fields: { weapon: 2, artifacts: 2, talents: 2, stats: 2 }
};

function cachedOwnedCharacter(id: number): CharacterProfile {
  return {
    id,
    name: `Cached-${id}`,
    element: 'Pyro',
    rarity: 5,
    imageUrl: `cached-${id}.png`,
    level: 90,
    source: 'miyoushe',
    completeness: 'basic',
    missingFields: ['stats', 'weapon', 'artifacts', 'talents'],
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt: FETCHED_AT }
    }
  };
}

function enkaCharacter(id: number): CharacterProfile {
  return {
    id,
    name: `Enka-${id}`,
    element: 'Pyro',
    rarity: 5,
    imageUrl: `enka-${id}.png`,
    level: 90,
    build: { stats: { hp: 35000 } },
    source: 'enka',
    completeness: 'build',
    missingFields: ['weapon', 'artifacts', 'talents'],
    provenance: {
      ownership: { source: 'enka', fetchedAt: FETCHED_AT },
      stats: { source: 'enka', fetchedAt: FETCHED_AT }
    }
  };
}

function miyousheCharacter(id: number): MiyousheCharacterDetail {
  return {
    id,
    name: `Miyoushe-${id}`,
    element: 'Pyro',
    level: 90,
    rarity: 5,
    iconUrl: `miyoushe-${id}.png`,
    constellation: 0,
    friendship: 10,
    stats: { hp: 30000 },
    artifacts: []
  };
}

function existingProfile(): PersistedProfile {
  return {
    schemaVersion: 2,
    uid: UID,
    source: 'miyoushe',
    fetchedAt: FETCHED_AT,
    characters: [cachedOwnedCharacter(1), cachedOwnedCharacter(2)],
    coverage: {
      expectedOwnedCount: 2,
      ownedCount: 2,
      detailedCount: 0,
      buildCount: 0,
      statsCount: 0,
      enkaShowcaseCount: 0,
      missingDetailCount: 2,
      partial: false
    }
  };
}

function setup(existing: PersistedProfile | undefined) {
  const partitionLifecycle = new MiyoushePartitionLifecycle();
  const loginSessionEntries = new Map<string, string>();
  const ensureForSession = vi.fn().mockImplementation(async (cookie: string) => ({
    ok: true,
    cookie,
    deviceHash: '0123456789ab',
    refreshed: false
  }));
  const deps = {
    miyoushe: {
      fetchRoles: vi.fn()
    },
    miyousheGameRecord: {
      fetchPlayerIndex: vi.fn(),
      fetchDetailedRoster: vi.fn(),
      ping: vi.fn()
    },
    miyousheCalculator: {
      fetchOwnedRoster: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'upstream', retcode: -502002, message: 'sync disabled' }
      })
    },
    miyousheBridge: {
      fetchRoster: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'navigation',
        message: 'not authenticated'
      })
    },
    deviceFp: {
      ensureForSession,
      ensureForSessionAt: vi
        .fn()
        .mockImplementation(async (generation: number, cookie: string) =>
          partitionLifecycle.runAt(generation, () => ensureForSession(cookie))
        )
    },
    partitionLifecycle,
    loginWindow: {
      runOnce: vi.fn(),
      cancelActiveLogin: vi.fn(),
      readPersistedCookie: vi.fn(),
      clearPersistedCookie: vi.fn()
    },
    loginSessions: {
      put: vi.fn().mockImplementation((cookie: string) => {
        const sessionId = 'login-session-id';
        loginSessionEntries.set(sessionId, cookie);
        return sessionId;
      }),
      consume: vi.fn().mockImplementation((sessionId: string) => {
        const cookie = loginSessionEntries.get(sessionId);
        loginSessionEntries.delete(sessionId);
        return cookie;
      }),
      clear: vi.fn().mockImplementation(() => loginSessionEntries.clear())
    },
    rosterSessions: {
      peek: vi.fn(),
      put: vi.fn(),
      hasCookie: vi.fn().mockReturnValue(false),
      revoke: vi.fn(),
      clear: vi.fn()
    },
    enka: {
      fetchProfile: vi.fn().mockResolvedValue({
        uid: UID,
        ttlSeconds: 60,
        showcaseStatus: 'available',
        characters: [enkaCharacter(1)]
      })
    },
    store: {
      get: vi.fn().mockReturnValue(existing),
      upsert: vi.fn(),
      setActive: vi.fn(),
      getStateView: vi.fn(),
      remove: vi.fn()
    }
  };

  registerProfileIpc(deps as unknown as ProfileIpcDeps);
  return deps;
}

async function refresh(): Promise<RefreshOutcome> {
  const handler = handlers.get('profile:refresh');
  if (!handler) throw new Error('profile:refresh handler was not registered');
  return (await handler({ uid: UID })) as RefreshOutcome;
}

async function importFromCookie(): Promise<PersistedProfile> {
  const handler = handlers.get('profile:import-from-cookie');
  if (!handler) throw new Error('profile:import-from-cookie handler was not registered');
  return (await handler({ uid: UID, cookie: COOKIE })) as PersistedProfile;
}

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('miyoushe:login-via-browser device recovery', () => {
  function successfulBind() {
    return {
      ok: true as const,
      roles: [
        { gameUid: UID, region: 'cn_gf01', nickname: 'Traveler', level: 60 },
        { gameUid: SECOND_UID, region: 'cn_gf01', nickname: 'Traveler 2', level: 59 }
      ]
    };
  }

  async function loginViaBrowser(): Promise<unknown> {
    const handler = handlers.get('miyoushe:login-via-browser');
    if (!handler) throw new Error('miyoushe:login-via-browser handler was not registered');
    return handler(undefined);
  }

  async function logout(): Promise<unknown> {
    const handler = handlers.get('miyoushe:logout');
    if (!handler) throw new Error('miyoushe:logout handler was not registered');
    return handler(undefined);
  }

  async function importFromSession(sessionId: string): Promise<unknown> {
    const handler = handlers.get('profile:import-from-session');
    if (!handler) throw new Error('profile:import-from-session handler was not registered');
    return handler({ sessionId, uid: UID });
  }

  it('uses the completed Cookie everywhere without exposing device recovery details', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.deviceFp.ensureForSession.mockResolvedValue({
      ok: true,
      cookie: COMPLETED_COOKIE,
      deviceHash: '0123456789ab',
      refreshed: true
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());
    deps.loginSessions.put.mockReturnValue('login-session-id');

    const result = await loginViaBrowser();

    expect(deps.deviceFp.ensureForSession).toHaveBeenCalledWith(COOKIE);
    expect(deps.miyoushe.fetchRoles).toHaveBeenCalledWith(COMPLETED_COOKIE);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COMPLETED_COOKIE);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(SECOND_UID, COMPLETED_COOKIE);
    expect(deps.loginSessions.put).toHaveBeenCalledWith(COMPLETED_COOKIE);
    expect(result).toEqual({
      ok: true,
      bind: { ok: true, roles: successfulBind().roles },
      sessionId: 'login-session-id'
    });
    expect(JSON.stringify(result)).not.toContain(COMPLETED_COOKIE);
    expect(JSON.stringify(result)).not.toContain('deviceHash');
    expect(JSON.stringify(result)).not.toContain('refreshed');
  });

  it('continues with the completed Cookie when device recovery is cooling down', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.deviceFp.ensureForSession.mockResolvedValue({
      ok: false,
      cookie: COMPLETED_COOKIE,
      reason: 'cooldown',
      retryAt: 1_800_000_000_000
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());
    deps.loginSessions.put.mockReturnValue('login-session-id');

    const result = await loginViaBrowser();

    expect(deps.miyoushe.fetchRoles).toHaveBeenCalledWith(COMPLETED_COOKIE);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COMPLETED_COOKIE);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(SECOND_UID, COMPLETED_COOKIE);
    expect(deps.loginSessions.put).toHaveBeenCalledWith(COMPLETED_COOKIE);
    expect(result).toMatchObject({ ok: true, sessionId: 'login-session-id' });
    expect(JSON.stringify(result)).not.toContain('cooldown');
    expect(JSON.stringify(result)).not.toContain('retryAt');
  });

  it('falls back to the login Cookie when device recovery rejects without leaking the error', async () => {
    const deps = setup(undefined);
    const secret = 'device-recovery-secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.deviceFp.ensureForSession.mockRejectedValue(new Error(secret));
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());
    deps.loginSessions.put.mockReturnValue('login-session-id');

    const result = await loginViaBrowser();

    expect(deps.deviceFp.ensureForSession).toHaveBeenCalledWith(COOKIE);
    expect(deps.miyoushe.fetchRoles).toHaveBeenCalledWith(COOKIE);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COOKIE);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(SECOND_UID, COOKIE);
    expect(deps.loginSessions.put).toHaveBeenCalledWith(COOKIE);
    expect(result).toMatchObject({ ok: true, sessionId: 'login-session-id' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain(secret);
  });

  it('does not seed either session store when role binding fails', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.deviceFp.ensureForSession.mockResolvedValue({
      ok: true,
      cookie: COMPLETED_COOKIE,
      deviceHash: '0123456789ab',
      refreshed: true
    });
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: false,
      reason: 'auth-expired',
      message: 'Cookie expired'
    });

    const result = await loginViaBrowser();

    expect(deps.deviceFp.ensureForSession).toHaveBeenCalledWith(COOKIE);
    expect(result).toEqual({
      ok: false,
      reason: 'bind-failed',
      message: 'Cookie expired'
    });
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
    expect(deps.loginSessions.put).not.toHaveBeenCalled();
  });

  it('does not commit a browser login whose device recovery finishes after logout', async () => {
    const deps = setup(undefined);
    const pendingEnsure = deferred<{
      ok: true;
      cookie: string;
      deviceHash: string;
      refreshed: boolean;
    }>();
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.deviceFp.ensureForSession.mockReturnValue(pendingEnsure.promise);
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());

    const loginPromise = loginViaBrowser();
    await vi.waitFor(() => {
      expect(
        deps.deviceFp.ensureForSession.mock.calls.length +
          deps.deviceFp.ensureForSessionAt.mock.calls.length
      ).toBeGreaterThan(0);
    });

    const logoutPromise = logout();
    await Promise.resolve();
    expect(deps.loginWindow.clearPersistedCookie).not.toHaveBeenCalled();

    pendingEnsure.resolve({
      ok: true,
      cookie: COMPLETED_COOKIE,
      deviceHash: '0123456789ab',
      refreshed: true
    });
    const [result] = await Promise.all([loginPromise, logoutPromise]);

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(deps.loginWindow.clearPersistedCookie).toHaveBeenCalledOnce();
    expect(deps.miyoushe.fetchRoles).not.toHaveBeenCalled();
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
    expect(deps.loginSessions.put).not.toHaveBeenCalled();
  });

  it('cancels and drains an active login window before logout clears the partition', async () => {
    const deps = setup(undefined);
    const pendingLogin = deferred<{
      ok: false;
      reason: 'cancelled';
    }>();
    const events: string[] = [];
    let loginWindowClosed = false;
    let loginWindowActive = false;
    deps.loginWindow.runOnce.mockImplementation(() => {
      loginWindowActive = true;
      return pendingLogin.promise;
    });
    deps.loginWindow.cancelActiveLogin.mockImplementation(() => {
      if (!loginWindowActive) return;
      events.push('login-window-closed');
      loginWindowActive = false;
      loginWindowClosed = true;
      pendingLogin.resolve({ ok: false, reason: 'cancelled' });
    });
    deps.loginWindow.clearPersistedCookie.mockImplementation(async () => {
      events.push('partition-cleared');
    });

    const loginPromise = loginViaBrowser();
    await vi.waitFor(() => expect(deps.loginWindow.runOnce).toHaveBeenCalledOnce());
    deps.loginWindow.cancelActiveLogin.mockClear();

    const logoutResult = await logout();
    expect(deps.loginWindow.cancelActiveLogin).toHaveBeenCalledOnce();
    const loginResult = await loginPromise;
    if (!loginWindowClosed) events.push('late-browser-cookie-write');

    expect(logoutResult).toEqual({ ok: true });
    expect(loginResult).toEqual({ ok: false, reason: 'cancelled' });
    expect(events).toEqual(['login-window-closed', 'partition-cleared']);
    expect(deps.deviceFp.ensureForSession).not.toHaveBeenCalled();
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
    expect(deps.loginSessions.put).not.toHaveBeenCalled();
  });

  it('invalidates every opaque login session when logging out', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());

    const loginResult = (await loginViaBrowser()) as { ok: true; sessionId: string };
    deps.miyoushe.fetchRoles.mockClear();

    await logout();

    await expect(importFromSession(loginResult.sessionId)).rejects.toMatchObject({
      code: 'IPC_UNAUTHORIZED'
    });
    expect(deps.loginSessions.clear).toHaveBeenCalledOnce();
    expect(deps.miyoushe.fetchRoles).not.toHaveBeenCalled();
  });

  it('revokes an opaque session before waiting for an older lifecycle operation', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());
    const loginResult = (await loginViaBrowser()) as { ok: true; sessionId: string };
    deps.miyoushe.fetchRoles.mockReset();

    const releaseOlderOperation = deferred<void>();
    const olderOperation = deps.partitionLifecycle.runAt(
      deps.partitionLifecycle.capture(),
      () => releaseOlderOperation.promise
    );
    const logoutPromise = logout();
    await Promise.resolve();

    const importError = await importFromSession(loginResult.sessionId).then(
      () => undefined,
      (error: unknown) => error
    );
    releaseOlderOperation.resolve();
    await Promise.all([olderOperation, logoutPromise]);

    expect(importError).toMatchObject({ code: 'IPC_UNAUTHORIZED' });
    expect(deps.loginSessions.clear).toHaveBeenCalledOnce();
    expect(deps.miyoushe.fetchRoles).not.toHaveBeenCalled();
  });

  it('drains an in-flight session import without allowing stale commits after logout', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());
    const loginResult = (await loginViaBrowser()) as { ok: true; sessionId: string };
    deps.miyoushe.fetchRoles.mockReset();
    deps.rosterSessions.put.mockClear();

    const pendingBind = deferred<ReturnType<typeof successfulBind>>();
    deps.miyoushe.fetchRoles.mockReturnValue(pendingBind.promise);
    const importPromise = importFromSession(loginResult.sessionId);
    await vi.waitFor(() => expect(deps.miyoushe.fetchRoles).toHaveBeenCalledOnce());

    const logoutPromise = logout();
    await Promise.resolve();
    const partitionClearedBeforeImportSettled =
      deps.loginWindow.clearPersistedCookie.mock.calls.length > 0;

    pendingBind.resolve(successfulBind());
    const importError = await importPromise.then(
      () => undefined,
      (error: unknown) => error
    );
    await logoutPromise;

    expect(partitionClearedBeforeImportSettled).toBe(false);
    expect(importError).toMatchObject({ code: 'IPC_UNAUTHORIZED' });
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
    expect(deps.store.upsert).not.toHaveBeenCalled();
    expect(deps.store.setActive).not.toHaveBeenCalled();
  });

  it('does not deadlock when an in-flight import enters nested device recovery during logout', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());
    const loginResult = (await loginViaBrowser()) as { ok: true; sessionId: string };
    deps.rosterSessions.put.mockClear();
    deps.rosterSessions.clear.mockClear();
    deps.miyoushe.fetchRoles.mockClear();

    const initial5003Reached = deferred<void>();
    const continueRecovery = deferred<void>();
    const persistedDeviceCookie = vi.fn().mockResolvedValue(undefined);
    const guardedWriter = deps.partitionLifecycle.guardCookieWriter({
      writeDeviceCookies: persistedDeviceCookie
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());
    deps.miyousheGameRecord.fetchPlayerIndex.mockImplementation(async () => {
      initial5003Reached.resolve();
      await continueRecovery.promise;
      try {
        await deps.partitionLifecycle.runCurrent(() =>
          guardedWriter.writeDeviceCookies({ DEVICEFP: 'stale-fingerprint' })
        );
      } catch {
        // Mirrors GameRecord's non-fatal recovery containment.
      }
      return {
        ok: false,
        error: { kind: 'captcha-required', retcode: 5003, message: 'risk control' }
      };
    });

    const importGeneration = deps.partitionLifecycle.capture();
    const importPromise = importFromSession(loginResult.sessionId);
    await initial5003Reached.promise;
    const rosterPutsBeforeLogout = deps.rosterSessions.put.mock.calls.length;

    const logoutPromise = logout();
    await vi.waitFor(() => expect(deps.partitionLifecycle.isCurrent(importGeneration)).toBe(false));
    continueRecovery.resolve();

    let importError: unknown;
    const completed = settlesWithin(
      Promise.all([
        importPromise.catch((error: unknown) => {
          importError = error;
        }),
        logoutPromise
      ])
    );

    expect(await completed).toBe(true);
    expect(importError).toMatchObject({ code: 'IPC_UNAUTHORIZED' });
    expect(persistedDeviceCookie).not.toHaveBeenCalled();
    expect(deps.rosterSessions.put).toHaveBeenCalledTimes(rosterPutsBeforeLogout);
    expect(deps.rosterSessions.clear).toHaveBeenCalledTimes(2);
    expect(deps.store.upsert).not.toHaveBeenCalled();
    expect(deps.store.setActive).not.toHaveBeenCalled();
  });
});

describe('profile:refresh roster integrity', () => {
  it('recovers a persisted Cookie before fetching the authoritative roster', async () => {
    const deps = setup(undefined);
    deps.rosterSessions.peek.mockReturnValue(undefined);
    deps.loginWindow.readPersistedCookie.mockResolvedValue(COOKIE);
    deps.miyousheGameRecord.fetchPlayerIndex.mockResolvedValue({
      ok: true,
      data: { totalCharacters: 2 }
    });
    deps.miyousheGameRecord.fetchDetailedRoster.mockResolvedValue({
      ok: true,
      data: {
        characters: [miyousheCharacter(1), miyousheCharacter(2)],
        coverage: fullCoverageForTwo
      }
    });

    const outcome = await refresh();

    expect(outcome.profile.characters).toHaveLength(2);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COOKIE);
    expect(deps.miyousheGameRecord.fetchPlayerIndex).toHaveBeenCalledWith(UID, COOKIE);
    expect(deps.miyousheBridge.fetchRoster).not.toHaveBeenCalled();
  });

  it('preserves cached ownership when no current MiHoYo login is available', async () => {
    const deps = setup(existingProfile());
    deps.rosterSessions.peek.mockReturnValue(undefined);
    deps.loginWindow.readPersistedCookie.mockResolvedValue(undefined);

    const outcome = await refresh();

    expect(outcome.profile.characters.map((character) => character.id)).toEqual([1, 2]);
    expect(outcome.profile.source).toBe('miyoushe-stale');
    expect(outcome.profile.coverage.partial).toBe(true);
    expect(deps.miyousheBridge.fetchRoster).not.toHaveBeenCalled();
  });

  it('recovers retcode 5003 through the official calculator sync roster', async () => {
    const deps = setup(existingProfile());
    deps.rosterSessions.peek.mockReturnValue(COOKIE);
    deps.miyousheGameRecord.fetchPlayerIndex.mockResolvedValue({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003, message: 'risk control' }
    });
    deps.miyousheCalculator.fetchOwnedRoster.mockResolvedValue({
      ok: true,
      data: {
        characters: [miyousheCharacter(1), miyousheCharacter(2)],
        coverage: fullCoverageForTwo
      }
    });

    const outcome = await refresh();

    expect(deps.miyousheCalculator.fetchOwnedRoster).toHaveBeenCalledWith(UID, COOKIE);
    expect(deps.miyousheBridge.fetchRoster).not.toHaveBeenCalled();
    expect(outcome.profile.characters.map((character) => character.id)).toEqual([1, 2]);
    expect(outcome.profile.source).toBe('merged');
    expect(outcome.profile.coverage.partial).toBe(false);
  });

  it('does not erase an existing roster when both import sources fail', async () => {
    const existing = existingProfile();
    const deps = setup(existing);
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: true,
      roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Traveler', level: 60 }]
    });
    deps.miyousheGameRecord.fetchPlayerIndex.mockResolvedValue({
      ok: false,
      error: { kind: 'captcha-required', retcode: 5003, message: 'risk control' }
    });
    deps.enka.fetchProfile.mockRejectedValue(new Error('Enka unavailable'));

    const imported = await importFromCookie();

    expect(imported.characters.map((character) => character.id)).toEqual([1, 2]);
    expect(imported.source).toBe('miyoushe-stale');
    expect(imported.coverage.partial).toBe(true);
    expect(deps.miyousheBridge.fetchRoster).not.toHaveBeenCalled();
  });
});
