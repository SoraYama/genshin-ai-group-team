import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryStore } from '../../../src/main/services/history-store.js';
import type { TheaterPlanHistoryEntry } from '../../../src/shared/domain.js';
import { theaterInput, validTheaterPlan } from './theater-test-fixtures.js';

const storeState = new Map<string, unknown>();
vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      Object.entries(opts.defaults ?? {}).forEach(([key, value]) => {
        if (!storeState.has(key)) storeState.set(key, value);
      });
    }
    get(key: string) {
      return storeState.get(key);
    }
    set(key: string, value: unknown) {
      storeState.set(key, value);
    }
  }
}));
beforeEach(() => storeState.clear());

function input(): Omit<TheaterPlanHistoryEntry, 'id' | 'createdAt'> {
  const plan = validTheaterPlan();
  return {
    uid: '123456789',
    scenarioId: plan.scenarioId,
    schemaVersion: 2,
    dataVersion: plan.dataVersion,
    mode: 'imaginarium-theater',
    target: 'safe-clear',
    source: 'local-rules',
    scenarioTrust: 'production',
    scenarioFreshness: 'fresh',
    scenarioNotCurrent: false,
    interventions: theaterInput(),
    eligibility: {
      status: 'eligible',
      requiredHeadcount: 8,
      eligibleOwnedCount: 8,
      hardQualifiedCount: 8,
      shortage: 0,
      eligibleOwnedCharacterIds: Array.from({ length: 8 }, (_, index) => String(1001 + index)),
      ineligibleOwned: [],
      pools: [],
      constructionAdvice: []
    },
    cast: Array.from({ length: 8 }, (_, index) => ({
      id: String(1001 + index),
      name: `剧诗角色${index + 1}`,
      element: index % 2 ? 'Geo' : 'Anemo',
      level: 90,
      source: 'owned' as const
    })),
    vigorBudget: [
      { act: 1, before: 2, spent: 1, after: 1 },
      { act: 2, before: 1, spent: 1, after: 0 }
    ],
    routeGuidance: {
      preserveCharacterIds: ['1001'],
      arcanaPriorityIds: [],
      notes: ['保留稀缺机制角色。']
    },
    plan
  };
}

describe('Theater history deep validation', () => {
  it('stores immutable scenario, eligibility, cast source, vigor and route snapshots', () => {
    const store = new HistoryStore();
    const stored = store.appendTheater(input());
    expect(store.queryTheater({ uid: '123456789' })[0]).toEqual(stored);
    stored.plan.cast.selectedCharacterIds[0] = '9999';
    expect(
      store.queryTheater({ uid: '123456789' })[0]?.plan.cast.selectedCharacterIds
    ).not.toContain('9999');
    expect(store.removeTheaterById(stored.id)).toBe(true);
  });

  it('rejects cast source drift, missing snapshots, and invalid vigor history', () => {
    const store = new HistoryStore();
    const invalid = input();
    invalid.cast[0]!.source = 'trial';
    invalid.cast.pop();
    invalid.vigorBudget[1]!.after = -1;
    expect(() => store.appendTheater(invalid)).toThrow();
  });
});
