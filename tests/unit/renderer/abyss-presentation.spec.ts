import { describe, expect, it } from 'vitest';

import {
  characterElementLabel,
  cycleCharacterIntervention,
  enemyDisplayName,
  mechanicLabels,
  progressStepLabel
} from '../../../src/renderer/pages/Advisor/abyss-presentation.js';
import { abyssScenario } from '../services/abyss-test-fixtures.js';

describe('abyss presentation', () => {
  it('reads structured bilingual semantics only from the exact stable target key', async () => {
    const presentation =
      (await import('../../../src/renderer/pages/Advisor/abyss-presentation.js')) as Record<
        string,
        unknown
      >;
    expect(presentation.narrativeTargetPresentation).toBeTypeOf('function');
    const narrativeTargetPresentation = presentation.narrativeTargetPresentation as (
      narrative: {
        sections: Array<{
          targetKey: string;
          title: { 'zh-CN': string; 'en-US': string };
          body: { 'zh-CN': string; 'en-US': string };
        }>;
      },
      targetKey: string,
      locale: 'zh' | 'en'
    ) => { status: string; title: string; body: string };
    const narrative = {
      sections: [
        {
          targetKey: 'abyss-team:first',
          title: { 'zh-CN': '上半队伍', 'en-US': 'First-half team' },
          body: {
            'zh-CN': '先完成辅助布置再进入主要输出。',
            'en-US': 'Set up support effects before committing to the main damage window.'
          }
        },
        {
          targetKey: 'abyss-team:first-extra',
          title: { 'zh-CN': '错误目标', 'en-US': 'Wrong target' },
          body: { 'zh-CN': '不能命中。', 'en-US': 'Must not match.' }
        }
      ]
    };

    expect(narrativeTargetPresentation(narrative, 'abyss-team:first', 'en')).toEqual({
      status: 'localized',
      title: 'First-half team',
      body: 'Set up support effects before committing to the main damage window.'
    });
    expect(narrativeTargetPresentation(narrative, 'abyss-team:second', 'en')).toEqual({
      status: 'unavailable',
      title: 'Guidance unavailable',
      body: 'No localized guidance was saved for this target.'
    });
  });

  it('does not turn foreign-language saved prose into a generic semantic placeholder', async () => {
    const presentation =
      (await import('../../../src/renderer/pages/Advisor/abyss-presentation.js')) as Record<
        string,
        unknown
      >;
    expect(presentation.localizedPlanText).toBeTypeOf('function');
    const localizedPlanText = presentation.localizedPlanText as (
      value: string,
      locale: 'zh' | 'en'
    ) => string | null;

    expect(localizedPlanText('先布置辅助技能。', 'en')).toBeNull();
    expect(localizedPlanText('Set up support skills first.', 'en')).toBe(
      'Set up support skills first.'
    );
    expect(localizedPlanText('先布置辅助技能。', 'zh')).toBe('先布置辅助技能。');
  });

  it('uses stable neutral character labels when a profile name has no English snapshot', async () => {
    const presentation =
      (await import('../../../src/renderer/pages/Advisor/abyss-presentation.js')) as Record<
        string,
        unknown
      >;
    expect(presentation.localizedProfileName).toBeTypeOf('function');
    const localizedProfileName = presentation.localizedProfileName as (
      name: string,
      id: string,
      orderedIds: string[],
      locale: 'zh' | 'en'
    ) => string;

    expect(localizedProfileName('中文角色', '1002', ['1001', '1002'], 'en')).toBe('Character 2');
    expect(localizedProfileName('Raiden Shogun', '1002', ['1001', '1002'], 'en')).toBe(
      'Raiden Shogun'
    );
    expect(localizedProfileName('中文角色', '1002', ['1001', '1002'], 'zh')).toBe('中文角色');
  });

  it('uses a localized Chinese enemy name and never falls back to the English slug', () => {
    const enemy = abyssScenario().floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!;
    expect(enemyDisplayName(enemy)).toBe('训练水兽');
    expect(enemyDisplayName(enemy, 'en')).toBe('Training Hydra');
    expect(
      enemyDisplayName({ ...enemy, enemy: { id: 'abyss-mage', names: { en: 'Abyss Mage' } } })
    ).toBe('未命名敌人');
    expect(
      enemyDisplayName(
        { ...enemy, enemy: { id: 'abyss-mage', names: { 'zh-CN': '深渊法师' } } },
        'en'
      )
    ).toBe('Unnamed enemy');
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
    expect(
      mechanicLabels({
        shields: [],
        resistances: [
          { damageType: 'physical', percent: 30 },
          { damageType: 'internal-slug', percent: 10 }
        ],
        immunities: ['hydro', 'internal-immunity'],
        tags: []
      }).join(' ')
    ).toBe('物理抗性 30% 其他伤害抗性 10% 免疫：水元素伤害 免疫：未本地化机制');
    expect(
      mechanicLabels(
        {
          shields: [{ element: 'hydro', strength: 12 }],
          resistances: [{ damageType: 'physical', percent: 30 }],
          immunities: ['pyro'],
          tags: ['requires-capability:grouping', '多目标']
        },
        'en'
      )
    ).toEqual([
      'Hydro shield · strength 12',
      'Physical RES 30%',
      'Immune: Pyro damage',
      'Requires grouping'
    ]);
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
    expect(progressStepLabel('reading-roster', 'en')).toBe('Reading roster');
    expect(characterElementLabel('hydro', 'en')).toBe('Hydro');
  });
});
