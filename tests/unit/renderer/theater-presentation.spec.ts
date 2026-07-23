import { describe, expect, it } from 'vitest';

import {
  eligibilityReasonLabel,
  elementLabel,
  objectiveLabel,
  pathChoiceLabel,
  poolSourceLabel,
  progressStepLabel,
  scenarioVersionLabel,
  theaterActPresentation,
  theaterEntityName
} from '../../../src/renderer/pages/Advisor/theater-presentation.js';
import { theaterScenario } from '../services/theater-test-fixtures.js';

describe('Theater presentation', () => {
  it('localizes objectives, elements, pool sources, progress and route certainty', () => {
    expect(objectiveLabel('eligibility-check')).toBe('先检查入场资格');
    expect(objectiveLabel('safe-clear')).toBe('稳妥通关');
    expect(objectiveLabel('explore-hard')).toBe('探索高难');
    expect(elementLabel('anemo')).toBe('风');
    expect(poolSourceLabel('special-guest')).toBe('特邀演员');
    expect(progressStepLabel('budgeting-vigor')).toBe('检查活力');
    expect(pathChoiceLabel({ kind: 'random', note: '随机后应变' })).toContain('随机');
    expect(eligibilityReasonLabel(['element', 'level'])).toBe('元素不符合、等级不足');
    expect(objectiveLabel('safe-clear', 'en')).toBe('Prioritize a reliable clear');
    expect(elementLabel('anemo', 'en')).toBe('Anemo');
    expect(poolSourceLabel('special-guest', 'en')).toBe('Special Guest');
    expect(progressStepLabel('budgeting-vigor', 'en')).toBe('Budgeting Vigor');
    expect(pathChoiceLabel({ kind: 'random', note: 'Adapt after reveal' }, 'en')).toBe(
      'Random branch: Adapt after reveal'
    );
    expect(eligibilityReasonLabel(['element', 'level'], 'en')).toBe(
      'Element not eligible, Level too low'
    );
  });

  it('uses localized entity names and player-facing version labels without raw IDs', () => {
    const scenario = theaterScenario();
    expect(theaterEntityName(scenario.pools.trial[0]!)).toBe('试用演员一');
    expect(theaterEntityName(scenario.pools.trial[0]!, 'en')).toBe('Trial One');
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
    expect(
      [
        theaterEntityName(scenario.pools.trial[0]!),
        objectiveLabel('safe-clear'),
        poolSourceLabel('trial')
      ].join(' ')
    ).not.toMatch(/trial\.1|safe-clear|imaginarium|development/i);
  });

  it('presents localized waves, enemies, and mechanics without leaking slugs or internal tags', () => {
    const scenario = theaterScenario();
    const enemy = scenario.acts[0]!.encounters[0]!.waves[0]!.enemies[0]!;
    enemy.enemy = {
      id: 'enemy.internal-training-slug',
      names: { 'zh-CN': '训练灵体', en: 'Internal Training Enemy' }
    };
    enemy.mechanics = {
      shields: [{ element: 'hydro', strength: 2 }],
      resistances: [{ damageType: 'physical', percent: 30 }],
      immunities: ['pyro'],
      tags: ['requires-capability:grouping', 'internal-only-tag']
    };
    scenario.acts[0]!.encounters[0]!.waves[0]!.spawnCondition = '击败上一波后出现';

    const presentation = theaterActPresentation(scenario.acts[0]!);
    expect(presentation.waves[0]).toMatchObject({
      label: '第 1 波',
      spawnCondition: '击败上一波后出现',
      enemies: [
        expect.objectContaining({
          name: '训练灵体',
          count: enemy.count,
          level: enemy.level,
          mechanics: expect.arrayContaining([
            '水元素护盾 · 强度 2',
            '物理抗性 30%',
            '免疫：火元素伤害',
            '需要聚怪能力'
          ])
        })
      ]
    });
    expect(JSON.stringify(presentation)).not.toMatch(
      /enemy\.internal|Internal Training|internal-only|requires-capability/
    );

    const english = theaterActPresentation(scenario.acts[0]!, 'en');
    expect(english.waves[0]).toMatchObject({
      label: 'Wave 1',
      enemies: [
        expect.objectContaining({
          name: 'Internal Training Enemy',
          mechanics: [
            'Hydro shield · strength 2',
            'Physical RES 30%',
            'Immune: Pyro damage',
            'Requires grouping'
          ]
        })
      ]
    });
    expect(JSON.stringify(english)).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
