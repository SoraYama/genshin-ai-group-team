import { describe, expect, it } from 'vitest';
import {
  prepareAbyssRerun,
  prepareStygianRerun,
  prepareTheaterRerun
} from '../../../src/renderer/pages/Advisor/history-rerun-prefill.js';
import type { HistoryRerunIntent } from '../../../src/renderer/pages/History/history-presentation.js';

const preferences = {
  comfort: 'high' as const,
  survival: 'off' as const,
  lowInvestment: 'off' as const,
  noBuildChange: false
};

describe('history rerun prefill', () => {
  it('blocks a mismatched UID and never converts the intent into a request', () => {
    const intent: HistoryRerunIntent = {
      historyId: 'history-1',
      mode: 'spiral-abyss',
      uid: '123456789',
      previousScenarioId: 'old-cycle',
      previousDataVersion: 'old-v1',
      createdAt: '2026-07-01T00:00:00.000Z',
      floor: 12,
      preferences,
      lockedCharacterIds: [],
      excludedCharacterIds: []
    };
    expect(prepareAbyssRerun(intent, '987654321', [12], [])).toMatchObject({
      status: 'blocked',
      reason: 'uid-mismatch'
    });
  });

  it('keeps available abyss choices and reports removed characters or targets', () => {
    const intent: HistoryRerunIntent = {
      historyId: 'history-1',
      mode: 'spiral-abyss',
      uid: '123456789',
      previousScenarioId: 'old-cycle',
      previousDataVersion: 'old-v1',
      createdAt: '2026-07-01T00:00:00.000Z',
      floor: 12,
      chamber: 3,
      preferences,
      lockedCharacterIds: ['1', '2'],
      excludedCharacterIds: ['3']
    };
    expect(prepareAbyssRerun(intent, intent.uid, [11], ['1', '3'])).toMatchObject({
      status: 'adjusted',
      floor: undefined,
      lockedCharacterIds: ['1'],
      excludedCharacterIds: ['3'],
      removedCharacterCount: 1,
      targetUnavailable: true
    });
  });

  it('preserves Stygian and Theater choices without a correlation id', () => {
    const stygian: HistoryRerunIntent = {
      historyId: 'history-2',
      mode: 'stygian-onslaught',
      uid: '123456789',
      previousScenarioId: 'old-stygian',
      previousDataVersion: 'old-v1',
      createdAt: '2026-07-01T00:00:00.000Z',
      difficultyId: 'hard',
      target: 'high-reward',
      preferences,
      lockedCharacterIds: ['1'],
      excludedCharacterIds: []
    };
    expect(prepareStygianRerun(stygian, stygian.uid, ['hard'], ['1'])).toMatchObject({
      status: 'ready',
      difficultyId: 'hard',
      target: 'high-reward'
    });

    const theater: HistoryRerunIntent = {
      historyId: 'history-3',
      mode: 'imaginarium-theater',
      uid: '123456789',
      previousScenarioId: 'old-theater',
      previousDataVersion: 'old-v1',
      createdAt: '2026-07-01T00:00:00.000Z',
      act: 8,
      target: 'safe-clear',
      preferences,
      selectedCharacterIds: ['1'],
      excludedCharacterIds: [],
      selectedOpeningCharacterIds: ['opening:a'],
      selectedTrialCharacterIds: [],
      selectedSpecialGuestCharacterIds: [],
      selectedSupportCharacterIds: ['support:a']
    };
    expect(prepareTheaterRerun(theater, theater.uid, [8], ['1'])).toMatchObject({
      status: 'ready',
      act: 8,
      selectedCharacterIds: ['1'],
      selectedOpeningCharacterIds: ['opening:a'],
      selectedSupportCharacterIds: ['support:a']
    });
  });
});
