import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  AbyssPlanHistoryEntry,
  RecommendationResult,
  StygianPlanHistoryEntry
} from '../../../src/shared/domain.js';
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
    set(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === 'string') {
        storeState.set(key, value);
      } else {
        Object.entries(key).forEach(([entryKey, entryValue]) =>
          storeState.set(entryKey, entryValue)
        );
      }
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

function stygianHistoryInput(): Omit<StygianPlanHistoryEntry, 'id' | 'createdAt'> {
  const input = stygianInput();
  return {
    uid: input.uid,
    scenarioId: input.scenarioId,
    playerCycle: { status: 'unknown' },
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
      target: input.target,
      difficultyId: input.difficultyId,
      preferences: input.preferences
    },
    characters: STYGIAN_CHARACTERS.slice(0, 12).map(({ id, name, element, level }) => ({
      id: String(id),
      name,
      element,
      level
    })),
    phaseGuidance: null,
    difficultyAssessment: null,
    plan: validStygianPlan()
  };
}

describe('HistoryStore', () => {
  it('preserves opaque legacy, abyss, and Stygian raw records when appending new entries', async () => {
    const opaqueLegacy = {
      id: 'legacy-old-record',
      uid: '222222222',
      createdAt: '2025-01-01T00:00:00.000Z',
      oldPayload: { keep: 'legacy' }
    };
    const opaqueAbyss = {
      id: 'abyss-old-record',
      uid: '222222222',
      scenarioId: 'opaque-abyss-cycle',
      oldPayload: { keep: 'abyss' }
    };
    const opaqueStygian = {
      id: 'stygian-old-record',
      uid: '222222222',
      scenarioId: 'opaque-stygian-cycle',
      oldPayload: { keep: 'stygian' }
    };
    storeState.set('entries', [opaqueLegacy]);
    storeState.set('abyssPlans', [opaqueAbyss]);
    storeState.set('stygianPlans', [opaqueStygian]);
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    store.append({
      uid: '111111111',
      enemyNames: [],
      result: makeResult(),
      side: 'single'
    });
    store.appendAbyss(abyssEntryForScope('abyss.2026-07'));
    store.appendStygian(stygianHistoryInput());

    expect(storeState.get('entries')).toEqual(expect.arrayContaining([opaqueLegacy]));
    expect(storeState.get('abyssPlans')).toEqual(expect.arrayContaining([opaqueAbyss]));
    expect(storeState.get('stygianPlans')).toEqual(expect.arrayContaining([opaqueStygian]));
  });

  it('preserves opaque non-target raw records during mode-specific single deletion', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    const abyss = store.appendAbyss(abyssEntryForScope('abyss.2026-07'));
    const stygian = store.appendStygian(stygianHistoryInput());
    const opaqueAbyss = {
      id: 'abyss-old-other',
      uid: '222222222',
      scenarioId: 'opaque-cycle',
      oldPayload: { keep: true }
    };
    const opaqueStygian = {
      id: 'stygian-old-other',
      uid: '222222222',
      scenarioId: 'opaque-cycle',
      oldPayload: { keep: true }
    };
    storeState.set('abyssPlans', [...(storeState.get('abyssPlans') as unknown[]), opaqueAbyss]);
    storeState.set('stygianPlans', [
      ...(storeState.get('stygianPlans') as unknown[]),
      opaqueStygian
    ]);

    expect(store.removeAbyssById(abyss.id)).toBe(true);
    expect(store.removeStygianById(stygian.id)).toBe(true);
    expect(storeState.get('abyssPlans')).toEqual([opaqueAbyss]);
    expect(storeState.get('stygianPlans')).toEqual([opaqueStygian]);
  });

  it('counts and deletes recognizable old raw records in the exact UID scope', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    store.appendStygian(stygianHistoryInput());
    const recognizableOld = {
      id: 'stygian-old-target',
      uid: stygianHistoryInput().uid,
      scenarioId: 'opaque-old-cycle',
      oldPayload: { keepUntilExplicitlySelected: true }
    };
    const unrelatedOld = {
      id: 'stygian-old-unrelated',
      uid: '987654321',
      oldPayload: { keep: true }
    };
    storeState.set('stygianPlans', [
      ...(storeState.get('stygianPlans') as unknown[]),
      recognizableOld,
      unrelatedOld
    ]);

    const confirmation = store.getChallengeScopeConfirmation({
      scope: 'uid',
      uid: stygianHistoryInput().uid
    });

    expect(confirmation.count).toBe(2);
    expect(
      store.removeChallengeScope({
        scope: 'uid',
        uid: stygianHistoryInput().uid,
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).toBe(2);
    expect(storeState.get('stygianPlans')).toEqual([unrelatedOld]);
  });

  it('fails closed before confirmation when an affected raw record has unknown identity', async () => {
    const ambiguous = {
      id: 'stygian-ambiguous-record',
      scenarioId: 'opaque-cycle',
      oldPayload: { uidWasNotRecorded: true }
    };
    storeState.set('stygianPlans', [ambiguous]);
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    expect(() => store.getChallengeScopeConfirmation({ scope: 'uid', uid: '123456789' })).toThrow(
      /identity|识别/iu
    );
    expect(storeState.get('stygianPlans')).toEqual([ambiguous]);
  });

  it('rejects same-ID raw content replacement between confirmation and deletion', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    const entry = store.appendAbyss(abyssEntryForScope('abyss.2026-07'));
    const confirmation = store.getChallengeScopeConfirmation({
      scope: 'group',
      uid: entry.uid,
      mode: entry.mode,
      scenarioId: entry.scenarioId
    });
    const before = (storeState.get('abyssPlans') as AbyssPlanHistoryEntry[])[0]!;
    const replacement = structuredClone(before);
    replacement.plan.firstHalfTeam.purpose = '同 ID 但内容已被替换';
    storeState.set('abyssPlans', [replacement]);

    expect(() =>
      store.removeChallengeScope({
        scope: 'group',
        uid: entry.uid,
        mode: entry.mode,
        scenarioId: entry.scenarioId,
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).toThrow(/changed|变化/iu);
    expect(storeState.get('abyssPlans')).toEqual([replacement]);
  });

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

  it('removes an exact challenge group only when the expected count still matches', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    const first = abyssEntryForScope('abyss.2026-07');
    const second = abyssEntryForScope('abyss.2026-07');
    store.appendAbyss(first);
    store.appendAbyss(second);
    store.appendAbyss(abyssEntryForScope('abyss.2026-08'));

    const staleConfirmation = store.getChallengeScopeConfirmation({
      scope: 'group',
      uid: first.uid,
      mode: 'spiral-abyss',
      scenarioId: first.scenarioId
    });
    expect(() =>
      store.removeChallengeScope({
        scope: 'group',
        uid: first.uid,
        mode: 'spiral-abyss',
        scenarioId: first.scenarioId,
        expectedCount: 1,
        confirmationToken: staleConfirmation.confirmationToken
      })
    ).toThrow(/changed/i);
    expect(store.queryAbyss()).toHaveLength(3);

    const confirmation = store.getChallengeScopeConfirmation({
      scope: 'group',
      uid: first.uid,
      mode: 'spiral-abyss',
      scenarioId: first.scenarioId
    });
    expect(
      store.removeChallengeScope({
        scope: 'group',
        uid: first.uid,
        mode: 'spiral-abyss',
        scenarioId: first.scenarioId,
        expectedCount: 2,
        confirmationToken: confirmation.confirmationToken
      })
    ).toBe(2);
    expect(() =>
      store.removeChallengeScope({
        scope: 'group',
        uid: first.uid,
        mode: 'spiral-abyss',
        scenarioId: first.scenarioId,
        expectedCount: 2,
        confirmationToken: confirmation.confirmationToken
      })
    ).toThrow(/expired/i);
    expect(store.queryAbyss()).toHaveLength(1);
  });

  it('uses opaque expiring confirmations bound to one exact scope', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    let now = 1_000;
    const store = new HistoryStore(() => now);
    const entry = store.appendAbyss(abyssEntryForScope('abyss.2026-07'));
    const confirmation = store.getChallengeScopeConfirmation({
      scope: 'group',
      uid: entry.uid,
      mode: entry.mode,
      scenarioId: entry.scenarioId
    });

    expect(confirmation.confirmationToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    );
    expect(confirmation.confirmationToken).not.toBe(
      store.getChallengeScopeSnapshot({ scope: 'all' }).fingerprint
    );
    expect(() =>
      store.removeChallengeScope({
        scope: 'uid',
        uid: entry.uid,
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).toThrow(/changed/i);
    expect(() =>
      store.removeChallengeScope({
        scope: 'group',
        uid: entry.uid,
        mode: entry.mode,
        scenarioId: entry.scenarioId,
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).toThrow(/expired/i);

    const expired = store.getChallengeScopeConfirmation({ scope: 'uid', uid: entry.uid });
    now += 5 * 60_000 + 1;
    expect(() =>
      store.removeChallengeScope({
        scope: 'uid',
        uid: entry.uid,
        expectedCount: expired.count,
        confirmationToken: expired.confirmationToken
      })
    ).toThrow(/expired/i);
    expect(store.queryAbyss()).toHaveLength(1);
  });

  it('clears every history collection only with an exact count guard', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    store.append({
      uid: '111111111',
      enemyNames: [],
      result: makeResult(),
      side: 'single'
    });
    store.appendAbyss(abyssEntryForScope('abyss.2026-07'));

    expect(store.getSummary()).toMatchObject({ count: 2 });
    const firstConfirmation = store.getChallengeScopeConfirmation({ scope: 'all' });
    expect(() =>
      store.removeChallengeScope({
        scope: 'all',
        expectedCount: 1,
        confirmationToken: firstConfirmation.confirmationToken
      })
    ).toThrow(/changed/i);
    const confirmation = store.getChallengeScopeConfirmation({ scope: 'all' });
    expect(
      store.removeChallengeScope({
        scope: 'all',
        expectedCount: 2,
        confirmationToken: confirmation.confirmationToken
      })
    ).toBe(2);
    expect(store.getSummary()).toMatchObject({ count: 0 });
  });

  it('rejects a stale confirmation when records are replaced without changing the count', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    const original = store.appendAbyss(abyssEntryForScope('abyss.2026-07'));
    const confirmation = store.getChallengeScopeConfirmation({ scope: 'all' });

    expect(store.removeAbyssById(original.id)).toBe(true);
    store.appendAbyss(abyssEntryForScope('abyss.2026-08'));
    expect(store.getSummary().count).toBe(confirmation.count);
    expect(() =>
      store.removeChallengeScope({
        scope: 'all',
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).toThrow(/changed/i);
    expect(store.getSummary().count).toBe(1);
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
      playerCycle: { status: 'unknown' },
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
        scenarioTrust: 'development-sample',
        narrative: expect.objectContaining({ origin: 'legacy-unavailable' })
      })
    ]);
  });

  it('drops persisted Abyss records with malformed supplied narrative or team-risk contracts', async () => {
    const base = {
      id: 'invalid-abyss-narrative',
      createdAt: '2026-07-22T00:00:00.000Z',
      ...abyssEntryForScope('abyss.2026-07')
    };
    storeState.set('abyssPlans', [
      { ...base, narrative: { origin: 'agent-structured', summary: 'free text' } },
      {
        ...base,
        id: 'invalid-abyss-team-risk',
        teamRisks: [{ half: 'first', severity: 'soft', code: 'bad', narrative: 'free text' }]
      }
    ]);
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    expect(store.queryAbyss()).toEqual([]);
  });

  it('keeps old Stygian history readable with honest unknown period and missing guidance', async () => {
    storeState.set('stygianPlans', [
      {
        id: 'legacy-stygian-history',
        createdAt: '2026-07-22T00:00:00.000Z',
        ...stygianHistoryInput()
      }
    ]);
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();

    expect(store.queryStygian()).toEqual([
      expect.objectContaining({
        id: 'legacy-stygian-history',
        playerCycle: { status: 'unknown' },
        phaseGuidance: null,
        difficultyAssessment: null,
        narrative: expect.objectContaining({ origin: 'legacy-unavailable' })
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
      playerCycle: { status: 'unknown' },
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
      playerCycle: { status: 'unknown' },
      schemaVersion: 2,
      dataVersion: input.dataVersion,
      mode: 'stygian-onslaught',
      difficultyId: input.difficultyId,
      difficultyNames: { 'zh-CN': '难度 6' },
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
        target: input.target,
        difficultyId: input.difficultyId,
        preferences: input.preferences
      },
      characters: STYGIAN_CHARACTERS.slice(0, 12).map(({ id, name, element, level }) => ({
        id: String(id),
        name,
        element,
        level
      })),
      phaseGuidance: null,
      difficultyAssessment: null,
      plan
    });

    plan.phases[0]!.team.characterIds[0] = '9999';
    input.lockedCharacterIds.push('1002');
    const stored = store.queryStygian({ uid: input.uid })[0];
    expect(stored).toMatchObject({
      mode: 'stygian-onslaught',
      difficultyId: 'difficulty-6',
      difficultyNames: { 'zh-CN': '难度 6' },
      target: 'dire-challenge',
      phase: 2,
      reusePolicy: { rule: 'forbidden' },
      scenarioTrust: 'production'
    });
    expect(stored?.plan.phases[0]?.team.characterIds[0]).toBe('1001');
    expect(stored?.interventions.lockedCharacterIds).toEqual(['1001']);
    expect(stored?.interventions).toMatchObject({
      target: 'dire-challenge',
      difficultyId: 'difficulty-6'
    });
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
      playerCycle: { status: 'unknown' },
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
        target: input.target,
        difficultyId: input.difficultyId,
        preferences: input.preferences
      },
      characters: STYGIAN_CHARACTERS.slice(0, 12).map(({ id, name, element, level }) => ({
        id: String(id),
        name,
        element,
        level
      })),
      phaseGuidance: null,
      difficultyAssessment: null,
      plan: validStygianPlan()
    });
    storeState.set('stygianPlans', [
      { ...valid, reusePolicy: undefined },
      { ...valid, target: 'internal-target' },
      { ...valid, plan: { ...valid.plan, phases: [] } },
      { ...valid, characters: valid.characters.slice(1) },
      {
        ...valid,
        plan: {
          ...valid.plan,
          phases: valid.plan.phases.map((phase) => ({
            ...phase,
            team: { ...phase.team, characterIds: ['1001', '1002', '1003', '1004'] }
          }))
        }
      },
      {
        ...valid,
        reusePolicy: { rule: 'limited', maxPartyAppearancesPerCharacter: 2, notes: [] },
        plan: {
          ...valid.plan,
          reusePolicyAcknowledgement: 'limited',
          phases: valid.plan.phases.map((phase) => ({
            ...phase,
            team: { ...phase.team, characterIds: ['1001', '1002', '1003', '1004'] }
          }))
        }
      },
      {
        ...valid,
        interventions: { ...valid.interventions, lockedCharacterIds: ['1014'] }
      },
      {
        ...valid,
        interventions: { ...valid.interventions, excludedCharacterIds: ['1001'] }
      },
      {
        ...valid,
        interventions: { ...valid.interventions, target: 'primogems' }
      },
      {
        ...valid,
        interventions: { ...valid.interventions, difficultyId: 'difficulty-5' }
      },
      {
        ...valid,
        characters: [
          ...valid.characters,
          { id: '1013', name: '无关快照角色', element: 'Pyro', level: 90 }
        ]
      }
    ]);
    expect(store.queryStygian()).toEqual([]);
  });

  it('rejects a semantically invalid Stygian entry before mutating storage', async () => {
    const { HistoryStore } = await import('../../../src/main/services/history-store.js');
    const store = new HistoryStore();
    const valid = store.appendStygian(stygianHistoryInput());
    const before = structuredClone(storeState.get('stygianPlans'));
    const invalid = stygianHistoryInput();
    invalid.plan.phases = invalid.plan.phases.map((phase) => ({
      ...phase,
      team: { ...phase.team, characterIds: ['1001', '1002', '1003', '1004'] }
    }));

    expect(() => store.appendStygian(invalid)).toThrow();
    expect(storeState.get('stygianPlans')).toEqual(before);
    expect(store.queryStygian().map(({ id }) => id)).toEqual([valid.id]);
  });
});

function abyssEntryForScope(scenarioId: string): Omit<AbyssPlanHistoryEntry, 'id' | 'createdAt'> {
  const input = abyssInput();
  return {
    uid: input.uid,
    scenarioId,
    playerCycle: { status: 'unknown' },
    schemaVersion: 2,
    dataVersion: input.dataVersion,
    mode: 'spiral-abyss',
    target: { floor: input.floor },
    source: 'local-rules',
    scenarioTrust: 'production',
    scenarioFreshness: 'fresh',
    scenarioNotCurrent: false,
    interventions: {
      lockedCharacterIds: [],
      excludedCharacterIds: [],
      preferences: input.preferences
    },
    characters: [],
    plan: { ...validAbyssPlan(), scenarioId }
  };
}
