import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PersistedProfile } from '../../../src/shared/domain.js';

const electronStoreState = new Map<string, unknown>();

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      if (opts.defaults) {
        for (const [key, value] of Object.entries(opts.defaults)) {
          if (!electronStoreState.has(key)) {
            electronStoreState.set(key, value);
          }
        }
      }
    }
    get(key: string) {
      return electronStoreState.get(key);
    }
    set(key: string, value: unknown) {
      electronStoreState.set(key, value);
    }
    delete(key: string) {
      electronStoreState.delete(key);
    }
  }
}));

beforeEach(() => {
  electronStoreState.clear();
});

function makeProfile(uid: string, characterCount = 0): PersistedProfile {
  return {
    schemaVersion: 2,
    uid,
    nickname: `Traveler-${uid.slice(-3)}`,
    level: 60,
    source: 'miyoushe+enka',
    fetchedAt: new Date().toISOString(),
    characters: Array.from({ length: characterCount }, (_, i) => ({
      id: 10_000_000 + i,
      name: `Char-${i}`,
      element: 'Fire',
      rarity: 5,
      imageUrl: 'https://example.com/x.png',
      level: 90,
      build: {
        stats: {
          hp: 30000,
          atk: 2000,
          def: 800,
          critRate: 70,
          critDmg: 200,
          energyRecharge: 130,
          elementalMastery: 80
        }
      },
      completeness: 'build' as const,
      missingFields: ['weapon', 'artifacts', 'talents'] as const,
      provenance: {
        ownership: { source: 'enka' as const, fetchedAt: '2026-01-01T00:00:00.000Z' },
        stats: { source: 'enka' as const, fetchedAt: '2026-01-01T00:00:00.000Z' }
      }
    })),
    coverage: {
      ownedCount: characterCount,
      detailedCount: 0,
      buildCount: characterCount,
      statsCount: characterCount,
      enkaShowcaseCount: characterCount,
      missingDetailCount: characterCount,
      partial: characterCount > 0
    }
  };
}

describe('ProfileStore', () => {
  it('upserts a profile and marks it active when no active uid is set', async () => {
    const { ProfileStore } = await import('../../../src/main/services/profile-store.js');
    const store = new ProfileStore();

    store.upsert(makeProfile('111111111', 4));
    expect(store.getActiveUid()).toBe('111111111');

    const view = store.getStateView();
    expect(view.activeUid).toBe('111111111');
    expect(view.profiles).toHaveLength(1);
    expect(view.profiles[0]?.characterCount).toBe(4);
  });

  it('keeps existing active uid when upserting another profile', async () => {
    const { ProfileStore } = await import('../../../src/main/services/profile-store.js');
    const store = new ProfileStore();

    store.upsert(makeProfile('111111111'));
    store.upsert(makeProfile('222222222'));
    expect(store.getActiveUid()).toBe('111111111');

    store.setActive('222222222');
    expect(store.getActiveUid()).toBe('222222222');
  });

  it('removes a profile and re-picks active when needed', async () => {
    const { ProfileStore } = await import('../../../src/main/services/profile-store.js');
    const store = new ProfileStore();

    store.upsert(makeProfile('111111111'));
    store.upsert(makeProfile('222222222'));
    store.setActive('222222222');

    store.remove('222222222');
    expect(store.getActiveUid()).toBe('111111111');

    store.remove('111111111');
    expect(store.getActiveUid()).toBeUndefined();
    expect(store.getStateView().profiles).toHaveLength(0);
  });

  it('throws when setting active to an unknown UID', async () => {
    const { ProfileStore } = await import('../../../src/main/services/profile-store.js');
    const store = new ProfileStore();

    expect(() => store.setActive('999999999')).toThrow(/Profile not found/);
  });

  it('migrates legacy enka.network image URLs to gtai-img on construction', async () => {
    // Pre-seed the mock store with a legacy profile
    electronStoreState.set('profilesByUid', {
      '111111111': {
        uid: '111111111',
        nickname: 'LegacyTraveler',
        level: 60,
        source: 'miyoushe+enka',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        characters: [
          {
            id: 10000046,
            name: '胡桃',
            element: 'Fire',
            rarity: 5,
            imageUrl: 'https://enka.network/ui/UI_AvatarIcon_Hutao.png',
            stats: {
              level: 90,
              hp: 30000,
              atk: 2000,
              def: 800,
              critRate: 70,
              critDmg: 200,
              energyRecharge: 130,
              elementalMastery: 80
            }
          },
          {
            id: 99999,
            name: 'AlreadyMigrated',
            element: 'Water',
            rarity: 5,
            imageUrl: 'gtai-img://avatar/UI_AvatarIcon_Existing.png',
            stats: {
              level: 90,
              hp: 30000,
              atk: 2000,
              def: 800,
              critRate: 70,
              critDmg: 200,
              energyRecharge: 130,
              elementalMastery: 80
            }
          }
        ]
      }
    });

    const { ProfileStore } = await import('../../../src/main/services/profile-store.js');
    const store = new ProfileStore();

    const profile = store.get('111111111');
    expect(profile?.characters[0]?.imageUrl).toBe(
      'gtai-img://avatar/UI_AvatarIcon_Hutao.png'
    );
    expect(profile?.characters[1]?.imageUrl).toBe(
      'gtai-img://avatar/UI_AvatarIcon_Existing.png'
    );
  });

  it('does not rewrite when there is nothing to migrate (idempotent)', async () => {
    electronStoreState.set('profilesByUid', {
      '222222222': {
        uid: '222222222',
        source: 'miyoushe+enka',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        characters: [
          {
            id: 1,
            name: 'X',
            element: 'Fire',
            rarity: 5,
            imageUrl: 'gtai-img://avatar/UI_AvatarIcon_X.png',
            stats: {
              level: 1,
              hp: 0,
              atk: 0,
              def: 0,
              critRate: 0,
              critDmg: 0,
              energyRecharge: 0,
              elementalMastery: 0
            }
          }
        ]
      }
    });

    const { ProfileStore } = await import('../../../src/main/services/profile-store.js');
    new ProfileStore();
    new ProfileStore();

    const profile = electronStoreState.get('profilesByUid') as Record<string, { characters: Array<{ imageUrl: string }> }>;
    expect(profile['222222222']?.characters[0]?.imageUrl).toBe(
      'gtai-img://avatar/UI_AvatarIcon_X.png'
    );
  });
});
