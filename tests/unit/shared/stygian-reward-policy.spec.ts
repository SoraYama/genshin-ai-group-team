import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STYGIAN_TARGET_POLICY,
  clampDifficultyForStygianTarget,
  isStygianTargetDifficultyCompatible,
  lowerStygianDifficultyWithinTarget,
  minimumOrderForStygianTarget
} from '../../../src/shared/stygian-reward-policy.js';

const difficulties = Array.from({ length: 6 }, (_, index) => ({
  id: `difficulty-${index + 1}`,
  order: index + 1
}));

describe('Stygian application target policy', () => {
  it('defines the complete 1/5/6 application mapping without claiming official reward unlocks', () => {
    expect(DEFAULT_STYGIAN_TARGET_POLICY).toEqual({
      source: 'app-default',
      version: 'app-target-orders-v1',
      minimumOrderByTarget: {
        primogems: 1,
        'high-reward': 5,
        'dire-challenge': 6
      }
    });
    for (const [target, minimum] of [
      ['primogems', 1],
      ['high-reward', 5],
      ['dire-challenge', 6]
    ] as const) {
      for (let order = 1; order <= 6; order += 1) {
        expect(isStygianTargetDifficultyCompatible(target, order)).toBe(order >= minimum);
      }
    }
  });

  it('auto-raises the selected difficulty and only suggests a strictly lower compatible tier', () => {
    expect(clampDifficultyForStygianTarget('high-reward', 'difficulty-2', difficulties)).toBe(
      'difficulty-5'
    );
    expect(clampDifficultyForStygianTarget('dire-challenge', 'difficulty-5', difficulties)).toBe(
      'difficulty-6'
    );
    expect(clampDifficultyForStygianTarget('primogems', 'difficulty-4', difficulties)).toBe(
      'difficulty-4'
    );
    expect(lowerStygianDifficultyWithinTarget('high-reward', 6, difficulties)).toBe('difficulty-5');
    expect(lowerStygianDifficultyWithinTarget('high-reward', 5, difficulties)).toBeUndefined();
    expect(lowerStygianDifficultyWithinTarget('dire-challenge', 6, difficulties)).toBeUndefined();
  });

  it('lets a versioned signed-scenario policy override the app default after schema migration', () => {
    const scenarioPolicy = {
      source: 'scenario' as const,
      version: 'scenario-reward-thresholds-v2',
      minimumOrderByTarget: {
        primogems: 2,
        'high-reward': 4,
        'dire-challenge': 6
      }
    };
    expect(minimumOrderForStygianTarget('high-reward', scenarioPolicy)).toBe(4);
    expect(isStygianTargetDifficultyCompatible('high-reward', 4, scenarioPolicy)).toBe(true);
  });
});
