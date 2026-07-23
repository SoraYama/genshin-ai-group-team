import { describe, expect, it } from 'vitest';

import {
  eligibilityReasonLabel,
  elementLabel,
  objectiveLabel,
  pathChoiceLabel,
  poolSourceLabel,
  progressStepLabel,
  scenarioVersionLabel,
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
  });

  it('uses localized entity names and player-facing version labels without raw IDs', () => {
    const scenario = theaterScenario();
    expect(theaterEntityName(scenario.pools.trial[0]!)).toBe('试用演员一');
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
});
