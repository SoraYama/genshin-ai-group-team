import { describe, expect, it } from 'vitest';

import {
  cycleCharacterIntervention,
  enemyDisplayName,
  mechanicLabels,
  progressStepLabel
} from '../../../src/renderer/pages/Advisor/abyss-presentation.js';
import { abyssScenario } from '../services/abyss-test-fixtures.js';

describe('abyss presentation', () => {
  it('uses a localized Chinese enemy name and never falls back to the English slug', () => {
    const enemy = abyssScenario().floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!;
    expect(enemyDisplayName(enemy)).toBe('训练水兽');
    expect(
      enemyDisplayName({ ...enemy, enemy: { id: 'abyss-mage', names: { en: 'Abyss Mage' } } })
    ).toBe('未命名敌人');
  });

  it('formats only known shield, resistance, immunity, and mechanism facts in player language', () => {
    const enemy = abyssScenario().floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!;
    const labels = mechanicLabels(enemy.mechanics);
    expect(labels).toEqual(['水元素护盾 · 强度 12', '水抗性 70%', '多目标', '需要破水盾']);
    expect(labels.join(' ')).not.toMatch(/hydro|development|training/i);
    expect(
      mechanicLabels({
        shields: [],
        resistances: [],
        immunities: [],
        tags: ['development-sample', '多目标']
      })
    ).toEqual(['多目标']);
  });

  it('cycles keyboard-friendly intervention state without conflicting lock and exclusion', () => {
    expect(cycleCharacterIntervention('neutral')).toBe('locked');
    expect(cycleCharacterIntervention('locked')).toBe('excluded');
    expect(cycleCharacterIntervention('excluded')).toBe('neutral');
  });

  it('maps internal progress steps to player-semantic Chinese copy', () => {
    expect(progressStepLabel('reading-roster')).toBe('读取角色');
    expect(progressStepLabel('analyzing-rules')).toBe('分析挑战规则');
    expect(progressStepLabel('generating-teams')).toBe('生成双队');
    expect(progressStepLabel('checking-conflicts')).toBe('检查冲突');
    expect(progressStepLabel('writing-tactics')).toBe('整理打法');
  });
});
