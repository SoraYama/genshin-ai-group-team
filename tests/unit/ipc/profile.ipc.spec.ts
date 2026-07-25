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
import {
  MiyoushePartitionLifecycle,
  seedRosterSessionsFromPersistedCookie
} from '../../../src/main/services/miyoushe/partition-lifecycle.js';
import {
  LoginSessionStore,
  RosterSessionStore
} from '../../../src/main/services/login-session-store.js';

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
const MANUAL_B_COOKIE =
  'ltoken_v2=manual-b; ltuid_v2=manual-b; ltmid_v2=manual-b; ' +
  '_MHYUUID=device-b; DEVICEFP=fingerprint-b; DEVICEFP_SEED_ID=seed-b; DEVICEFP_SEED_TIME=2';
const PARTITION_A_COOKIE =
  'ltoken_v2=partition-a; ltuid_v2=partition-a; ltmid_v2=partition-a; ' +
  '_MHYUUID=device-a; DEVICEFP=fingerprint-a; DEVICEFP_SEED_ID=seed-a; DEVICEFP_SEED_TIME=1';
const UPDATED_PARTITION_COOKIE =
  'ltoken_v2=partition-new; ltuid_v2=partition-new; ltmid_v2=partition-new; ' +
  '_MHYUUID=device-new; DEVICEFP=fingerprint-new; DEVICEFP_SEED_ID=seed-new; DEVICEFP_SEED_TIME=3';

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
      runWithPersistence: vi
        .fn()
        .mockImplementation(
          async (_persistence: 'partition' | 'memory-only', operation: () => Promise<unknown>) =>
            operation()
        ),
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
      peekSession: vi.fn(),
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
      captureMutationToken: vi.fn().mockImplementation((uid?: string) => ({
        globalEpoch: 0,
        ...(uid === undefined ? {} : { uid, uidRevision: 0 })
      })),
      isMutationTokenCurrent: vi.fn().mockReturnValue(true),
      upsertIfCurrent: vi.fn().mockReturnValue(true),
      setCredentialSource: vi.fn().mockReturnValue(false),
      reconcilePartitionCredentialSources: vi.fn(),
      setActive: vi.fn(),
      getActiveUid: vi.fn(),
      getStateView: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn()
    }
  };

  deps.rosterSessions.peekSession.mockImplementation((uid: string) => {
    const cookie = deps.rosterSessions.peek(uid);
    return cookie ? { cookie, persistence: 'partition' as const } : undefined;
  });

  registerProfileIpc(deps as unknown as ProfileIpcDeps);
  return deps;
}

type CredentialSourceForTest = 'manual' | 'partition';
type ProfileWithCredentialSource = PersistedProfile & {
  credentialSource?: CredentialSourceForTest;
};

function withCredentialSource(
  profile: PersistedProfile,
  credentialSource: CredentialSourceForTest
): ProfileWithCredentialSource {
  return { ...profile, credentialSource };
}

function makeProfileStoreStateful(
  deps: ReturnType<typeof setup>,
  initialProfiles: readonly ProfileWithCredentialSource[] = []
): Map<string, ProfileWithCredentialSource> {
  const profiles = new Map(initialProfiles.map((profile) => [profile.uid, profile]));
  const revisions = new Map<string, number>();
  let globalEpoch = 0;
  let activeUid = initialProfiles[0]?.uid;
  const revisionFor = (uid: string) => revisions.get(uid) ?? 0;
  const advanceMutation = (uids: Iterable<string>) => {
    globalEpoch += 1;
    for (const uid of uids) revisions.set(uid, revisionFor(uid) + 1);
  };
  deps.store.get.mockImplementation((uid: string) => profiles.get(uid));
  deps.store.upsert.mockImplementation((profile: ProfileWithCredentialSource) => {
    profiles.set(profile.uid, profile);
    activeUid ??= profile.uid;
    advanceMutation([profile.uid]);
  });
  deps.store.captureMutationToken.mockImplementation((uid?: string) => ({
    globalEpoch,
    ...(uid === undefined ? {} : { uid, uidRevision: revisionFor(uid) })
  }));
  deps.store.isMutationTokenCurrent.mockImplementation(
    (token: { globalEpoch: number; uid?: string; uidRevision?: number }, targetUid?: string) =>
      token.globalEpoch === globalEpoch &&
      (token.uid === undefined ||
        (token.uid === targetUid && token.uidRevision === revisionFor(token.uid)))
  );
  deps.store.upsertIfCurrent.mockImplementation(
    (
      profile: ProfileWithCredentialSource,
      token: number | { globalEpoch: number; uid?: string; uidRevision?: number },
      options: { activate?: boolean } = {}
    ) => {
      const current =
        typeof token === 'number'
          ? revisionFor(profile.uid) === token
          : token.globalEpoch === globalEpoch &&
            (token.uid === undefined ||
              (token.uid === profile.uid && token.uidRevision === revisionFor(profile.uid)));
      if (!current) return false;
      profiles.set(profile.uid, profile);
      activeUid ??= profile.uid;
      if (options.activate) activeUid = profile.uid;
      advanceMutation([profile.uid]);
      return true;
    }
  );
  deps.store.setCredentialSource.mockImplementation(
    (uid: string, credentialSource: CredentialSourceForTest) => {
      const profile = profiles.get(uid);
      if (!profile) return false;
      if (profile.credentialSource === credentialSource) return true;
      profiles.set(uid, { ...profile, credentialSource });
      advanceMutation([uid]);
      return true;
    }
  );
  deps.store.reconcilePartitionCredentialSources.mockImplementation(
    (verifiedUids: Iterable<string>) => {
      const verified = new Set(verifiedUids);
      const changedUids: string[] = [];
      for (const [uid, profile] of profiles) {
        if (verified.has(uid)) {
          if (profile.credentialSource !== 'partition') {
            profiles.set(uid, { ...profile, credentialSource: 'partition' });
            changedUids.push(uid);
          }
        } else if (profile.credentialSource === 'partition') {
          const withoutCredentialSource = { ...profile };
          delete withoutCredentialSource.credentialSource;
          profiles.set(uid, withoutCredentialSource);
          changedUids.push(uid);
        }
      }
      if (changedUids.length > 0) advanceMutation(changedUids);
    }
  );
  deps.store.getStateView.mockImplementation(() => ({
    activeUid,
    profiles: [...profiles.values()].map((profile) => ({
      uid: profile.uid,
      nickname: profile.nickname,
      level: profile.level,
      source: profile.source,
      fetchedAt: profile.fetchedAt,
      characterCount: profile.characters.length,
      coverage: profile.coverage
    }))
  }));
  deps.store.getActiveUid.mockImplementation(() => activeUid);
  deps.store.setActive.mockImplementation((uid: string) => {
    if (!profiles.has(uid)) throw new Error(`Profile not found: ${uid}`);
    activeUid = uid;
  });
  deps.store.remove.mockImplementation((uid: string) => {
    const removed = profiles.delete(uid);
    advanceMutation([uid]);
    if (!removed) return false;
    if (activeUid === uid) activeUid = profiles.keys().next().value;
    return true;
  });
  deps.store.clearAll.mockImplementation(() => {
    const uids = [...profiles.keys()];
    const count = uids.length;
    profiles.clear();
    activeUid = undefined;
    advanceMutation(uids);
    return count;
  });
  return profiles;
}

function useRosterStore(deps: ReturnType<typeof setup>, rosterSessions: RosterSessionStore): void {
  deps.rosterSessions.put.mockImplementation((uid, cookie, persistence) =>
    rosterSessions.put(uid, cookie, persistence)
  );
  deps.rosterSessions.peek.mockImplementation((uid) => rosterSessions.peek(uid));
  deps.rosterSessions.peekSession.mockImplementation((uid) => rosterSessions.peekSession(uid));
  deps.rosterSessions.hasCookie.mockImplementation((uid) => rosterSessions.hasCookie(uid));
  deps.rosterSessions.revoke.mockImplementation((uid) => rosterSessions.revoke(uid));
  deps.rosterSessions.clear.mockImplementation(() => rosterSessions.clear());
}

function useLoginStore(deps: ReturnType<typeof setup>, loginSessions: LoginSessionStore): void {
  deps.loginSessions.put.mockImplementation((cookie) => loginSessions.put(cookie));
  deps.loginSessions.consume.mockImplementation((sessionId) => loginSessions.consume(sessionId));
  deps.loginSessions.clear.mockImplementation(() => loginSessions.clear());
}

async function refresh(uid = UID): Promise<RefreshOutcome> {
  const handler = handlers.get('profile:refresh');
  if (!handler) throw new Error('profile:refresh handler was not registered');
  return (await handler({ uid })) as RefreshOutcome;
}

async function ping(uid = UID): Promise<unknown> {
  const handler = handlers.get('miyoushe:ping');
  if (!handler) throw new Error('miyoushe:ping handler was not registered');
  return handler({ uid });
}

async function loginViaBrowserRequest(): Promise<unknown> {
  const handler = handlers.get('miyoushe:login-via-browser');
  if (!handler) throw new Error('miyoushe:login-via-browser handler was not registered');
  return handler(undefined);
}

async function importFromCookie(cookie = COOKIE): Promise<PersistedProfile> {
  const handler = handlers.get('profile:import-from-cookie');
  if (!handler) throw new Error('profile:import-from-cookie handler was not registered');
  return (await handler({ uid: UID, cookie })) as PersistedProfile;
}

async function importFromSessionRequest(
  sessionId: string,
  uid: string | null = UID
): Promise<PersistedProfile> {
  const handler = handlers.get('profile:import-from-session');
  if (!handler) throw new Error('profile:import-from-session handler was not registered');
  return (await handler({
    sessionId,
    ...(uid === null ? {} : { uid })
  })) as PersistedProfile;
}

async function deleteProfile(uid = UID): Promise<unknown> {
  const handler = handlers.get('profile:delete');
  if (!handler) throw new Error('profile:delete handler was not registered');
  return handler({ uid });
}

async function logoutRequest(): Promise<unknown> {
  const handler = handlers.get('miyoushe:logout');
  if (!handler) throw new Error('miyoushe:logout handler was not registered');
  return handler(undefined);
}

async function authState(): Promise<unknown> {
  const handler = handlers.get('miyoushe:auth-state');
  if (!handler) throw new Error('miyoushe:auth-state handler was not registered');
  return handler(undefined);
}

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('miyoushe:login-via-browser device recovery', () => {
  function makeSessionStoresStateful(deps: ReturnType<typeof setup>) {
    const opaqueSessions = new Map<string, string>();
    const rosterCookies = new Map<string, string>();
    let nextSessionId = 0;
    deps.loginSessions.put.mockImplementation((cookie: string) => {
      nextSessionId += 1;
      const sessionId = `login-session-${nextSessionId}`;
      opaqueSessions.set(sessionId, cookie);
      return sessionId;
    });
    deps.loginSessions.consume.mockImplementation((sessionId: string) => {
      const cookie = opaqueSessions.get(sessionId);
      opaqueSessions.delete(sessionId);
      return cookie;
    });
    deps.loginSessions.clear.mockImplementation(() => opaqueSessions.clear());
    deps.rosterSessions.put.mockImplementation((uid: string, cookie: string) => {
      rosterCookies.set(uid, cookie);
    });
    deps.rosterSessions.peek.mockImplementation((uid: string) => rosterCookies.get(uid));
    deps.rosterSessions.hasCookie.mockImplementation((uid: string) => rosterCookies.has(uid));
    deps.rosterSessions.clear.mockImplementation(() => rosterCookies.clear());
    return { opaqueSessions, rosterCookies };
  }

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
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COMPLETED_COOKIE, 'partition');
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(SECOND_UID, COMPLETED_COOKIE, 'partition');
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

  it('clears account A from the persistent partition before account B login can inspect it', async () => {
    const deps = setup(undefined);
    const accountACookie = 'ltoken_v2=account-a; ltuid_v2=account-a; ltmid_v2=member-a';
    const accountBCookie = 'ltoken_v2=account-b; ltuid_v2=account-b; ltmid_v2=member-b';
    let persistedCookie: string | undefined = accountACookie;
    const events: string[] = [];
    deps.loginWindow.clearPersistedCookie.mockImplementation(async () => {
      events.push('partition-cleared');
      persistedCookie = undefined;
    });
    deps.loginWindow.runOnce.mockImplementation(async () => {
      events.push(`run-once:${persistedCookie ?? 'empty'}`);
      persistedCookie = accountBCookie;
      return { ok: true as const, cookie: accountBCookie };
    });
    deps.loginWindow.readPersistedCookie.mockImplementation(async () => persistedCookie);
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: true,
      roles: [{ gameUid: SECOND_UID, region: 'cn_gf01', nickname: 'Account B', level: 59 }]
    });

    const result = await loginViaBrowser();

    expect(events).toEqual(['partition-cleared', 'run-once:empty']);
    expect(persistedCookie).toBe(accountBCookie);
    expect(result).toMatchObject({ ok: true });
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(SECOND_UID, accountBCookie, 'partition');
  });

  it('cannot revive account A after its replacement login is cancelled', async () => {
    const deps = setup(undefined);
    const accountACookie = 'ltoken_v2=account-a; ltuid_v2=account-a; ltmid_v2=member-a';
    let persistedCookie: string | undefined = accountACookie;
    const cookieSeenByReplacement: Array<string | undefined> = [];
    deps.loginWindow.clearPersistedCookie.mockImplementation(async () => {
      persistedCookie = undefined;
    });
    deps.loginWindow.runOnce.mockImplementation(async () => {
      cookieSeenByReplacement.push(persistedCookie);
      return { ok: false as const, reason: 'cancelled' as const };
    });
    deps.loginWindow.readPersistedCookie.mockImplementation(async () => persistedCookie);
    deps.store.getStateView.mockReturnValue({ profiles: [] });
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: true,
      roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Account A', level: 60 }]
    });

    await expect(loginViaBrowser()).resolves.toEqual({ ok: false, reason: 'cancelled' });
    await expect(authState()).resolves.toEqual({ hasCookie: false, uids: [] });

    deps.rosterSessions.put.mockClear();
    await seedRosterSessionsFromPersistedCookie({
      lifecycle: deps.partitionLifecycle,
      loginWindow: deps.loginWindow,
      deviceFp: deps.deviceFp,
      miyoushe: deps.miyoushe,
      rosterSessions: deps.rosterSessions,
      profiles: deps.store
    });

    expect(cookieSeenByReplacement).toEqual([undefined]);
    expect(deps.miyoushe.fetchRoles).not.toHaveBeenCalled();
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
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
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COMPLETED_COOKIE, 'partition');
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(SECOND_UID, COMPLETED_COOKIE, 'partition');
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
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COOKIE, 'partition');
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(SECOND_UID, COOKIE, 'partition');
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
    deps.loginWindow.clearPersistedCookie.mockClear();

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
    deps.loginWindow.clearPersistedCookie.mockClear();
    events.length = 0;

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

  it('cancels a login that was queued behind another transition before logout drains it', async () => {
    const deps = setup(undefined);
    const priorTransitionStarted = deferred<void>();
    const releasePriorTransition = deferred<void>();
    const pendingLogin = deferred<{ ok: false; reason: 'cancelled' }>();
    let loginWindowActive = false;
    let loginWindowDestroyed = false;
    deps.loginWindow.runOnce.mockImplementation(() => {
      loginWindowActive = true;
      return pendingLogin.promise;
    });
    deps.loginWindow.cancelActiveLogin.mockImplementation(() => {
      if (!loginWindowActive) return;
      loginWindowActive = false;
      loginWindowDestroyed = true;
      pendingLogin.resolve({ ok: false, reason: 'cancelled' });
    });

    const priorTransition = deps.partitionLifecycle.transition(async () => {
      priorTransitionStarted.resolve();
      await releasePriorTransition.promise;
    });
    await priorTransitionStarted.promise;

    const loginPromise = loginViaBrowser();
    const logoutPromise = logout();
    releasePriorTransition.resolve();

    const settled = settlesWithin(Promise.all([priorTransition, loginPromise, logoutPromise]));

    expect(await settled).toBe(true);
    expect(loginWindowDestroyed).toBe(true);
    await expect(loginPromise).resolves.toEqual({ ok: false, reason: 'cancelled' });
    await expect(logoutPromise).resolves.toEqual({ ok: true });
    expect(deps.loginWindow.clearPersistedCookie).toHaveBeenCalledTimes(2);
  });

  it('cancels the active window when a queued browser login transition starts', async () => {
    const deps = setup(undefined);
    const priorTransitionStarted = deferred<void>();
    const releasePriorTransition = deferred<void>();
    const firstLogin = deferred<{ ok: false; reason: 'cancelled' }>();
    let runCount = 0;
    let loginWindowActive = false;
    let firstWindowDestroyed = false;
    deps.loginWindow.runOnce.mockImplementation(() => {
      runCount += 1;
      if (runCount === 1) {
        loginWindowActive = true;
        return firstLogin.promise;
      }
      return Promise.resolve({ ok: false, reason: 'cancelled' as const });
    });
    deps.loginWindow.cancelActiveLogin.mockImplementation(() => {
      if (!loginWindowActive) return;
      loginWindowActive = false;
      firstWindowDestroyed = true;
      firstLogin.resolve({ ok: false, reason: 'cancelled' });
    });

    const priorTransition = deps.partitionLifecycle.transition(async () => {
      priorTransitionStarted.resolve();
      await releasePriorTransition.promise;
    });
    await priorTransitionStarted.promise;

    const firstLoginPromise = loginViaBrowser();
    const secondLoginPromise = loginViaBrowser();
    releasePriorTransition.resolve();

    expect(
      await settlesWithin(Promise.all([priorTransition, firstLoginPromise, secondLoginPromise]))
    ).toBe(true);
    expect(firstWindowDestroyed).toBe(true);
    expect(deps.loginWindow.runOnce).toHaveBeenCalledTimes(2);
    await expect(firstLoginPromise).resolves.toEqual({ ok: false, reason: 'cancelled' });
    await expect(secondLoginPromise).resolves.toEqual({ ok: false, reason: 'cancelled' });
  });

  it('atomically replaces account A sessions when account B browser login starts', async () => {
    const deps = setup(undefined);
    const { opaqueSessions, rosterCookies } = makeSessionStoresStateful(deps);
    const accountACookie = 'ltoken_v2=account-a; ltuid_v2=account-a; ltmid_v2=member-a';
    const accountBCookie = 'ltoken_v2=account-b; ltuid_v2=account-b; ltmid_v2=member-b';
    deps.loginWindow.runOnce
      .mockResolvedValueOnce({ ok: true, cookie: accountACookie })
      .mockResolvedValueOnce({ ok: true, cookie: accountBCookie });
    deps.miyoushe.fetchRoles.mockImplementation(async (cookie: string) => ({
      ok: true as const,
      roles: [
        cookie === accountACookie
          ? { gameUid: UID, region: 'cn_gf01', nickname: 'Account A', level: 60 }
          : { gameUid: SECOND_UID, region: 'cn_gf01', nickname: 'Account B', level: 59 }
      ]
    }));

    const accountA = (await loginViaBrowser()) as { ok: true; sessionId: string };
    const accountB = (await loginViaBrowser()) as { ok: true; sessionId: string };

    expect(opaqueSessions.has(accountA.sessionId)).toBe(false);
    expect(opaqueSessions.has(accountB.sessionId)).toBe(true);
    expect(rosterCookies.has(UID)).toBe(false);
    expect(rosterCookies.get(SECOND_UID)).toBe(accountBCookie);
    await expect(importFromSession(accountA.sessionId)).rejects.toMatchObject({
      code: 'IPC_UNAUTHORIZED'
    });

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
    const importedB = (await importFromSession(accountB.sessionId)) as PersistedProfile;
    expect(importedB.uid).toBe(SECOND_UID);
    expect(deps.miyousheGameRecord.fetchPlayerIndex).toHaveBeenCalledWith(
      SECOND_UID,
      accountBCookie
    );
  });

  it('promotes an existing manual profile only after that same UID is browser-verified', async () => {
    const manualProfile = withCredentialSource(existingProfile(), 'manual');
    const deps = setup(manualProfile);
    const profiles = makeProfileStoreStateful(deps, [manualProfile]);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: PARTITION_A_COOKIE });
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: true,
      roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Verified UID', level: 60 }]
    });

    await loginViaBrowser();

    expect(deps.store.reconcilePartitionCredentialSources).toHaveBeenLastCalledWith([UID]);
    expect(profiles.get(UID)?.credentialSource).toBe('partition');
  });

  it('keeps the old account revoked when its replacement login is cancelled', async () => {
    const deps = setup(undefined);
    const { opaqueSessions, rosterCookies } = makeSessionStoresStateful(deps);
    const accountACookie = 'ltoken_v2=account-a; ltuid_v2=account-a; ltmid_v2=member-a';
    deps.loginWindow.runOnce
      .mockResolvedValueOnce({ ok: true, cookie: accountACookie })
      .mockResolvedValueOnce({ ok: false, reason: 'cancelled' });
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: true,
      roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Account A', level: 60 }]
    });

    const accountA = (await loginViaBrowser()) as { ok: true; sessionId: string };
    const replacement = await loginViaBrowser();

    expect(replacement).toEqual({ ok: false, reason: 'cancelled' });
    expect(opaqueSessions.size).toBe(0);
    expect(rosterCookies.size).toBe(0);
    await expect(importFromSession(accountA.sessionId)).rejects.toMatchObject({
      code: 'IPC_UNAUTHORIZED'
    });
  });

  it('invalidates every opaque login session when logging out', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());

    const loginResult = (await loginViaBrowser()) as { ok: true; sessionId: string };
    deps.miyoushe.fetchRoles.mockClear();
    deps.loginSessions.clear.mockClear();

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
    deps.loginSessions.clear.mockClear();

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

  it('clears roster sessions again when clearing the persisted partition fails', async () => {
    const deps = setup(undefined);
    deps.loginWindow.clearPersistedCookie.mockRejectedValue(new Error('partition clear failed'));

    await expect(logout()).rejects.toThrow('partition clear failed');

    expect(deps.rosterSessions.clear).toHaveBeenCalledTimes(2);
  });

  it('drains an in-flight session import without allowing stale commits after logout', async () => {
    const deps = setup(undefined);
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: COOKIE });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulBind());
    const loginResult = (await loginViaBrowser()) as { ok: true; sessionId: string };
    deps.miyoushe.fetchRoles.mockReset();
    deps.rosterSessions.put.mockClear();
    deps.loginWindow.clearPersistedCookie.mockClear();

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
    expect(deps.store.upsertIfCurrent).not.toHaveBeenCalled();
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
    expect(deps.store.upsertIfCurrent).not.toHaveBeenCalled();
    expect(deps.store.setActive).not.toHaveBeenCalled();
  });
});

describe('profile:import-from-cookie lifecycle', () => {
  const successfulManualBind = () => ({
    ok: true as const,
    roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Traveler', level: 60 }]
  });

  it('ensures one memory-only device identity and propagates its final Cookie', async () => {
    const deps = setup(undefined);
    const generation = deps.partitionLifecycle.capture();
    deps.deviceFp.ensureForSessionAt.mockResolvedValue({
      ok: true,
      cookie: COMPLETED_COOKIE,
      deviceHash: '0123456789ab',
      refreshed: true
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulManualBind());
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

    await importFromCookie();

    expect(deps.deviceFp.ensureForSessionAt).toHaveBeenCalledOnce();
    expect(deps.deviceFp.ensureForSessionAt).toHaveBeenCalledWith(generation, COOKIE, {
      persistence: 'memory-only'
    });
    expect(deps.miyoushe.fetchRoles).toHaveBeenCalledWith(COMPLETED_COOKIE);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COMPLETED_COOKIE, 'memory-only');
    expect(deps.miyousheGameRecord.fetchPlayerIndex).toHaveBeenCalledWith(UID, COMPLETED_COOKIE);
    expect(deps.miyousheGameRecord.fetchDetailedRoster).toHaveBeenCalledWith(
      UID,
      COMPLETED_COOKIE,
      { expectedOwnedCount: 2 }
    );
  });

  it('keeps a manual roster session memory-only during a later refresh', async () => {
    const deps = setup(undefined);
    const rosterEntries = new Map<
      string,
      { cookie: string; persistence: 'partition' | 'memory-only' }
    >();
    deps.rosterSessions.put.mockImplementation(
      (uid: string, cookie: string, persistence: 'partition' | 'memory-only' = 'partition') => {
        rosterEntries.set(uid, { cookie, persistence });
      }
    );
    deps.rosterSessions.peek.mockImplementation((uid: string) => rosterEntries.get(uid)?.cookie);
    deps.rosterSessions.peekSession.mockImplementation((uid: string) => rosterEntries.get(uid));
    deps.rosterSessions.hasCookie.mockImplementation((uid: string) => rosterEntries.has(uid));
    deps.deviceFp.ensureForSessionAt.mockResolvedValue({
      ok: true,
      cookie: COMPLETED_COOKIE,
      deviceHash: '0123456789ab',
      refreshed: true
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulManualBind());
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

    await importFromCookie();
    deps.deviceFp.runWithPersistence.mockClear();
    await refresh();

    expect(rosterEntries.get(UID)).toEqual({
      cookie: COMPLETED_COOKIE,
      persistence: 'memory-only'
    });
    expect(deps.deviceFp.runWithPersistence).toHaveBeenCalledWith(
      'memory-only',
      expect.any(Function)
    );
  });

  it('marks every existing UID verified by a manual Cookie as manual', async () => {
    const secondProfile = withCredentialSource(
      { ...existingProfile(), uid: SECOND_UID },
      'partition'
    );
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps, [secondProfile]);
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: true,
      roles: [
        { gameUid: UID, region: 'cn_gf01', nickname: 'Manual B', level: 60 },
        { gameUid: SECOND_UID, region: 'cn_gf01', nickname: 'Manual B alt', level: 59 }
      ]
    });
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

    await importFromCookie(MANUAL_B_COOKIE);

    expect(profiles.get(UID)?.credentialSource).toBe('manual');
    expect(profiles.get(SECOND_UID)?.credentialSource).toBe('manual');
  });

  it('rejects a manual import when device preparation cannot establish a stable identity', async () => {
    const deps = setup(undefined);
    deps.deviceFp.ensureForSessionAt.mockResolvedValue({
      ok: false,
      cookie: COOKIE,
      reason: 'profile-invalid'
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulManualBind());

    let importError: unknown;
    await importFromCookie().catch((error: unknown) => {
      importError = error;
    });

    expect(importError).toMatchObject({ code: 'IPC_UPSTREAM_UNAVAILABLE' });
    expect(JSON.stringify(importError)).not.toContain(COOKIE);
    expect(deps.miyoushe.fetchRoles).not.toHaveBeenCalled();
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
  });

  it('rejects a real profile-invalid device result even when it includes a device hash', async () => {
    const deps = setup(undefined);
    deps.deviceFp.ensureForSessionAt.mockResolvedValue({
      ok: false,
      cookie: COMPLETED_COOKIE,
      deviceHash: '0123456789ab',
      reason: 'profile-invalid'
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulManualBind());

    let importError: unknown;
    await importFromCookie().catch((error: unknown) => {
      importError = error;
    });

    expect(importError).toMatchObject({ code: 'IPC_UPSTREAM_UNAVAILABLE' });
    expect(JSON.stringify(importError)).not.toContain(COOKIE);
    expect(JSON.stringify(importError)).not.toContain(COMPLETED_COOKIE);
    expect(deps.miyoushe.fetchRoles).not.toHaveBeenCalled();
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
  });

  it('never exposes a manual account B import to account A persistent browser state', async () => {
    const deps = setup(undefined);
    const rosterEntries = new Map<
      string,
      { cookie: string; persistence: 'partition' | 'memory-only' }
    >();
    deps.rosterSessions.put.mockImplementation(
      (uid: string, cookie: string, persistence: 'partition' | 'memory-only') => {
        rosterEntries.set(uid, { cookie, persistence });
      }
    );
    deps.deviceFp.ensureForSessionAt.mockResolvedValue({
      ok: true,
      cookie: MANUAL_B_COOKIE,
      deviceHash: 'manual-b-hash',
      refreshed: false
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulManualBind());
    deps.miyousheGameRecord.fetchPlayerIndex.mockResolvedValue({
      ok: true,
      data: { totalCharacters: 2 }
    });
    deps.miyousheGameRecord.fetchDetailedRoster.mockImplementation(
      async (_uid: string, cookie: string) =>
        cookie === MANUAL_B_COOKIE
          ? {
              ok: false as const,
              error: { kind: 'upstream' as const, retcode: -1, message: 'direct unavailable' }
            }
          : {
              ok: true as const,
              data: {
                characters: [miyousheCharacter(1), miyousheCharacter(2)],
                coverage: fullCoverageForTwo
              }
            }
    );
    deps.miyousheBridge.fetchRoster
      .mockResolvedValueOnce({
        ok: false,
        reason: 'navigation',
        message: 'hidden bridge unavailable'
      })
      .mockResolvedValueOnce({ ok: true, mode: 'warmup', indexCalled: true });
    deps.loginWindow.readPersistedCookie.mockResolvedValue(PARTITION_A_COOKIE);

    const imported = await importFromCookie(MANUAL_B_COOKIE);

    expect(deps.miyousheGameRecord.fetchPlayerIndex.mock.calls).toEqual([[UID, MANUAL_B_COOKIE]]);
    expect(deps.miyousheGameRecord.fetchDetailedRoster.mock.calls).toEqual([
      [UID, MANUAL_B_COOKIE, { expectedOwnedCount: 2 }]
    ]);
    expect(deps.miyousheCalculator.fetchOwnedRoster).toHaveBeenCalledWith(UID, MANUAL_B_COOKIE);
    expect(deps.miyousheBridge.fetchRoster).not.toHaveBeenCalled();
    expect(deps.loginWindow.readPersistedCookie).not.toHaveBeenCalled();
    expect(rosterEntries.get(UID)).toEqual({
      cookie: MANUAL_B_COOKIE,
      persistence: 'memory-only'
    });
    expect(JSON.stringify([...rosterEntries.values()])).not.toContain(PARTITION_A_COOKIE);
    expect(imported.coverage.partial).toBe(true);
  });

  it('still lets a partition import adopt its refreshed persistent Cookie after bridge warmup', async () => {
    const deps = setup(undefined);
    const rosterEntries = new Map<
      string,
      { cookie: string; persistence: 'partition' | 'memory-only' }
    >();
    deps.rosterSessions.put.mockImplementation(
      (uid: string, cookie: string, persistence: 'partition' | 'memory-only') => {
        rosterEntries.set(uid, { cookie, persistence });
      }
    );
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulManualBind());
    deps.miyousheGameRecord.fetchPlayerIndex.mockResolvedValue({
      ok: true,
      data: { totalCharacters: 2 }
    });
    deps.miyousheGameRecord.fetchDetailedRoster.mockImplementation(
      async (_uid: string, cookie: string) =>
        cookie === UPDATED_PARTITION_COOKIE
          ? {
              ok: true as const,
              data: {
                characters: [miyousheCharacter(1), miyousheCharacter(2)],
                coverage: fullCoverageForTwo
              }
            }
          : {
              ok: false as const,
              error: { kind: 'upstream' as const, retcode: -1, message: 'direct unavailable' }
            }
    );
    deps.miyousheBridge.fetchRoster
      .mockResolvedValueOnce({
        ok: false,
        reason: 'navigation',
        message: 'hidden bridge unavailable'
      })
      .mockResolvedValueOnce({ ok: true, mode: 'warmup', indexCalled: true });
    deps.loginWindow.readPersistedCookie.mockResolvedValue(UPDATED_PARTITION_COOKIE);
    const sessionId = deps.loginSessions.put(PARTITION_A_COOKIE);

    const imported = await importFromSessionRequest(sessionId);

    expect(deps.miyousheBridge.fetchRoster.mock.calls).toEqual([
      [{ visible: false, uid: UID }],
      [{ visible: true, uid: UID }]
    ]);
    expect(deps.loginWindow.readPersistedCookie).toHaveBeenCalledOnce();
    expect(deps.miyousheGameRecord.fetchPlayerIndex.mock.calls).toEqual([
      [UID, PARTITION_A_COOKIE],
      [UID, UPDATED_PARTITION_COOKIE]
    ]);
    expect(deps.miyousheGameRecord.fetchDetailedRoster.mock.calls).toEqual([
      [UID, PARTITION_A_COOKIE, { expectedOwnedCount: 2 }],
      [UID, UPDATED_PARTITION_COOKIE, { expectedOwnedCount: 2 }]
    ]);
    expect(rosterEntries.get(UID)).toEqual({
      cookie: UPDATED_PARTITION_COOKIE,
      persistence: 'partition'
    });
    expect(imported.credentialSource).toBe('partition');
    expect(imported.coverage.partial).toBe(false);
  });

  it('drains a manual import stopped at fetchRoles without allowing stale work after logout', async () => {
    const deps = setup(undefined);
    const pendingBind = deferred<ReturnType<typeof successfulManualBind>>();
    deps.miyoushe.fetchRoles.mockReturnValue(pendingBind.promise);
    const requestGeneration = deps.partitionLifecycle.capture();

    const importPromise = importFromCookie();
    await vi.waitFor(() => expect(deps.miyoushe.fetchRoles).toHaveBeenCalledOnce());
    const logoutPromise = logoutRequest();
    await vi.waitFor(() =>
      expect(deps.partitionLifecycle.isCurrent(requestGeneration)).toBe(false)
    );
    const partitionClearedBeforeBindSettled =
      deps.loginWindow.clearPersistedCookie.mock.calls.length > 0;
    pendingBind.resolve(successfulManualBind());

    let importError: unknown;
    expect(
      await settlesWithin(
        Promise.all([
          importPromise.catch((error: unknown) => {
            importError = error;
          }),
          logoutPromise
        ])
      )
    ).toBe(true);
    expect(partitionClearedBeforeBindSettled).toBe(false);
    expect(importError).toMatchObject({ code: 'IPC_UNAUTHORIZED' });
    expect(JSON.stringify(importError)).not.toContain(COOKIE);
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
    expect(deps.miyousheGameRecord.fetchPlayerIndex).not.toHaveBeenCalled();
    expect(deps.store.upsert).not.toHaveBeenCalled();
    expect(deps.store.upsertIfCurrent).not.toHaveBeenCalled();
    expect(deps.store.setActive).not.toHaveBeenCalled();
  });

  it('does not deadlock or persist device recovery from a stale manual import', async () => {
    const deps = setup(undefined);
    const initial5003Reached = deferred<void>();
    const continueRecovery = deferred<void>();
    const persistedDeviceCookie = vi.fn().mockResolvedValue(undefined);
    const guardedWriter = deps.partitionLifecycle.guardCookieWriter({
      writeDeviceCookies: persistedDeviceCookie
    });
    deps.miyoushe.fetchRoles.mockResolvedValue(successfulManualBind());
    deps.miyousheGameRecord.fetchPlayerIndex.mockImplementation(async () => {
      initial5003Reached.resolve();
      await continueRecovery.promise;
      try {
        await deps.partitionLifecycle.runCurrent(() =>
          guardedWriter.writeDeviceCookies({ DEVICEFP: 'stale-manual-fingerprint' })
        );
      } catch {
        // Mirrors GameRecord's non-fatal recovery containment.
      }
      return {
        ok: false,
        error: { kind: 'captcha-required', retcode: 5003, message: 'risk control' }
      };
    });
    const requestGeneration = deps.partitionLifecycle.capture();

    const importPromise = importFromCookie();
    await initial5003Reached.promise;
    const rosterPutsBeforeLogout = deps.rosterSessions.put.mock.calls.length;
    const logoutPromise = logoutRequest();
    await vi.waitFor(() =>
      expect(deps.partitionLifecycle.isCurrent(requestGeneration)).toBe(false)
    );
    continueRecovery.resolve();

    let importError: unknown;
    expect(
      await settlesWithin(
        Promise.all([
          importPromise.catch((error: unknown) => {
            importError = error;
          }),
          logoutPromise
        ])
      )
    ).toBe(true);
    expect(importError).toMatchObject({ code: 'IPC_UNAUTHORIZED' });
    expect(JSON.stringify(importError)).not.toContain(COOKIE);
    expect(persistedDeviceCookie).not.toHaveBeenCalled();
    expect(deps.rosterSessions.put).toHaveBeenCalledTimes(rosterPutsBeforeLogout);
    expect(deps.store.upsert).not.toHaveBeenCalled();
    expect(deps.store.upsertIfCurrent).not.toHaveBeenCalled();
    expect(deps.store.setActive).not.toHaveBeenCalled();
  });
});

describe('profile mutation generations', () => {
  function configureSuccessfulRoster(deps: ReturnType<typeof setup>): void {
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
  }

  it('does not let a refresh that started before delete recreate that UID', async () => {
    const deleted = existingProfile();
    const survivor = { ...existingProfile(), uid: SECOND_UID };
    const deps = setup(deleted);
    const profiles = makeProfileStoreStateful(deps, [deleted, survivor]);
    deps.store.setActive(SECOND_UID);
    const pendingEnka = deferred<{
      uid: string;
      ttlSeconds: number;
      showcaseStatus: 'available';
      characters: CharacterProfile[];
    }>();
    deps.enka.fetchProfile.mockReturnValue(pendingEnka.promise);

    const refreshPromise = refresh(UID);
    await vi.waitFor(() => expect(deps.enka.fetchProfile).toHaveBeenCalledWith(UID));
    await deleteProfile(UID);
    pendingEnka.resolve({
      uid: UID,
      ttlSeconds: 60,
      showcaseStatus: 'available',
      characters: [enkaCharacter(1)]
    });

    await expect(refreshPromise).rejects.toMatchObject({
      code: 'IPC_SELECTION_CHANGED'
    });
    expect(profiles.has(UID)).toBe(false);
    expect(deps.store.getActiveUid()).toBe(SECOND_UID);
  });

  it('keeps a deleted UID absent after an old session import but lets a new import recreate it', async () => {
    const deleted = existingProfile();
    const survivor = { ...existingProfile(), uid: SECOND_UID };
    const deps = setup(deleted);
    const profiles = makeProfileStoreStateful(deps, [deleted, survivor]);
    deps.store.setActive(SECOND_UID);
    const bind = {
      ok: true as const,
      roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Traveler', level: 60 }]
    };
    const pendingBind = deferred<typeof bind>();
    deps.miyoushe.fetchRoles.mockReturnValueOnce(pendingBind.promise).mockResolvedValue(bind);
    configureSuccessfulRoster(deps);
    const staleSessionId = deps.loginSessions.put(PARTITION_A_COOKIE);

    const staleImport = importFromSessionRequest(staleSessionId);
    await vi.waitFor(() => expect(deps.miyoushe.fetchRoles).toHaveBeenCalledOnce());
    await deleteProfile(UID);
    pendingBind.resolve(bind);

    await expect(staleImport).rejects.toMatchObject({
      code: 'IPC_SELECTION_CHANGED'
    });
    expect(profiles.has(UID)).toBe(false);
    expect(deps.store.getActiveUid()).toBe(SECOND_UID);

    const currentSessionId = deps.loginSessions.put(PARTITION_A_COOKIE);
    await expect(importFromSessionRequest(currentSessionId)).resolves.toMatchObject({ uid: UID });
    expect(profiles.has(UID)).toBe(true);
    expect(deps.store.getActiveUid()).toBe(UID);
  });

  it('rejects an optional-UID import when its discovered target was deleted while roles loaded', async () => {
    const deleted = existingProfile();
    const survivor = { ...existingProfile(), uid: SECOND_UID };
    const deps = setup(deleted);
    const profiles = makeProfileStoreStateful(deps, [deleted, survivor]);
    deps.store.setActive(SECOND_UID);
    const bind = {
      ok: true as const,
      roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Traveler', level: 60 }]
    };
    const pendingBind = deferred<typeof bind>();
    deps.miyoushe.fetchRoles.mockReturnValueOnce(pendingBind.promise).mockResolvedValue(bind);
    configureSuccessfulRoster(deps);
    const staleSessionId = deps.loginSessions.put(PARTITION_A_COOKIE);

    const staleImport = importFromSessionRequest(staleSessionId, null);
    await vi.waitFor(() => expect(deps.miyoushe.fetchRoles).toHaveBeenCalledOnce());
    await deleteProfile(UID);
    pendingBind.resolve(bind);

    await expect(staleImport).rejects.toMatchObject({
      code: 'IPC_SELECTION_CHANGED'
    });
    expect(profiles.has(UID)).toBe(false);
    expect(deps.store.getActiveUid()).toBe(SECOND_UID);

    const currentSessionId = deps.loginSessions.put(PARTITION_A_COOKIE);
    await expect(importFromSessionRequest(currentSessionId, null)).resolves.toMatchObject({
      uid: UID
    });
    expect(profiles.has(UID)).toBe(true);
    expect(deps.store.getActiveUid()).toBe(UID);
  });

  it('rejects a new explicit UID import when an empty store was cleared while roles loaded', async () => {
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps);
    const bind = {
      ok: true as const,
      roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Traveler', level: 60 }]
    };
    const pendingBind = deferred<typeof bind>();
    deps.miyoushe.fetchRoles.mockReturnValue(pendingBind.promise);
    configureSuccessfulRoster(deps);
    const sessionId = deps.loginSessions.put(PARTITION_A_COOKIE);

    const importPromise = importFromSessionRequest(sessionId, UID);
    await vi.waitFor(() => expect(deps.miyoushe.fetchRoles).toHaveBeenCalledOnce());
    expect(deps.store.clearAll()).toBe(0);
    pendingBind.resolve(bind);

    await expect(importPromise).rejects.toMatchObject({
      code: 'IPC_SELECTION_CHANGED'
    });
    expect(profiles.size).toBe(0);
    expect(deps.store.getActiveUid()).toBeUndefined();
  });

  it('rejects an optional new-UID import when a nonempty store was cleared before target discovery', async () => {
    const survivor = { ...existingProfile(), uid: SECOND_UID };
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps, [survivor]);
    const bind = {
      ok: true as const,
      roles: [{ gameUid: UID, region: 'cn_gf01', nickname: 'Traveler', level: 60 }]
    };
    const pendingBind = deferred<typeof bind>();
    deps.miyoushe.fetchRoles.mockReturnValue(pendingBind.promise);
    configureSuccessfulRoster(deps);
    const sessionId = deps.loginSessions.put(PARTITION_A_COOKIE);

    const importPromise = importFromSessionRequest(sessionId, null);
    await vi.waitFor(() => expect(deps.miyoushe.fetchRoles).toHaveBeenCalledOnce());
    expect(deps.store.clearAll()).toBe(1);
    pendingBind.resolve(bind);

    await expect(importPromise).rejects.toMatchObject({
      code: 'IPC_SELECTION_CHANGED'
    });
    expect(profiles.size).toBe(0);
    expect(deps.store.getActiveUid()).toBeUndefined();
  });

  it('rejects a new-profile refresh when an empty store was cleared during the request', async () => {
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps);
    const pendingEnka = deferred<{
      uid: string;
      ttlSeconds: number;
      showcaseStatus: 'available';
      characters: CharacterProfile[];
    }>();
    deps.enka.fetchProfile.mockReturnValue(pendingEnka.promise);

    const refreshPromise = refresh(UID);
    await vi.waitFor(() => expect(deps.enka.fetchProfile).toHaveBeenCalledWith(UID));
    expect(deps.store.clearAll()).toBe(0);
    pendingEnka.resolve({
      uid: UID,
      ttlSeconds: 60,
      showcaseStatus: 'available',
      characters: [enkaCharacter(1)]
    });

    await expect(refreshPromise).rejects.toMatchObject({
      code: 'IPC_SELECTION_CHANGED'
    });
    expect(profiles.size).toBe(0);
    expect(deps.store.getActiveUid()).toBeUndefined();
  });
});

describe('profile:refresh roster integrity', () => {
  function deferVisibleBridgeRefresh(deps: ReturnType<typeof setup>) {
    const visible = deferred<{ ok: true; mode: 'warmup'; indexCalled: true }>();
    deps.miyousheGameRecord.fetchPlayerIndex.mockResolvedValue({
      ok: false,
      error: {
        kind: 'upstream',
        httpStatus: 503,
        message: 'temporary upstream failure'
      }
    });
    deps.miyousheBridge.fetchRoster
      .mockResolvedValueOnce({
        ok: false,
        reason: 'navigation',
        message: 'hidden bridge unavailable'
      })
      .mockReturnValueOnce(visible.promise);
    return visible;
  }

  function clearMiyousheNetworkCalls(deps: ReturnType<typeof setup>): void {
    deps.loginWindow.readPersistedCookie.mockClear();
    deps.miyousheGameRecord.fetchPlayerIndex.mockClear();
    deps.miyousheGameRecord.fetchDetailedRoster.mockClear();
    deps.miyousheGameRecord.ping.mockClear();
    deps.miyousheCalculator.fetchOwnedRoster.mockClear();
    deps.miyousheBridge.fetchRoster.mockClear();
  }

  function configurePartitionNetworkSuccess(deps: ReturnType<typeof setup>): void {
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
    deps.miyousheGameRecord.ping.mockResolvedValue({
      ok: true,
      data: { nickname: 'Wrong account', worldLevel: 9, totalCharacters: 2 }
    });
  }

  function expectNoMiyousheNetwork(deps: ReturnType<typeof setup>): void {
    expect(deps.loginWindow.readPersistedCookie).not.toHaveBeenCalled();
    expect(deps.miyousheGameRecord.fetchPlayerIndex).not.toHaveBeenCalled();
    expect(deps.miyousheGameRecord.fetchDetailedRoster).not.toHaveBeenCalled();
    expect(deps.miyousheGameRecord.ping).not.toHaveBeenCalled();
    expect(deps.miyousheCalculator.fetchOwnedRoster).not.toHaveBeenCalled();
    expect(deps.miyousheBridge.fetchRoster).not.toHaveBeenCalled();
  }

  it('creates a UID-only profile from the injected public showcase without account access', async () => {
    const deps = setup(undefined);
    deps.enka.fetchProfile.mockResolvedValue({
      uid: UID,
      nickname: 'UID Traveler',
      level: 58,
      region: 'cn_gf01',
      ttlSeconds: 60,
      showcaseStatus: 'available',
      characters: [enkaCharacter(1)]
    });

    const result = await refresh(UID);

    expect(deps.enka.fetchProfile).toHaveBeenCalledWith(UID);
    expect(result.profile).toMatchObject({
      uid: UID,
      nickname: 'UID Traveler',
      level: 58,
      source: 'enka'
    });
    expect(result.profile.characters).toHaveLength(1);
    expect(result.summary.miyoushe).toBe('no-cookie');
    expect(deps.store.upsertIfCurrent).toHaveBeenCalledWith(result.profile, {
      globalEpoch: 0,
      uid: UID,
      uidRevision: 0
    });
    expectNoMiyousheNetwork(deps);
  });

  it('revokes account A before browser B replacement and keeps only B partition-authorized after TTL or restart', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const accountA = withCredentialSource(existingProfile(), 'partition');
    const accountB = { ...existingProfile(), uid: SECOND_UID };
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps, [accountA, accountB]);
    const rosterSessions = new RosterSessionStore(10);
    useRosterStore(deps, rosterSessions);
    deps.loginWindow.runOnce.mockResolvedValue({
      ok: true,
      cookie: UPDATED_PARTITION_COOKIE
    });
    deps.loginWindow.readPersistedCookie.mockResolvedValue(UPDATED_PARTITION_COOKIE);
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: true,
      roles: [
        {
          gameUid: SECOND_UID,
          region: 'os_usa',
          nickname: 'Browser B',
          level: 60
        }
      ]
    });
    configurePartitionNetworkSuccess(deps);

    await loginViaBrowserRequest();
    now += 11;

    expect(profiles.get(UID)?.credentialSource).toBeUndefined();
    expect(profiles.get(SECOND_UID)?.credentialSource).toBe('partition');
    expect(deps.store.reconcilePartitionCredentialSources.mock.calls).toEqual([
      [[]],
      [[SECOND_UID]]
    ]);

    deps.loginWindow.readPersistedCookie.mockClear();
    deps.miyousheGameRecord.fetchPlayerIndex.mockClear();
    deps.miyousheGameRecord.fetchDetailedRoster.mockClear();
    deps.miyousheGameRecord.ping.mockClear();
    deps.miyousheCalculator.fetchOwnedRoster.mockClear();
    deps.miyousheBridge.fetchRoster.mockClear();
    deps.enka.fetchProfile.mockRejectedValue(new Error('Enka unavailable'));

    const staleARefresh = await refresh(UID);
    const staleAPing = await ping(UID);

    expect(staleARefresh.summary.miyoushe).toBe('no-cookie');
    expect(staleAPing).toEqual({
      ok: false,
      reason: '没有可用的米游社登录态，请先登录'
    });
    expectNoMiyousheNetwork(deps);

    const browserBRefresh = await refresh(SECOND_UID);
    const browserBPing = await ping(SECOND_UID);

    expect(browserBRefresh.summary.miyoushe).toBe('ok');
    expect(browserBPing).toMatchObject({ ok: true });
    expect(deps.loginWindow.readPersistedCookie).toHaveBeenCalledOnce();
    expect(deps.miyousheGameRecord.fetchPlayerIndex).toHaveBeenCalledWith(
      SECOND_UID,
      UPDATED_PARTITION_COOKIE
    );
    expect(deps.miyousheGameRecord.ping).toHaveBeenCalledWith(SECOND_UID, UPDATED_PARTITION_COOKIE);

    rosterSessions.clear();
    deps.loginWindow.readPersistedCookie.mockClear();
    deps.miyousheGameRecord.fetchPlayerIndex.mockClear();
    deps.miyousheGameRecord.fetchDetailedRoster.mockClear();
    deps.miyousheGameRecord.ping.mockClear();
    await expect(ping(UID)).resolves.toEqual({
      ok: false,
      reason: '没有可用的米游社登录态，请先登录'
    });
    expectNoMiyousheNetwork(deps);
  });

  it('keeps account A revoked when its browser replacement is cancelled', async () => {
    const accountA = withCredentialSource(existingProfile(), 'partition');
    const manual = withCredentialSource({ ...existingProfile(), uid: SECOND_UID }, 'manual');
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps, [accountA, manual]);
    useRosterStore(deps, new RosterSessionStore());
    deps.loginWindow.runOnce.mockResolvedValue({ ok: false, reason: 'cancelled' });
    deps.loginWindow.readPersistedCookie.mockResolvedValue(UPDATED_PARTITION_COOKIE);
    deps.enka.fetchProfile.mockRejectedValue(new Error('Enka unavailable'));
    configurePartitionNetworkSuccess(deps);

    await expect(loginViaBrowserRequest()).resolves.toEqual({
      ok: false,
      reason: 'cancelled'
    });
    const refreshed = await refresh(UID);
    const pingResult = await ping(UID);

    expect(profiles.get(UID)?.credentialSource).toBeUndefined();
    expect(profiles.get(SECOND_UID)?.credentialSource).toBe('manual');
    expect(refreshed.summary.miyoushe).toBe('no-cookie');
    expect(pingResult).toEqual({
      ok: false,
      reason: '没有可用的米游社登录态，请先登录'
    });
    expectNoMiyousheNetwork(deps);
  });

  it('keeps account A revoked when replacement account B fails role validation', async () => {
    const accountA = withCredentialSource(existingProfile(), 'partition');
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps, [accountA]);
    useRosterStore(deps, new RosterSessionStore());
    deps.loginWindow.runOnce.mockResolvedValue({
      ok: true,
      cookie: UPDATED_PARTITION_COOKIE
    });
    deps.miyoushe.fetchRoles.mockResolvedValue({
      ok: false,
      retcode: -100,
      message: 'account B invalid',
      roles: []
    });

    await expect(loginViaBrowserRequest()).resolves.toEqual({
      ok: false,
      reason: 'bind-failed',
      message: 'account B invalid'
    });

    expect(profiles.get(UID)?.credentialSource).toBeUndefined();
    expect(deps.store.reconcilePartitionCredentialSources).toHaveBeenCalledOnce();
    expect(deps.store.reconcilePartitionCredentialSources).toHaveBeenCalledWith([]);
  });

  it.each(['cancelled', 'bind-failed', 'success'] as const)(
    'clears stale visible-bridge sessions after a browser replacement is %s',
    async (replacementOutcome) => {
      const accountA = withCredentialSource(existingProfile(), 'partition');
      const accountB = { ...existingProfile(), uid: SECOND_UID };
      const deps = setup(undefined);
      const profiles = makeProfileStoreStateful(deps, [accountA, accountB]);
      const rosterSessions = new RosterSessionStore();
      const loginSessions = new LoginSessionStore();
      useRosterStore(deps, rosterSessions);
      useLoginStore(deps, loginSessions);
      rosterSessions.put(UID, PARTITION_A_COOKIE, 'partition');

      let persistedCookie: string | undefined = PARTITION_A_COOKIE;
      deps.loginWindow.readPersistedCookie.mockImplementation(async () => persistedCookie);
      deps.loginWindow.clearPersistedCookie.mockImplementation(async () => {
        persistedCookie = undefined;
      });
      deps.loginWindow.runOnce.mockImplementation(async () => {
        if (replacementOutcome === 'cancelled') {
          return { ok: false as const, reason: 'cancelled' as const };
        }
        persistedCookie = UPDATED_PARTITION_COOKIE;
        return { ok: true as const, cookie: UPDATED_PARTITION_COOKIE };
      });
      deps.miyoushe.fetchRoles.mockImplementation(async () =>
        replacementOutcome === 'bind-failed'
          ? {
              ok: false as const,
              retcode: -100,
              message: 'replacement role validation failed',
              roles: []
            }
          : {
              ok: true as const,
              roles: [
                {
                  gameUid: SECOND_UID,
                  region: 'os_usa',
                  nickname: 'Browser B',
                  level: 60
                }
              ]
            }
      );
      const visible = deferVisibleBridgeRefresh(deps);
      const releaseLateOpaquePut = deferred<void>();
      let lateOpaqueSessionId: string | undefined;
      const lateOpaquePut = deps.partitionLifecycle.runAt(
        deps.partitionLifecycle.capture(),
        async () => {
          await releaseLateOpaquePut.promise;
          lateOpaqueSessionId = deps.loginSessions.put(PARTITION_A_COOKIE);
        }
      );

      const oldRefresh = refresh(UID);
      await vi.waitFor(() =>
        expect(deps.miyousheBridge.fetchRoster).toHaveBeenCalledWith({ visible: true, uid: UID })
      );
      const replacement = loginViaBrowserRequest();
      await vi.waitFor(() => expect(deps.rosterSessions.clear).toHaveBeenCalledOnce());
      expect(rosterSessions.hasCookie(UID)).toBe(false);

      releaseLateOpaquePut.resolve();
      visible.resolve({ ok: true, mode: 'warmup', indexCalled: true });
      const outcomes = Promise.all([
        oldRefresh.catch((error: unknown) => error),
        replacement,
        lateOpaquePut
      ]);

      expect(await settlesWithin(outcomes)).toBe(true);
      const [oldRefreshError, replacementResult] = await outcomes;
      expect(oldRefreshError).toMatchObject({ code: 'IPC_UNAUTHORIZED' });
      expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, PARTITION_A_COOKIE, 'partition');
      expect(lateOpaqueSessionId).toBeDefined();
      expect(loginSessions.consume(lateOpaqueSessionId!)).toBeUndefined();
      expect(rosterSessions.hasCookie(UID)).toBe(false);
      expect(deps.rosterSessions.clear).toHaveBeenCalledTimes(2);
      expect(deps.loginSessions.clear).toHaveBeenCalledTimes(2);
      expect(profiles.get(UID)?.credentialSource).toBeUndefined();

      if (replacementOutcome === 'cancelled') {
        expect(replacementResult).toEqual({ ok: false, reason: 'cancelled' });
      } else if (replacementOutcome === 'bind-failed') {
        expect(replacementResult).toEqual({
          ok: false,
          reason: 'bind-failed',
          message: 'replacement role validation failed'
        });
      } else {
        expect(replacementResult).toMatchObject({ ok: true });
        expect(rosterSessions.peek(SECOND_UID)).toBe(UPDATED_PARTITION_COOKIE);
        expect(profiles.get(SECOND_UID)?.credentialSource).toBe('partition');
      }

      clearMiyousheNetworkCalls(deps);
      const staleAPing = await ping(UID);
      const staleARefresh = await refresh(UID);
      expect(staleAPing).toEqual({
        ok: false,
        reason: '没有可用的米游社登录态，请先登录'
      });
      expect(staleARefresh.summary.miyoushe).toBe('no-cookie');
      expectNoMiyousheNetwork(deps);

      if (replacementOutcome === 'success') {
        configurePartitionNetworkSuccess(deps);
        const browserBRefresh = await refresh(SECOND_UID);
        const browserBPing = await ping(SECOND_UID);
        expect(browserBRefresh.summary.miyoushe).toBe('ok');
        expect(browserBPing).toMatchObject({ ok: true });
        expect(deps.miyousheGameRecord.fetchPlayerIndex).toHaveBeenCalledWith(
          SECOND_UID,
          UPDATED_PARTITION_COOKIE
        );
        expect(deps.miyousheGameRecord.ping).toHaveBeenCalledWith(
          SECOND_UID,
          UPDATED_PARTITION_COOKIE
        );
      }
    }
  );

  it('clears sessions reinserted during drain even when partition clearing fails', async () => {
    const accountA = withCredentialSource(existingProfile(), 'partition');
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps, [accountA]);
    const rosterSessions = new RosterSessionStore();
    const loginSessions = new LoginSessionStore();
    useRosterStore(deps, rosterSessions);
    useLoginStore(deps, loginSessions);
    rosterSessions.put(UID, PARTITION_A_COOKIE, 'partition');
    deps.loginWindow.readPersistedCookie.mockResolvedValue(PARTITION_A_COOKIE);
    deps.loginWindow.clearPersistedCookie.mockRejectedValue(new Error('partition clear failed'));
    const visible = deferVisibleBridgeRefresh(deps);
    const releaseLateOpaquePut = deferred<void>();
    let lateOpaqueSessionId: string | undefined;
    const lateOpaquePut = deps.partitionLifecycle.runAt(
      deps.partitionLifecycle.capture(),
      async () => {
        await releaseLateOpaquePut.promise;
        lateOpaqueSessionId = deps.loginSessions.put(PARTITION_A_COOKIE);
      }
    );

    const oldRefresh = refresh(UID);
    await vi.waitFor(() =>
      expect(deps.miyousheBridge.fetchRoster).toHaveBeenCalledWith({ visible: true, uid: UID })
    );
    const replacement = loginViaBrowserRequest();
    await vi.waitFor(() => expect(deps.rosterSessions.clear).toHaveBeenCalledOnce());
    releaseLateOpaquePut.resolve();
    visible.resolve({ ok: true, mode: 'warmup', indexCalled: true });
    const outcomes = Promise.all([
      oldRefresh.catch((error: unknown) => error),
      replacement.catch((error: unknown) => error),
      lateOpaquePut
    ]);

    expect(await settlesWithin(outcomes)).toBe(true);
    const [oldRefreshError, replacementError] = await outcomes;
    expect(oldRefreshError).toMatchObject({ code: 'IPC_UNAUTHORIZED' });
    expect(replacementError).toEqual(
      expect.objectContaining({ message: 'partition clear failed' })
    );
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, PARTITION_A_COOKIE, 'partition');
    expect(lateOpaqueSessionId).toBeDefined();
    expect(loginSessions.consume(lateOpaqueSessionId!)).toBeUndefined();
    expect(rosterSessions.hasCookie(UID)).toBe(false);
    expect(deps.rosterSessions.clear).toHaveBeenCalledTimes(2);
    expect(deps.loginSessions.clear).toHaveBeenCalledTimes(2);
    expect(profiles.get(UID)?.credentialSource).toBeUndefined();
    expect(deps.loginWindow.runOnce).not.toHaveBeenCalled();

    clearMiyousheNetworkCalls(deps);
    const staleAPing = await ping(UID);
    const staleARefresh = await refresh(UID);
    expect(staleAPing).toEqual({
      ok: false,
      reason: '没有可用的米游社登录态，请先登录'
    });
    expect(staleARefresh.summary.miyoushe).toBe('no-cookie');
    expectNoMiyousheNetwork(deps);
  });

  it('keeps manual B disconnected after browser account A replaces its roster sessions', async () => {
    const deps = setup(undefined);
    const profiles = makeProfileStoreStateful(deps);
    useRosterStore(deps, new RosterSessionStore());
    deps.loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: PARTITION_A_COOKIE });
    deps.loginWindow.readPersistedCookie.mockResolvedValue(PARTITION_A_COOKIE);
    deps.miyoushe.fetchRoles.mockImplementation(async (cookie: string) => ({
      ok: true as const,
      roles: [
        cookie === MANUAL_B_COOKIE
          ? { gameUid: UID, region: 'cn_gf01', nickname: 'Manual B', level: 60 }
          : { gameUid: SECOND_UID, region: 'cn_gf01', nickname: 'Browser A', level: 59 }
      ]
    }));
    configurePartitionNetworkSuccess(deps);

    const manualProfile = await importFromCookie(MANUAL_B_COOKIE);
    await loginViaBrowserRequest();

    deps.loginWindow.readPersistedCookie.mockClear();
    deps.miyousheGameRecord.fetchPlayerIndex.mockClear();
    deps.miyousheGameRecord.fetchDetailedRoster.mockClear();
    deps.miyousheGameRecord.ping.mockClear();
    deps.miyousheCalculator.fetchOwnedRoster.mockClear();
    deps.miyousheBridge.fetchRoster.mockClear();
    deps.enka.fetchProfile.mockRejectedValue(new Error('Enka unavailable'));

    const refreshed = await refresh();
    const pingResult = await ping();

    expect(profiles.get(UID)?.credentialSource).toBe('manual');
    expect(profiles.get(SECOND_UID)?.credentialSource).toBeUndefined();
    expect(refreshed.profile).toEqual(manualProfile);
    expect(refreshed.summary.miyoushe).toBe('no-cookie');
    expect(pingResult).toEqual({ ok: false, reason: '没有可用的米游社登录态，请先登录' });
    expectNoMiyousheNetwork(deps);
  });

  it('does not adopt a partition Cookie after a manual roster session expires', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const existing = withCredentialSource(existingProfile(), 'manual');
    const deps = setup(existing);
    const rosterSessions = new RosterSessionStore(10);
    useRosterStore(deps, rosterSessions);
    rosterSessions.put(UID, MANUAL_B_COOKIE, 'memory-only');
    now += 11;
    deps.loginWindow.readPersistedCookie.mockResolvedValue(PARTITION_A_COOKIE);
    deps.enka.fetchProfile.mockRejectedValue(new Error('Enka unavailable'));
    configurePartitionNetworkSuccess(deps);

    const refreshed = await refresh();
    const pingResult = await ping();

    expect(refreshed.profile).toEqual(existing);
    expect(refreshed.summary.miyoushe).toBe('no-cookie');
    expect(pingResult).toEqual({ ok: false, reason: '没有可用的米游社登录态，请先登录' });
    expectNoMiyousheNetwork(deps);
  });

  it('keeps a persisted manual binding safe after restart with an empty roster store', async () => {
    const existing = withCredentialSource(existingProfile(), 'manual');
    const deps = setup(existing);
    useRosterStore(deps, new RosterSessionStore());
    deps.loginWindow.readPersistedCookie.mockResolvedValue(PARTITION_A_COOKIE);
    deps.enka.fetchProfile.mockRejectedValue(new Error('Enka unavailable'));
    configurePartitionNetworkSuccess(deps);

    const refreshed = await refresh();
    const pingResult = await ping();

    expect(refreshed.profile).toEqual(existing);
    expect(refreshed.summary.miyoushe).toBe('no-cookie');
    expect(pingResult).toEqual({ ok: false, reason: '没有可用的米游社登录态，请先登录' });
    expectNoMiyousheNetwork(deps);
  });

  it('does not restore a persisted Cookie read that finishes after logout', async () => {
    const deps = setup(withCredentialSource(existingProfile(), 'partition'));
    const pendingCookie = deferred<string | undefined>();
    deps.rosterSessions.peek.mockReturnValue(undefined);
    deps.loginWindow.readPersistedCookie.mockReturnValue(pendingCookie.promise);

    const refreshPromise = refresh();
    await vi.waitFor(() => expect(deps.loginWindow.readPersistedCookie).toHaveBeenCalledOnce());
    const logoutHandler = handlers.get('miyoushe:logout');
    if (!logoutHandler) throw new Error('miyoushe:logout handler was not registered');
    await logoutHandler(undefined);
    pendingCookie.resolve(COOKIE);

    await expect(refreshPromise).rejects.toMatchObject({ code: 'IPC_UNAUTHORIZED' });
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
    expect(deps.miyousheGameRecord.fetchPlayerIndex).not.toHaveBeenCalled();
  });

  it('keeps a deferred 5003 recovery stale after logout without persisting or committing', async () => {
    const deps = setup(existingProfile());
    const initial5003Reached = deferred<void>();
    const continueRecovery = deferred<void>();
    const persistedDeviceCookie = vi.fn().mockResolvedValue(undefined);
    const guardedWriter = deps.partitionLifecycle.guardCookieWriter({
      writeDeviceCookies: persistedDeviceCookie
    });
    deps.rosterSessions.peek.mockReturnValue(COOKIE);
    deps.miyousheGameRecord.fetchPlayerIndex.mockImplementation(async () => {
      initial5003Reached.resolve();
      await continueRecovery.promise;
      try {
        await deps.partitionLifecycle.runCurrent(() =>
          guardedWriter.writeDeviceCookies({ DEVICEFP: 'stale-refresh-fingerprint' })
        );
      } catch {
        // Mirrors GameRecord's non-fatal recovery containment.
      }
      return {
        ok: false,
        error: { kind: 'captcha-required', retcode: 5003, message: 'risk control' }
      };
    });
    const requestGeneration = deps.partitionLifecycle.capture();

    const refreshPromise = refresh();
    await initial5003Reached.promise;
    const logoutHandler = handlers.get('miyoushe:logout');
    if (!logoutHandler) throw new Error('miyoushe:logout handler was not registered');
    const logoutPromise = Promise.resolve(logoutHandler(undefined));
    await vi.waitFor(() =>
      expect(deps.partitionLifecycle.isCurrent(requestGeneration)).toBe(false)
    );
    continueRecovery.resolve();

    let refreshError: unknown;
    expect(
      await settlesWithin(
        Promise.all([
          refreshPromise.catch((error: unknown) => {
            refreshError = error;
          }),
          logoutPromise
        ])
      )
    ).toBe(true);
    expect(refreshError).toMatchObject({ code: 'IPC_UNAUTHORIZED' });
    expect(persistedDeviceCookie).not.toHaveBeenCalled();
    expect(deps.store.upsert).not.toHaveBeenCalled();
    expect(deps.store.upsertIfCurrent).not.toHaveBeenCalled();
    expect(deps.store.setActive).not.toHaveBeenCalled();
  });

  it('keeps ping device recovery in its request generation after logout', async () => {
    const deps = setup(existingProfile());
    const initial5003Reached = deferred<void>();
    const continueRecovery = deferred<void>();
    const persistedDeviceCookie = vi.fn().mockResolvedValue(undefined);
    const guardedWriter = deps.partitionLifecycle.guardCookieWriter({
      writeDeviceCookies: persistedDeviceCookie
    });
    deps.rosterSessions.peek.mockReturnValue(COOKIE);
    deps.miyousheGameRecord.ping.mockImplementation(async () => {
      initial5003Reached.resolve();
      await continueRecovery.promise;
      try {
        await deps.partitionLifecycle.runCurrent(() =>
          guardedWriter.writeDeviceCookies({ DEVICEFP: 'stale-ping-fingerprint' })
        );
      } catch {
        // Mirrors GameRecord's non-fatal recovery containment.
      }
      return {
        ok: false,
        error: { kind: 'captcha-required', retcode: 5003, message: 'risk control' }
      };
    });
    const requestGeneration = deps.partitionLifecycle.capture();

    const pingPromise = ping();
    await initial5003Reached.promise;
    const logoutHandler = handlers.get('miyoushe:logout');
    if (!logoutHandler) throw new Error('miyoushe:logout handler was not registered');
    const logoutPromise = Promise.resolve(logoutHandler(undefined));
    await vi.waitFor(() =>
      expect(deps.partitionLifecycle.isCurrent(requestGeneration)).toBe(false)
    );
    continueRecovery.resolve();

    expect(await settlesWithin(Promise.all([pingPromise, logoutPromise]))).toBe(true);
    await expect(pingPromise).resolves.toMatchObject({ ok: false });
    expect(persistedDeviceCookie).not.toHaveBeenCalled();
  });

  it('lets an explicitly partition-bound profile recover its persisted Cookie', async () => {
    const deps = setup(withCredentialSource(existingProfile(), 'partition'));
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
    deps.miyousheGameRecord.ping.mockResolvedValue({
      ok: true,
      data: { nickname: 'Partition A', worldLevel: 9, totalCharacters: 2 }
    });

    const outcome = await refresh();
    const pingResult = await ping();

    expect(outcome.profile.characters).toHaveLength(2);
    expect(deps.rosterSessions.put).toHaveBeenCalledWith(UID, COOKIE, 'partition');
    expect(deps.miyousheGameRecord.fetchPlayerIndex).toHaveBeenCalledWith(UID, COOKIE);
    expect(deps.miyousheGameRecord.ping).toHaveBeenCalledWith(UID, COOKIE);
    expect(pingResult).toMatchObject({ ok: true, nickname: 'Partition A' });
    expect(deps.miyousheBridge.fetchRoster).not.toHaveBeenCalled();
  });

  it('does not let a migration-safe unknown profile adopt an arbitrary partition Cookie', async () => {
    const deps = setup(existingProfile());
    deps.rosterSessions.peek.mockReturnValue(undefined);
    deps.loginWindow.readPersistedCookie.mockResolvedValue(PARTITION_A_COOKIE);

    const outcome = await refresh();

    expect(outcome.profile.characters.map((character) => character.id)).toEqual([1, 2]);
    expect(outcome.profile.source).toBe('miyoushe-stale');
    expect(outcome.profile.coverage.partial).toBe(true);
    expect(deps.loginWindow.readPersistedCookie).not.toHaveBeenCalled();
    expect(deps.miyousheGameRecord.fetchPlayerIndex).not.toHaveBeenCalled();
    expect(deps.miyousheCalculator.fetchOwnedRoster).not.toHaveBeenCalled();
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
