import type { HistoryRerunIntent } from '../History/history-presentation';

type AbyssIntent = Extract<HistoryRerunIntent, { mode: 'spiral-abyss' }>;
type StygianIntent = Extract<HistoryRerunIntent, { mode: 'stygian-onslaught' }>;
type TheaterIntent = Extract<HistoryRerunIntent, { mode: 'imaginarium-theater' }>;

interface BlockedRerun {
  status: 'blocked';
  reason: 'uid-mismatch';
}

interface RerunAdjustment {
  status: 'ready' | 'adjusted';
  removedCharacterCount: number;
  targetUnavailable: boolean;
  scenarioChanged: boolean;
  dataVersionChanged: boolean;
}

interface CurrentRerunSource {
  scenarioId: string;
  dataVersion: string;
}

export function historySourceChangedNotice(
  change: Pick<RerunAdjustment, 'scenarioChanged' | 'dataVersionChanged'>,
  locale: 'zh' | 'en'
): string {
  if (!change.scenarioChanged && !change.dataVersionChanged) return '';
  return locale === 'en'
    ? 'Challenge data has changed. Saved choices were checked against the current data; '
    : '当前挑战资料已更新，已按新资料重新核对保存选项；';
}

export function prepareAbyssRerun(
  intent: AbyssIntent,
  activeUid: string,
  availableFloors: number[],
  ownedCharacterIds: string[],
  currentSource?: CurrentRerunSource
):
  | BlockedRerun
  | (RerunAdjustment &
      Pick<
        AbyssIntent,
        'floor' | 'chamber' | 'preferences' | 'lockedCharacterIds' | 'excludedCharacterIds'
      >) {
  if (intent.uid !== activeUid) return { status: 'blocked', reason: 'uid-mismatch' };
  const targetUnavailable = !availableFloors.includes(intent.floor);
  const owned = new Set(ownedCharacterIds);
  const lockedCharacterIds = intent.lockedCharacterIds.filter((id) => owned.has(id));
  const excludedCharacterIds = intent.excludedCharacterIds.filter((id) => owned.has(id));
  const removedCharacterCount =
    intent.lockedCharacterIds.length +
    intent.excludedCharacterIds.length -
    lockedCharacterIds.length -
    excludedCharacterIds.length;
  return {
    status: targetUnavailable || removedCharacterCount > 0 ? 'adjusted' : 'ready',
    ...(targetUnavailable ? { floor: undefined, chamber: undefined } : { floor: intent.floor, chamber: intent.chamber }),
    preferences: structuredClone(intent.preferences),
    lockedCharacterIds,
    excludedCharacterIds,
    removedCharacterCount,
    targetUnavailable,
    ...sourceChange(intent, currentSource)
  } as RerunAdjustment &
    Pick<
      AbyssIntent,
      'floor' | 'chamber' | 'preferences' | 'lockedCharacterIds' | 'excludedCharacterIds'
    >;
}

export function prepareStygianRerun(
  intent: StygianIntent,
  activeUid: string,
  availableDifficultyIds: string[],
  ownedCharacterIds: string[],
  currentSource?: CurrentRerunSource
):
  | BlockedRerun
  | (RerunAdjustment &
      Pick<
        StygianIntent,
        'difficultyId' | 'target' | 'preferences' | 'lockedCharacterIds' | 'excludedCharacterIds'
      >) {
  if (intent.uid !== activeUid) return { status: 'blocked', reason: 'uid-mismatch' };
  const targetUnavailable = !availableDifficultyIds.includes(intent.difficultyId);
  const owned = new Set(ownedCharacterIds);
  const lockedCharacterIds = intent.lockedCharacterIds.filter((id) => owned.has(id));
  const excludedCharacterIds = intent.excludedCharacterIds.filter((id) => owned.has(id));
  const removedCharacterCount =
    intent.lockedCharacterIds.length +
    intent.excludedCharacterIds.length -
    lockedCharacterIds.length -
    excludedCharacterIds.length;
  return {
    status: targetUnavailable || removedCharacterCount > 0 ? 'adjusted' : 'ready',
    difficultyId: targetUnavailable ? '' : intent.difficultyId,
    target: intent.target,
    preferences: structuredClone(intent.preferences),
    lockedCharacterIds,
    excludedCharacterIds,
    removedCharacterCount,
    targetUnavailable,
    ...sourceChange(intent, currentSource)
  };
}

export function prepareTheaterRerun(
  intent: TheaterIntent,
  activeUid: string,
  availableActs: number[],
  ownedCharacterIds: string[],
  currentSource?: CurrentRerunSource
):
  | BlockedRerun
  | (RerunAdjustment &
      Pick<
        TheaterIntent,
        | 'act'
        | 'target'
        | 'preferences'
        | 'selectedCharacterIds'
        | 'excludedCharacterIds'
        | 'selectedOpeningCharacterIds'
        | 'selectedTrialCharacterIds'
        | 'selectedSpecialGuestCharacterIds'
        | 'selectedSupportCharacterIds'
      >) {
  if (intent.uid !== activeUid) return { status: 'blocked', reason: 'uid-mismatch' };
  const targetUnavailable = intent.act !== undefined && !availableActs.includes(intent.act);
  const owned = new Set(ownedCharacterIds);
  const selectedCharacterIds = intent.selectedCharacterIds.filter((id) => owned.has(id));
  const excludedCharacterIds = intent.excludedCharacterIds.filter((id) => owned.has(id));
  const removedCharacterCount =
    intent.selectedCharacterIds.length +
    intent.excludedCharacterIds.length -
    selectedCharacterIds.length -
    excludedCharacterIds.length;
  return {
    status: targetUnavailable || removedCharacterCount > 0 ? 'adjusted' : 'ready',
    ...(targetUnavailable ? {} : { act: intent.act }),
    target: intent.target,
    preferences: structuredClone(intent.preferences),
    selectedCharacterIds,
    excludedCharacterIds,
    selectedOpeningCharacterIds: [...intent.selectedOpeningCharacterIds],
    selectedTrialCharacterIds: [...intent.selectedTrialCharacterIds],
    selectedSpecialGuestCharacterIds: [...intent.selectedSpecialGuestCharacterIds],
    selectedSupportCharacterIds: [...intent.selectedSupportCharacterIds],
    removedCharacterCount,
    targetUnavailable,
    ...sourceChange(intent, currentSource)
  };
}

function sourceChange(
  intent: HistoryRerunIntent,
  currentSource: CurrentRerunSource | undefined
): Pick<RerunAdjustment, 'scenarioChanged' | 'dataVersionChanged'> {
  return {
    scenarioChanged:
      currentSource !== undefined && currentSource.scenarioId !== intent.previousScenarioId,
    dataVersionChanged:
      currentSource !== undefined && currentSource.dataVersion !== intent.previousDataVersion
  };
}
