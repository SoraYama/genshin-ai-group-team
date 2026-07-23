import { describe, expect, it } from 'vitest';

import { localizeStygianModifier } from '../../../src/shared/stygian-modifier-localization.js';
import { stygianOnslaughtScenarioSchema } from '../../../src/shared/scenario-v2.js';
import { stygianScenario } from '../services/stygian-test-fixtures.js';

describe('localizeStygianModifier', () => {
  it('preserves natural Chinese, maps known keys, and hides arbitrary technical text', () => {
    expect(localizeStygianModifier({ id: 'custom-cn', description: '首领进入强化状态。' })).toBe(
      '首领进入强化状态。'
    );
    expect(
      localizeStygianModifier({ id: 'energy-pressure', description: 'Energy pressure increased' })
    ).toBe('能量回复压力上升。');
    expect(localizeStygianModifier({ id: 'time-window', description: 'short-timer' })).toBe(
      '限时窗口更紧。'
    );
    for (const modifier of [
      { id: 'unknown-english', description: 'Enemies gain increased damage resistance' },
      { id: 'unknown-slug', description: 'phase_damage_up' },
      { id: 'difficultyId', description: 'difficultyId' },
      { id: 'mixed', description: '能量 pressure rises' },
      { id: 'tool', description: '调用 query_stygian_phase 后强化。' }
    ]) {
      expect(localizeStygianModifier(modifier)).toBe('挑战修正暂无中文说明');
    }
  });

  it('keeps signed raw scenario modifiers legal while localizing at the player boundary', () => {
    const scenario = stygianScenario();
    scenario.difficulties[0]!.modifiers = [
      { id: 'unknown-raw', description: 'Enemies gain increased resistance' }
    ];
    const parsed = stygianOnslaughtScenarioSchema.parse(scenario);

    expect(parsed.difficulties[0]!.modifiers[0]!.description).toBe(
      'Enemies gain increased resistance'
    );
    expect(localizeStygianModifier(parsed.difficulties[0]!.modifiers[0]!)).toBe(
      '挑战修正暂无中文说明'
    );
  });
});
