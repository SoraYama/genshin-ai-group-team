import type {
  AbyssPlanHistoryEntry,
  StygianPlanHistoryEntry,
  TheaterPlanHistoryEntry
} from '../../../shared/domain';

export type ChallengeHistoryEntry =
  | AbyssPlanHistoryEntry
  | StygianPlanHistoryEntry
  | TheaterPlanHistoryEntry;

export type HistoryRerunIntent =
  | ({
      mode: 'spiral-abyss';
      floor: number;
      chamber?: number;
    } & AbyssPlanHistoryEntry['interventions'] &
      RerunIdentity)
  | (StygianPlanHistoryEntry['interventions'] & {
      mode: 'stygian-onslaught';
    } & RerunIdentity)
  | (Omit<
      TheaterPlanHistoryEntry['interventions'],
      'correlationId' | 'uid' | 'scenarioId' | 'dataVersion'
    > & {
      mode: 'imaginarium-theater';
    } & RerunIdentity);

interface RerunIdentity {
  historyId: string;
  uid: string;
  previousScenarioId: string;
  previousDataVersion: string;
  createdAt: string;
}

export interface ChallengeHistoryGroup {
  key: string;
  mode: ChallengeHistoryEntry['mode'];
  scenarioId: string;
  periodLabel: string;
  title: string;
  entries: ChallengeHistoryEntry[];
}

const MODE_LABELS: Record<ChallengeHistoryEntry['mode'], string> = {
  'spiral-abyss': '深境螺旋',
  'stygian-onslaught': '幽境危战',
  'imaginarium-theater': '幻想真境剧诗'
};

export function periodLabelFromScenario(scenarioId: string): string {
  const match = scenarioId.match(/(?:^|[._-])((?:20)\d{2})[._-](0[1-9]|1[0-2])(?:$|[._-])/u);
  return match ? `${match[1]}-${match[2]}` : '记录周期';
}

export function historyCardTitle(entry: ChallengeHistoryEntry): string {
  switch (entry.mode) {
    case 'spiral-abyss':
      return `深境螺旋 ${entry.target.floor} 层${
        entry.target.chamber ? ` · 第 ${entry.target.chamber} 间` : ''
      }`;
    case 'stygian-onslaught':
      return `幽境危战 · ${entry.difficultyName}`;
    case 'imaginarium-theater':
      return `幻想真境剧诗${entry.act ? ` · 第 ${entry.act} 幕` : ' · 全部幕次'}`;
  }
}

export function historySavedVersion(
  entry: ChallengeHistoryEntry,
  locale: 'zh' | 'en'
): { scenario: string; data: string } {
  if (entry.scenarioTrust === 'development-sample') {
    return locale === 'en'
      ? { scenario: 'Practice cycle', data: 'Practice data' }
      : { scenario: '演练周期', data: '演练资料' };
  }
  return { scenario: entry.scenarioId, data: entry.dataVersion };
}

export function groupChallengeHistory(entries: ChallengeHistoryEntry[]): ChallengeHistoryGroup[] {
  const byKey = new Map<string, ChallengeHistoryEntry[]>();
  for (const entry of entries) {
    const key = `${entry.mode}:${entry.scenarioId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return [...byKey.entries()]
    .map(([key, groupEntries]) => {
      const sortedEntries = groupEntries
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const first = sortedEntries[0]!;
      const periodLabel = periodLabelFromScenario(first.scenarioId);
      return {
        key,
        mode: first.mode,
        scenarioId: first.scenarioId,
        periodLabel,
        title: `${MODE_LABELS[first.mode]} · ${periodLabel}`,
        entries: sortedEntries
      };
    })
    .sort((left, right) =>
      (right.entries[0]?.createdAt ?? '').localeCompare(left.entries[0]?.createdAt ?? '')
    );
}

export function createHistoryRerunIntent(entry: ChallengeHistoryEntry): HistoryRerunIntent {
  const identity: RerunIdentity = {
    historyId: entry.id,
    uid: entry.uid,
    previousScenarioId: entry.scenarioId,
    previousDataVersion: entry.dataVersion,
    createdAt: entry.createdAt
  };
  switch (entry.mode) {
    case 'spiral-abyss':
      return {
        ...identity,
        mode: entry.mode,
        floor: entry.target.floor,
        ...(entry.target.chamber ? { chamber: entry.target.chamber } : {}),
        ...structuredClone(entry.interventions)
      };
    case 'stygian-onslaught':
      return {
        ...identity,
        mode: entry.mode,
        ...structuredClone(entry.interventions)
      };
    case 'imaginarium-theater': {
      const interventions = entry.interventions;
      return {
        ...identity,
        mode: entry.mode,
        ...(interventions.act === undefined ? {} : { act: interventions.act }),
        target: interventions.target,
        preferences: structuredClone(interventions.preferences),
        selectedCharacterIds: [...interventions.selectedCharacterIds],
        excludedCharacterIds: [...interventions.excludedCharacterIds],
        selectedOpeningCharacterIds: [...interventions.selectedOpeningCharacterIds],
        selectedTrialCharacterIds: [...interventions.selectedTrialCharacterIds],
        selectedSpecialGuestCharacterIds: [...interventions.selectedSpecialGuestCharacterIds],
        selectedSupportCharacterIds: [...interventions.selectedSupportCharacterIds]
      };
    }
  }
}
