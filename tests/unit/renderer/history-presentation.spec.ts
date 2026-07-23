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
  historyDifficultyLabel,
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
    difficultyNames: { 'zh-CN': '难度 5', 'en-US': 'Difficulty 5' },
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
    expect(historyCardTitle(abyssEntry(), 'en')).toBe('Spiral Abyss · Floor 12 · Chamber 2');
    expect(historyCardTitle(stygianEntry(), 'en')).toBe('Stygian Onslaught · Difficulty 5');
    expect(
      historyCardTitle(
        {
          ...stygianEntry(),
          difficultyName: undefined,
          difficultyNames: { 'zh-CN': '险境', 'en-US': 'Perilous' }
        },
        'en'
      )
    ).toBe('Stygian Onslaught · Perilous');
    expect(historyCardTitle(theaterEntry(), 'en')).toBe('Imaginarium Theater · Act 8');
    expect(periodLabelFromScenario('opaque-cycle', 'en')).toBe('Period not saved');
  });

  it('never presents a legacy Chinese-only difficulty label as localized English', () => {
    const legacy = {
      ...stygianEntry(),
      difficultyName: undefined,
      difficultyNames: undefined,
      legacyDifficultyName: { text: '绝境', locale: null }
    };

    expect(historyDifficultyLabel(legacy, 'en')).toBe(
      'Saved difficulty (original label unavailable in English)'
    );
    expect(historyDifficultyLabel(legacy, 'en')).not.toContain('绝境');
    expect(historyDifficultyLabel(legacy, 'en')).not.toContain(legacy.difficultyId);
    expect(historyDifficultyLabel(legacy, 'zh')).toBe('旧记录原始名称：绝境');
  });

  it('uses bilingual snapshots for new records and neutral stable labels for legacy names', async () => {
    const presentation =
      (await import('../../../src/renderer/pages/History/history-presentation.js')) as Record<
        string,
        unknown
      >;
    expect(presentation.historyEntityName).toBeTypeOf('function');
    const historyEntityName = presentation.historyEntityName as (options: {
      names?: Record<string, string>;
      rawText?: string;
      id: string;
      orderedIds: string[];
      kind: 'character' | 'actor' | 'arcana' | 'enemy';
      locale: 'zh' | 'en';
    }) => string;

    expect(
      historyEntityName({
        names: { 'zh-CN': '试用演员', 'en-US': 'Trial Actor' },
        rawText: '试用演员',
        id: 'trial.internal.1',
        orderedIds: ['trial.internal.1'],
        kind: 'actor',
        locale: 'en'
      })
    ).toBe('Trial Actor');
    expect(
      historyEntityName({
        rawText: '旧中文角色',
        id: '10000001',
        orderedIds: ['10000001', '10000002'],
        kind: 'character',
        locale: 'en'
      })
    ).toBe('Saved character 1');
    expect(
      historyEntityName({
        rawText: '旧中文秘法',
        id: 'arcana.internal',
        orderedIds: ['arcana.other', 'arcana.internal'],
        kind: 'arcana',
        locale: 'en'
      })
    ).toBe('Saved Arcana 2');
    expect(
      historyEntityName({
        rawText: '旧中文敌人',
        id: 'enemy.internal',
        orderedIds: ['enemy.internal'],
        kind: 'enemy',
        locale: 'en'
      })
    ).toBe('Saved enemy 1');
    expect(
      [
        historyEntityName({
          rawText: '旧中文演员',
          id: 'actor.internal',
          orderedIds: ['actor.internal'],
          kind: 'actor',
          locale: 'en'
        }),
        historyEntityName({
          rawText: '旧中文敌人',
          id: 'enemy.internal',
          orderedIds: ['enemy.internal'],
          kind: 'enemy',
          locale: 'en'
        })
      ].join(' ')
    ).not.toMatch(/[\u3400-\u9fff]|internal/u);
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
    expect(groupChallengeHistory([entry])[0]?.title).toBe('深境螺旋 · 2026-07-01 — 2026-07-15');
    expect(groupChallengeHistory([entry], 'en')[0]?.title).toBe(
      'Spiral Abyss · 2026-07-01 — 2026-07-15'
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

  it('keeps English group and card chrome localized without exposing mode slugs', () => {
    const entries = [theaterEntry(), abyssEntry(), stygianEntry()];
    const visible = [
      ...entries.map((entry) => historyCardTitle(entry, 'en')),
      ...groupChallengeHistory(entries, 'en').map((group) => group.title)
    ].join(' ');
    expect(visible).toContain('Spiral Abyss');
    expect(visible).toContain('Stygian Onslaught');
    expect(visible).toContain('Imaginarium Theater');
    expect(visible).not.toMatch(/spiral-abyss|stygian-onslaught|imaginarium-theater/);
    expect(visible).not.toMatch(/[\u3400-\u9fff]/u);
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
    abyss.teamRisks = [
      {
        half: 'first',
        code: 'energy-window-tight',
        severity: 'soft',
        narrative: {
          'zh-CN': '上半充能窗口较紧。',
          'en-US': 'The first-half energy window is tight.'
        }
      }
    ];
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
    theater.arcanaSnapshots = [
      {
        id: 'arcana:1',
        nameRef: 'arcana.name.1',
        names: { 'zh-CN': '剧诗秘法', 'en-US': 'Theater Arcana' }
      }
    ];
    theater.encounterSnapshots = [
      {
        act: 1,
        encounterId: 'encounter:1',
        enemyRefs: [
          {
            id: 'enemy:1',
            names: { 'zh-CN': '剧诗敌人', 'en-US': 'Theater Enemy' }
          }
        ]
      }
    ];
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
      assumptions: ['深渊前提'],
      teamRisks: [
        expect.objectContaining({
          half: 'first',
          narrative: {
            'zh-CN': '上半充能窗口较紧。',
            'en-US': 'The first-half energy window is tight.'
          }
        })
      ]
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
      arcanaSnapshots: [
        expect.objectContaining({
          id: 'arcana:1',
          names: { 'zh-CN': '剧诗秘法', 'en-US': 'Theater Arcana' }
        })
      ],
      encounterSnapshots: [
        expect.objectContaining({
          act: 1,
          enemyRefs: [
            expect.objectContaining({
              id: 'enemy:1',
              names: { 'zh-CN': '剧诗敌人', 'en-US': 'Theater Enemy' }
            })
          ]
        })
      ],
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
