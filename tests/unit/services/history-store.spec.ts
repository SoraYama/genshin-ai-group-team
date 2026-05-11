import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RecommendationResult } from '../../../src/shared/domain.js';

const storeState = new Map<string, unknown>();

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      if (opts.defaults) {
        for (const [key, value] of Object.entries(opts.defaults)) {
          if (!storeState.has(key)) {
            storeState.set(key, value);
          }
        }
      }
    }
    get(key: string) {
      return storeState.get(key);
    }
    set(key: string, value: unknown) {
      storeState.set(key, value);
    }
    delete(key: string) {
      storeState.delete(key);
    }
  }
}));

beforeEach(() => {
  storeState.clear();
});

function makeResult(source: 'llm' | 'fallback' = 'llm'): RecommendationResult {
  return {
    source,
    summary: 'test summary',
    teams: [
      {
        name: '示例队',
        characters: [
          { id: 1, name: 'A', element: 'Pyro' },
          { id: 2, name: 'B', element: 'Hydro' },
          { id: 3, name: 'C', element: 'Geo' },
          { id: 4, name: 'D', element: 'Hydro' }
        ],
        reasoning: 'ok',
        rotationTip: 'go'
      }
    ]
  };
}

describe('HistoryStore', () => {
  it('appends entries and returns latest first', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    store.append({
      uid: '111111111',
      enemyNames: ['abyss-mage'],
      result: makeResult('llm'),
      side: 'single'
    });
    store.append({
      uid: '111111111',
      enemyNames: ['ruin-guard'],
      result: makeResult('fallback'),
      side: 'single'
    });

    const result = store.query();
    expect(result.total).toBe(2);
    expect(result.items[0]?.enemyNames).toEqual(['ruin-guard']);
    expect(result.items[1]?.enemyNames).toEqual(['abyss-mage']);
  });

  it('filters by uid, source, enemyKeyword', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    store.append({ uid: '111111111', enemyNames: ['abyss-mage'], result: makeResult('llm'), side: 'single' });
    store.append({ uid: '222222222', enemyNames: ['abyss-mage'], result: makeResult('fallback'), side: 'single' });
    store.append({ uid: '111111111', enemyNames: ['ruin-guard'], result: makeResult('llm'), side: 'single' });

    expect(store.query({ uid: '111111111' }).total).toBe(2);
    expect(store.query({ source: 'fallback' }).total).toBe(1);
    expect(store.query({ enemyKeyword: 'abyss' }).total).toBe(2);
    expect(store.query({ uid: '111111111', source: 'fallback' }).total).toBe(0);
  });

  it('paginates with offset/limit', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    for (let i = 0; i < 5; i += 1) {
      store.append({
        uid: '111111111',
        enemyNames: [`enemy-${i}`],
        result: makeResult('llm'),
        side: 'single'
      });
    }

    const page1 = store.query({ limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(5);

    const page3 = store.query({ limit: 2, offset: 4 });
    expect(page3.items).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
  });

  it('caps at 200 entries', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    for (let i = 0; i < 220; i += 1) {
      store.append({
        uid: '111111111',
        enemyNames: [`enemy-${i}`],
        result: makeResult('llm'),
        side: 'single'
      });
    }

    expect(store.query({ limit: 100 }).total).toBe(200);
    // 最新的 200 条应该是 20-219
    const newest = store.query({ limit: 1 }).items[0];
    expect(newest?.enemyNames).toEqual(['enemy-219']);
  });

  it('removes by id', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    const entry = store.append({
      uid: '111111111',
      enemyNames: ['abyss-mage'],
      result: makeResult('llm'),
      side: 'single'
    });

    expect(store.removeById(entry.id)).toBe(true);
    expect(store.removeById(entry.id)).toBe(false);
    expect(store.query().total).toBe(0);
  });

  it('refuses removeMany without filters to prevent accidental clear', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    store.append({ uid: '111111111', enemyNames: [], result: makeResult('llm'), side: 'single' });

    expect(() => store.removeMany({})).toThrow(/at least one filter/);
    expect(store.query().total).toBe(1);
  });

  it('removeMany deletes only matching entries', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    store.append({ uid: '111111111', enemyNames: ['abyss'], result: makeResult('llm'), side: 'single' });
    store.append({ uid: '111111111', enemyNames: ['ruin'], result: makeResult('fallback'), side: 'single' });
    store.append({ uid: '222222222', enemyNames: ['abyss'], result: makeResult('llm'), side: 'single' });

    const removed = store.removeMany({ source: 'fallback' });
    expect(removed).toBe(1);
    expect(store.query().total).toBe(2);
  });
});
