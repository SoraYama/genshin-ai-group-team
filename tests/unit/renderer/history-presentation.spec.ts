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
  historyConfidenceLabel,
  historyDeleteRecoveryKind,
  historyDetailSemanticSnapshot,
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
    playerCycle: { status: 'unknown' },
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
    playerCycle: { status: 'unknown' },
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
    phaseGuidance: null,
    difficultyAssessment: null,
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
    playerCycle: { status: 'unknown' },
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
  it('re-prepares a failed confirmed scope instead of only reloading the list', () => {
    expect(historyDeleteRecoveryKind('IPC_CONFIRMATION_EXPIRED', 'group')).toBe('reconfirm');
    expect(historyDeleteRecoveryKind('IPC_SELECTION_CHANGED', 'uid')).toBe('reconfirm');
    expect(historyDeleteRecoveryKind('IPC_SELECTION_CHANGED', 'single')).toBe('reload');
    expect(historyDeleteRecoveryKind('IPC_INTERNAL', 'group')).toBe('reload');
  });

  it('uses player-facing titles and derives a stable cycle label', () => {
    expect(historyCardTitle(abyssEntry())).toBe('深境螺旋 12 层 · 第 2 间');
    expect(historyCardTitle(stygianEntry())).toBe('幽境危战 · 难度 5');
    expect(historyCardTitle(theaterEntry())).toBe('幻想真境剧诗 · 第 8 幕');
    expect(periodLabelFromScenario('theater.2026-07-season')).toBe('保存时未记录周期');
    expect(periodLabelFromScenario('opaque-cycle')).toBe('保存时未记录周期');
  });

  it('uses the immutable player period for opaque scenario identities and never exposes the slug', () => {
    const entry = {
      ...abyssEntry(),
      scenarioId: 'opaque.internal.slug-without-a-date',
      playerCycle: {
        status: 'known' as const,
        label: '2026-07-01 — 2026-07-15',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        effectiveTo: '2026-07-15T00:00:00.000Z'
      }
    };

    expect(historySavedVersion(entry, 'zh')).toEqual({
      scenario: '2026-07-01 — 2026-07-15',
      data: '2026.07.1'
    });
    expect(groupChallengeHistory([entry])[0]?.title).toBe(
      '深境螺旋 · 2026-07-01 — 2026-07-15'
    );
    expect(JSON.stringify(historySavedVersion(entry, 'zh'))).not.toContain(entry.scenarioId);
  });

  it('renders plan confidence as an honest player-facing suggestion level', () => {
    expect(historyConfidenceLabel(abyssEntry(), 'zh')).toBe('建议把握：中');
    const unknown = abyssEntry() as AbyssPlanHistoryEntry;
    delete (unknown.plan as { confidence?: string }).confidence;
    expect(historyConfidenceLabel(unknown, 'zh')).toBe('建议把握：未知');
    expect(historyConfidenceLabel(theaterEntry(), 'en')).toBe('Suggestion confidence: Medium');
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

  it('never merges identical challenge cycles across UIDs', () => {
    const first = abyssEntry();
    const second = { ...abyssEntry(), id: 'abyss-history-2', uid: '987654321' };

    const groups = groupChallengeHistory([first, second]);

    expect(groups).toHaveLength(2);
    expect(groups.map(({ key }) => key)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(first.uid),
        expect.stringContaining(second.uid)
      ])
    );
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

  it('preserves the complete immutable semantic snapshot for all three challenge modes', () => {
    const abyss = abyssEntry();
    abyss.plan.firstHalfTeam.purpose = '深渊队伍用途';
    abyss.plan.firstHalfTeam.rotationNotes = ['深渊循环'];
    abyss.plan.warnings = ['深渊提醒'];
    abyss.plan.assumptions = ['深渊前提'];
    abyss.plan.chambers[0]!.firstHalf.tactics = ['深渊打法'];
    abyss.plan.chambers[0]!.firstHalf.risks = ['深渊风险'];
    abyss.plan.chambers[0]!.firstHalf.substitutionNotes = ['深渊替换'];

    const stygian = Object.assign(stygianEntry(), {
      phaseGuidance: [1, 2, 3].map((phase) => ({
        phase,
        mechanismBasis: [`第 ${phase} 阶段机制依据`],
        risks: [`第 ${phase} 阶段风险`]
      })),
      difficultyAssessment: {
        recommendation: 'proceed-with-caution' as const,
        evidence: ['当前难度需要谨慎。']
      }
    });
    stygian.plan.phases[0]!.team.rotationNotes = ['危战循环'];
    stygian.plan.warnings = ['危战提醒'];
    stygian.plan.assumptions = ['危战前提'];

    const theater = theaterEntry();
    theater.plan.acts[0]!.plannedVigorSpend = [{ characterId: '1001', cost: 2 }];
    theater.vigorBudget = [{ act: 1, characterId: '1001', before: 2, spent: 1, after: 1 }];
    theater.nodeBudget = [{ nodeId: 'arcana:1', cost: 1 }];
    theater.routeGuidance = {
      preserveCharacterIds: ['1001'],
      arcanaPriorityIds: ['arcana:1'],
      arcanaPriorities: [
        {
          nodeId: 'arcana:1',
          name: '剧诗秘法',
          condition: '出现聚怪路线时',
          reason: '补足路线能力'
        }
      ],
      notes: ['剧诗路线说明']
    };
    theater.plan.warnings = ['剧诗提醒'];
    theater.plan.assumptions = ['剧诗前提'];

    expect(historyDetailSemanticSnapshot(abyss)).toMatchObject({
      mode: 'spiral-abyss',
      teams: {
        first: { purpose: '深渊队伍用途', rotationNotes: ['深渊循环'] }
      },
      chambers: expect.arrayContaining([
        expect.objectContaining({
          firstHalf: {
            tactics: ['深渊打法'],
            risks: ['深渊风险'],
            substitutionNotes: ['深渊替换']
          }
        })
      ]),
      warnings: ['深渊提醒'],
      assumptions: ['深渊前提']
    });
    expect(historyDetailSemanticSnapshot(stygian)).toMatchObject({
      mode: 'stygian-onslaught',
      phases: expect.arrayContaining([
        expect.objectContaining({ team: expect.objectContaining({ rotationNotes: ['危战循环'] }) })
      ]),
      warnings: ['危战提醒'],
      assumptions: ['危战前提'],
      phaseGuidance: stygian.phaseGuidance,
      difficultyAssessment: stygian.difficultyAssessment
    });
    expect(historyDetailSemanticSnapshot(theater)).toMatchObject({
      mode: 'imaginarium-theater',
      acts: expect.arrayContaining([
        expect.objectContaining({
          plannedVigorSpend: [{ characterId: '1001', cost: 2 }]
        })
      ]),
      vigorBudget: [{ before: 2, spent: 1, after: 1 }],
      nodeBudget: [{ nodeId: 'arcana:1', cost: 1 }],
      routeGuidance: {
        arcanaPriorities: [
          {
            name: '剧诗秘法',
            condition: '出现聚怪路线时',
            reason: '补足路线能力'
          }
        ],
        notes: ['剧诗路线说明']
      },
      warnings: ['剧诗提醒'],
      assumptions: ['剧诗前提']
    });
  });
});
