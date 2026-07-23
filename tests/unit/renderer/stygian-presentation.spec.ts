import { describe, expect, it } from 'vitest';

import {
  cycleStygianIntervention,
  difficultyDisplayName,
  difficultyModifierLabels,
  difficultySuggestionLabel,
  progressStepLabel,
  reuseRuleSummary,
  rewardTargetLabel,
  scenarioVersionLabel,
  stygianBossDisplayName,
  stygianMechanicLabels
} from '../../../src/renderer/pages/Advisor/stygian-presentation.js';
import { stygianScenario } from '../services/stygian-test-fixtures.js';

describe('Stygian presentation', () => {
  it('renders localized difficulty, boss, goal, reuse, and progress labels without slugs', () => {
    const scenario = stygianScenario();
    expect(difficultyDisplayName(scenario.difficulties[5]!)).toBe('难度 6');
    expect(difficultySuggestionLabel(scenario.difficulties, 'difficulty-4')).toBe('改选难度 4');
    expect(
      scenarioVersionLabel({
        status: 'ready',
        trust: 'production',
        snapshotStatus: 'ready',
        notCurrent: false,
        usableForRecommendation: true,
        freshness: 'fresh',
        checkedAt: '2026-07-23T00:00:00.000Z',
        scenario
      })
    ).toBe('本期正式资料');
    expect(stygianBossDisplayName(scenario.phases[0]!.boss)).toBe('试炼首领1');
    expect(rewardTargetLabel('primogems')).toBe('拿原石即可');
    expect(rewardTargetLabel('high-reward')).toBe('冲高难奖励');
    expect(rewardTargetLabel('dire-challenge')).toBe('挑战极限难度');
    expect(reuseRuleSummary({ rule: 'forbidden', notes: [] })).toContain('不可复用');
    expect(progressStepLabel('allocating-parties')).toBe('分配三队');
    expect(difficultyDisplayName(scenario.difficulties[5]!, 'en')).toBe('Difficulty 6');
    expect(stygianBossDisplayName(scenario.phases[0]!.boss, 'en')).toBe('Trial Boss 1');
    expect(rewardTargetLabel('high-reward', 'en')).toBe('Target high-tier rewards');
    expect(reuseRuleSummary({ rule: 'forbidden', notes: [] }, 'en')).toBe(
      'Characters cannot be reused across phases; 12 unique characters are required.'
    );
    expect(progressStepLabel('allocating-parties', 'en')).toBe('Allocating three teams');
    expect(
      [
        difficultyDisplayName(scenario.difficulties[5]!),
        stygianBossDisplayName(scenario.phases[0]!.boss),
        reuseRuleSummary(scenario.crossPartyReusePolicy)
      ].join(' ')
    ).not.toMatch(/difficulty-|boss-|forbidden|stygian/i);
  });

  it('shows only localized mechanics and does not invent absent time or energy targets', () => {
    const phase = stygianScenario().phases[0]!;
    phase.boss.mechanics.tags = [
      'requires-capability:bow',
      'requires-capability:teleport',
      'internal-tag',
      '需要快速破盾'
    ];
    expect(stygianMechanicLabels(phase)).toEqual([
      '阶段 1 机制。',
      '首领 1 修正。',
      '硬机制要求：弓角色',
      '硬机制要求：未识别要求（无法自动确认）',
      '需要快速破盾'
    ]);
    phase.phaseModifiers = [];
    phase.bossModifiers = [];
    phase.boss.mechanics.tags = [];
    expect(stygianMechanicLabels(phase)).toEqual([]);
  });

  it('cycles the accessible neutral, locked, and excluded intervention states', () => {
    expect(cycleStygianIntervention('neutral')).toBe('locked');
    expect(cycleStygianIntervention('locked')).toBe('excluded');
    expect(cycleStygianIntervention('excluded')).toBe('neutral');
  });

  it('never exposes raw phase or boss modifier sentences and internal keys', () => {
    const phase = stygianScenario().phases[0]!;
    phase.phaseModifiers = [{ id: 'phase_damage_up', description: 'phase_damage_up' }];
    phase.bossModifiers = [
      { id: 'boss-internal-key', description: 'Boss gains increased resistance' }
    ];

    expect(stygianMechanicLabels(phase)).toEqual(['挑战修正暂无中文说明']);
  });

  it('localizes difficulty modifiers through the same UI presentation boundary', () => {
    const difficulty = stygianScenario().difficulties[5]!;
    difficulty.modifiers = [
      { id: 'energy-pressure', description: 'Energy pressure increased' },
      { id: 'unknown-difficulty', description: 'enemy_resistance_up' }
    ];

    expect(difficultyModifierLabels(difficulty)).toEqual([
      '能量回复压力上升。',
      '挑战修正暂无中文说明'
    ]);
    expect(difficultyModifierLabels(difficulty, 'en')).toEqual([
      'Increased energy pressure.',
      'Modifier details unavailable.'
    ]);
  });

  it('keeps English mechanics free of Chinese fallback terms', () => {
    const phase = stygianScenario().phases[0]!;
    phase.boss.mechanics.shields = [{ element: 'hydro', strength: 4 }];
    phase.boss.mechanics.tags = ['requires-capability:bow', '需要快速破盾'];
    const labels = stygianMechanicLabels(phase, 'en');
    expect(labels).toEqual([
      'Phase 1 mechanic.',
      'Boss 1 modifier.',
      'Hydro shield · strength 4',
      'Required capability: Bow user'
    ]);
    expect(labels.join(' ')).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
