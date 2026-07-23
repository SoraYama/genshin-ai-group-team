import { describe, expect, it } from 'vitest';
import type {
  AbyssPlanHistoryEntry,
  StygianPlanHistoryEntry,
  TheaterPlanHistoryEntry
} from '../../../src/shared/domain.js';
import {
  createHistoryRerunIntent,
  groupChallengeHistory,
  historyCardTitle,
  historySavedVersion,
  periodLabelFromScenario
} from '../../../src/renderer/pages/History/history-presentation.js';
import { abyssInput, validAbyssPlan } from '../services/abyss-test-fixtures.js';
import { stygianInput, validStygianPlan } from '../services/stygian-test-fixtures.js';
import { theaterInput, validTheaterPlan } from '../services/theater-test-fixtures.js';

function abyssEntry(): AbyssPlanHistoryEntry {
  const input = abyssInput({ chamber: 2, lockedCharacterIds: ['1001'] });
  return {
    id: 'abyss-history-1',
    createdAt: '2026-07-23T08:00:00.000Z',
    uid: input.uid,
    scenarioId: input.scenarioId,
    schemaVersion: 2,
    dataVersion: input.dataVersion,
    mode: 'spiral-abyss',
    target: { floor: input.floor, chamber: input.chamber },
    source: 'smart-service',
    scenarioTrust: 'production',
    scenarioFreshness: 'fresh',
    scenarioNotCurrent: false,
    interventions: {
      lockedCharacterIds: input.lockedCharacterIds,
      excludedCharacterIds: input.excludedCharacterIds,
      preferences: input.preferences
    },
    characters: [],
    plan: validAbyssPlan()
  };
}

function stygianEntry(): StygianPlanHistoryEntry {
  const input = stygianInput({
    target: 'high-reward',
    lockedCharacterIds: ['2001']
  });
  return {
    id: 'stygian-history-1',
    createdAt: '2026-07-22T08:00:00.000Z',
    uid: input.uid,
    scenarioId: input.scenarioId,
    schemaVersion: 2,
    dataVersion: input.dataVersion,
    mode: 'stygian-onslaught',
    difficultyId: input.difficultyId,
    difficultyName: '难度 5',
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
    characters: [],
    plan: validStygianPlan()
  };
}

function theaterEntry(): TheaterPlanHistoryEntry {
  const input = theaterInput({
    act: 8,
    target: 'safe-clear',
    selectedCharacterIds: ['1001'],
    selectedSupportCharacterIds: ['support:1']
  });
  return {
    id: 'theater-history-1',
    createdAt: '2026-07-21T08:00:00.000Z',
    uid: input.uid,
    scenarioId: input.scenarioId,
    schemaVersion: 2,
    dataVersion: input.dataVersion,
    mode: 'imaginarium-theater',
    act: input.act,
    target: input.target,
    source: 'smart-service',
    scenarioTrust: 'production',
    scenarioFreshness: 'fresh',
    scenarioNotCurrent: false,
    interventions: input,
    eligibility: {
      status: 'eligible',
      requiredHeadcount: 1,
      eligibleOwnedCount: 1,
      hardQualifiedCount: 1,
      shortage: 0,
      eligibleOwnedCharacterIds: ['1001'],
      ineligibleOwned: [],
      pools: [],
      constructionAdvice: []
    },
    cast: [{ id: '1001', name: '测试角色', source: 'owned' }],
    vigorBudget: [],
    nodeBudget: [],
    routeGuidance: {
      preserveCharacterIds: [],
      arcanaPriorityIds: [],
      arcanaPriorities: [],
      notes: ['按当前路线保留角色。']
    },
    plan: validTheaterPlan()
  };
}

describe('history presentation', () => {
  it('uses player-facing titles and derives a stable cycle label', () => {
    expect(historyCardTitle(abyssEntry())).toBe('深境螺旋 12 层 · 第 2 间');
    expect(historyCardTitle(stygianEntry())).toBe('幽境危战 · 难度 5');
    expect(historyCardTitle(theaterEntry())).toBe('幻想真境剧诗 · 第 8 幕');
    expect(periodLabelFromScenario('theater.2026-07-season')).toBe('2026-07');
    expect(periodLabelFromScenario('opaque-cycle')).toBe('记录周期');
  });

  it('keeps development identifiers out of player-facing saved-version details', () => {
    const entry = {
      ...stygianEntry(),
      scenarioId: 'development.stygian-onslaught.sample-001',
      dataVersion: 'development.2026-01.1',
      scenarioTrust: 'development-sample' as const
    };

    expect(historySavedVersion(entry, 'zh')).toEqual({
      scenario: '演练周期',
      data: '演练资料'
    });
    expect(JSON.stringify(historySavedVersion(entry, 'zh'))).not.toContain('development');
  });

  it('groups by mode and immutable scenario identity with newest groups first', () => {
    const groups = groupChallengeHistory([theaterEntry(), abyssEntry(), stygianEntry()]);
    expect(groups.map((group) => group.mode)).toEqual([
      'spiral-abyss',
      'stygian-onslaught',
      'imaginarium-theater'
    ]);
    expect(groups[0]).toMatchObject({
      scenarioId: abyssEntry().scenarioId,
      title: expect.stringContaining('深境螺旋')
    });
  });

  it('preserves each mode intervention as a prefill-only rerun intent', () => {
    expect(createHistoryRerunIntent(abyssEntry())).toMatchObject({
      mode: 'spiral-abyss',
      floor: 12,
      chamber: 2,
      lockedCharacterIds: ['1001']
    });
    expect(createHistoryRerunIntent(stygianEntry())).toMatchObject({
      mode: 'stygian-onslaught',
      difficultyId: stygianEntry().difficultyId,
      target: 'high-reward',
      lockedCharacterIds: ['2001']
    });
    expect(createHistoryRerunIntent(theaterEntry())).toMatchObject({
      mode: 'imaginarium-theater',
      act: 8,
      target: 'safe-clear',
      selectedCharacterIds: ['1001'],
      selectedSupportCharacterIds: ['support:1']
    });
  });
});
