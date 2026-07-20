import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CharacterProfile,
  PersistedProfile,
  RefreshOutcome
} from '../../../src/shared/domain.js';
import type {
  MiyousheCharacterDetail,
  MiyousheRosterCoverage
} from '../../../src/main/services/miyoushe-game-record.js';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
}));

vi.mock('../../../src/main/ipc/registry.js', () => ({
  registerHandler: (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) => {
    handlers.set(channel, handler);
  }
}));

import {
  registerProfileIpc,
  type ProfileIpcDeps
} from '../../../src/main/ipc/profile.ipc.js';

const UID = '100000001';
const FETCHED_AT = '2026-01-01T00:00:00.000Z';
const COOKIE = 'ltoken_v2=test; ltuid_v2=test; ltmid_v2=test';

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
  const deps = {
    miyoushe: {
      fetchRoles: vi.fn()
    },
    miyousheGameRecord: {
      fetchPlayerIndex: vi.fn(),
      fetchDetailedRoster: vi.fn(),
      ping: vi.fn()
    },
    miyousheBridge: {
      fetchRoster: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'navigation',
        message: 'not authenticated'
      })
    },
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
  });
});
