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
      readPersistedCookie: vi.fn(),
      clearPersistedCookie: vi.fn()
    },
    loginSessions: {
      put: vi.fn(),
      consume: vi.fn()
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
