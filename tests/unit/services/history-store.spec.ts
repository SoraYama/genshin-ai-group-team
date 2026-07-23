import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RecommendationResult } from '../../../src/shared/domain.js';
import { ABYSS_CHARACTERS, abyssInput, validAbyssPlan } from './abyss-test-fixtures.js';
import { STYGIAN_CHARACTERS, stygianInput, validStygianPlan } from './stygian-test-fixtures.js';

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

    store.append({
      uid: '111111111',
      enemyNames: ['abyss-mage'],
      result: makeResult('llm'),
      side: 'single'
    });
    store.append({
      uid: '222222222',
      enemyNames: ['abyss-mage'],
      result: makeResult('fallback'),
      side: 'single'
    });
    store.append({
      uid: '111111111',
      enemyNames: ['ruin-guard'],
      result: makeResult('llm'),
      side: 'single'
    });

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

    store.append({
      uid: '111111111',
      enemyNames: ['abyss'],
      result: makeResult('llm'),
      side: 'single'
    });
    store.append({
      uid: '111111111',
      enemyNames: ['ruin'],
      result: makeResult('fallback'),
      side: 'single'
    });
    store.append({
      uid: '222222222',
      enemyNames: ['abyss'],
      result: makeResult('llm'),
      side: 'single'
    });

    const removed = store.removeMany({ source: 'fallback' });
    expect(removed).toBe(1);
    expect(store.query().total).toBe(2);
  });

  it('stores an immutable abyss snapshot with scenario version, target, source, and interventions', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    const plan = validAbyssPlan();
    const input = abyssInput({
      lockedCharacterIds: ['1001'],
      excludedCharacterIds: ['1010'],
      chamber: 1
    });

    const entry = store.appendAbyss({
      uid: input.uid,
      scenarioId: input.scenarioId,
      schemaVersion: 2,
      dataVersion: input.dataVersion,
      mode: 'spiral-abyss',
      target: { floor: input.floor, chamber: input.chamber },
      source: 'local-rules',
      scenarioTrust: 'production',
      scenarioFreshness: 'fresh',
      scenarioNotCurrent: false,
      interventions: {
        lockedCharacterIds: input.lockedCharacterIds,
        excludedCharacterIds: input.excludedCharacterIds,
        preferences: input.preferences
      },
      characters: ABYSS_CHARACTERS.slice(0, 8).map(({ id, name, element, level }) => ({
        id: String(id),
        name,
        element,
        level
      })),
      plan
    });

    plan.firstHalfTeam.characterIds[0] = '9999';
    input.lockedCharacterIds.push('1002');
    const stored = store.queryAbyss({ uid: input.uid })[0];
    expect(entry).toMatchObject({
      scenarioId: 'abyss.2026-07',
      schemaVersion: 2,
      dataVersion: '2026.07.1',
      mode: 'spiral-abyss',
      target: { floor: 12, chamber: 1 },
      source: 'local-rules'
    });
    expect(stored?.plan.firstHalfTeam.characterIds[0]).toBe('1001');
    expect(stored?.interventions.lockedCharacterIds).toEqual(['1001']);
    expect(stored?.characters[0]).toMatchObject({ id: '1001', name: '测试角色1' });
    expect(store.removeAbyssById(entry.id)).toBe(true);
    expect(store.queryAbyss({ uid: input.uid })).toEqual([]);
  });

  it('normalizes abyss plans written before character snapshots and trust metadata existed', async () => {
    storeState.set('abyssPlans', [
      {
        id: 'legacy-abyss',
        createdAt: '2026-07-22T00:00:00.000Z',
        uid: '123456789',
        scenarioId: 'development.spiral-abyss.sample',
        schemaVersion: 2,
        dataVersion: 'development.sample-v1',
        mode: 'spiral-abyss',
        target: { floor: 12 },
        source: 'local-rules',
        interventions: {
          lockedCharacterIds: [],
          excludedCharacterIds: [],
          preferences: abyssInput().preferences
        },
        plan: validAbyssPlan()
      }
    ]);
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    expect(store.queryAbyss()).toEqual([
      expect.objectContaining({
        id: 'legacy-abyss',
        characters: [],
        scenarioTrust: 'development-sample'
      })
    ]);
  });

  it('keeps legacy recommendation entries readable after abyss history is introduced', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    store.append({
      uid: '111111111',
      enemyNames: ['legacy-enemy'],
      result: makeResult('fallback'),
      side: 'single'
    });
    store.appendAbyss({
      uid: '111111111',
      scenarioId: 'abyss.2026-07',
      schemaVersion: 2,
      dataVersion: '2026.07.1',
      mode: 'spiral-abyss',
      target: { floor: 12 },
      source: 'local-rules',
      scenarioTrust: 'production',
      scenarioFreshness: 'fresh',
      scenarioNotCurrent: false,
      interventions: {
        lockedCharacterIds: [],
        excludedCharacterIds: [],
        preferences: abyssInput().preferences
      },
      characters: ABYSS_CHARACTERS.slice(0, 8).map(({ id, name, element, level }) => ({
        id: String(id),
        name,
        element,
        level
      })),
      plan: validAbyssPlan()
    });

    expect(store.query().items[0]?.enemyNames).toEqual(['legacy-enemy']);
    expect(store.queryAbyss({ uid: '111111111' })).toHaveLength(1);
  });

  it('stores an immutable Stygian snapshot with difficulty, goal, reuse rule, trust, and three-team names', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    const input = stygianInput({
      lockedCharacterIds: ['1001'],
      target: 'dire-challenge',
      phase: 2
    });
    const plan = validStygianPlan();
    const entry = store.appendStygian({
      uid: input.uid,
      scenarioId: input.scenarioId,
      schemaVersion: 2,
      dataVersion: input.dataVersion,
      mode: 'stygian-onslaught',
      difficultyId: input.difficultyId,
      difficultyName: '难度 6',
      phase: input.phase,
      target: input.target,
      reusePolicy: { rule: 'forbidden', notes: [] },
      source: 'local-rules',
      scenarioTrust: 'production',
      scenarioFreshness: 'fresh',
      scenarioNotCurrent: false,
      interventions: {
        lockedCharacterIds: input.lockedCharacterIds,
        excludedCharacterIds: input.excludedCharacterIds,
        preferences: input.preferences
      },
      characters: STYGIAN_CHARACTERS.slice(0, 12).map(({ id, name, element, level }) => ({
        id: String(id),
        name,
        element,
        level
      })),
      plan
    });

    plan.phases[0]!.team.characterIds[0] = '9999';
    input.lockedCharacterIds.push('1002');
    const stored = store.queryStygian({ uid: input.uid })[0];
    expect(stored).toMatchObject({
      mode: 'stygian-onslaught',
      difficultyId: 'difficulty-6',
      difficultyName: '难度 6',
      target: 'dire-challenge',
      phase: 2,
      reusePolicy: { rule: 'forbidden' },
      scenarioTrust: 'production'
    });
    expect(stored?.plan.phases[0]?.team.characterIds[0]).toBe('1001');
    expect(stored?.interventions.lockedCharacterIds).toEqual(['1001']);
    expect(stored?.characters.map(({ name }) => name)).toContain('幽境角色1');
    expect(store.removeStygianById(entry.id)).toBe(true);
    expect(store.queryStygian()).toEqual([]);
  });

  it('drops corrupt Stygian history records before they can reach the renderer', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    const input = stygianInput();
    const valid = store.appendStygian({
      uid: input.uid,
      scenarioId: input.scenarioId,
      schemaVersion: 2,
      dataVersion: input.dataVersion,
      mode: 'stygian-onslaught',
      difficultyId: input.difficultyId,
      difficultyName: '难度 6',
      target: input.target,
      reusePolicy: { rule: 'forbidden', notes: [] },
      source: 'local-rules',
      scenarioTrust: 'production',
      scenarioFreshness: 'fresh',
      scenarioNotCurrent: false,
      interventions: {
        lockedCharacterIds: [],
        excludedCharacterIds: [],
        preferences: input.preferences
      },
      characters: STYGIAN_CHARACTERS.slice(0, 12).map(({ id, name, element, level }) => ({
        id: String(id),
        name,
        element,
        level
      })),
      plan: validStygianPlan()
    });
    storeState.set('stygianPlans', [
      { ...valid, reusePolicy: undefined },
      { ...valid, target: 'internal-target' },
      { ...valid, plan: { ...valid.plan, phases: [] } },
      { ...valid, characters: valid.characters.slice(1) }
    ]);
    expect(store.queryStygian()).toEqual([]);
  });
});
