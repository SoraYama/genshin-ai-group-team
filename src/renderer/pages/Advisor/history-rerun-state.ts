import type { HistoryRerunIntent } from '../History/history-presentation';

type RerunNavigationView = 'roster' | 'advisor' | 'history' | 'onboarding' | 'settings';

export function consumeHistoryRerun(
  intent: HistoryRerunIntent | null,
  consumedHistoryId: string
): HistoryRerunIntent | null {
  return intent?.historyId === consumedHistoryId ? null : intent;
}

export function historyRerunAfterNavigation(
  intent: HistoryRerunIntent | null,
  nextView: RerunNavigationView
): HistoryRerunIntent | null {
  return nextView === 'advisor' ? intent : null;
}

export function historyRerunForActiveUid(
  intent: HistoryRerunIntent | null,
  activeUid: string | undefined
): HistoryRerunIntent | null {
  return intent && intent.uid === activeUid ? intent : null;
}
