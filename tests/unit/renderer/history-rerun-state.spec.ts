import { describe, expect, it } from 'vitest';
import {
  consumeHistoryRerun,
  historyRerunAfterNavigation,
  historyRerunForActiveUid
} from '../../../src/renderer/pages/Advisor/history-rerun-state.js';
import type { HistoryRerunIntent } from '../../../src/renderer/pages/History/history-presentation.js';

const intent: HistoryRerunIntent = {
  historyId: 'history-1',
  mode: 'spiral-abyss',
  uid: '123456789',
  previousScenarioId: 'saved-cycle',
  previousDataVersion: 'saved-data',
  createdAt: '2026-07-01T00:00:00.000Z',
  floor: 12,
  preferences: {
    comfort: 'off',
    survival: 'off',
    lowInvestment: 'off',
    noBuildChange: false
  },
  lockedCharacterIds: [],
  excludedCharacterIds: []
};

describe('history rerun one-shot state', () => {
  it('clears a matching intent after the workspace consumes it and preserves newer work', () => {
    expect(consumeHistoryRerun(intent, intent.historyId)).toBeNull();
    expect(consumeHistoryRerun(intent, 'another-history')).toBe(intent);
  });

  it('clears the intent when leaving Advisor so re-entry cannot apply stale choices', () => {
    expect(historyRerunAfterNavigation(intent, 'history')).toBeNull();
    expect(historyRerunAfterNavigation(intent, 'advisor')).toBe(intent);
  });

  it('clears the intent when the active UID changes', () => {
    expect(historyRerunForActiveUid(intent, intent.uid)).toBe(intent);
    expect(historyRerunForActiveUid(intent, '987654321')).toBeNull();
    expect(historyRerunForActiveUid(intent, undefined)).toBeNull();
  });
});
