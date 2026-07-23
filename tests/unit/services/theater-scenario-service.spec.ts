import { describe, expect, it } from 'vitest';

import { TheaterScenarioService } from '../../../src/main/services/theater-scenario-service.js';
import { theaterScenario } from './theater-test-fixtures.js';

describe('TheaterScenarioService', () => {
  it('reads the strict fictional development wrapper only behind its flag', async () => {
    const service = new TheaterScenarioService({
      enableDevelopmentScenarios: true,
      developmentFixturePath: 'resources/scenarios/v2/development-source/imaginarium-theater.json',
      now: () => new Date('2026-07-23T00:00:00.000Z')
    });
    const view = await service.getView();
    expect(view).toMatchObject({
      status: 'ready',
      trust: 'development-sample',
      notCurrent: true,
      freshness: 'stale'
    });
    if (view.status !== 'ready') throw new Error('Expected development view');
    expect(view.scenario.eligibility).toEqual({
      elements: ['anemo', 'geo'],
      minimumLevel: 70,
      requiredHeadcount: 8
    });
    expect(JSON.stringify(view.scenario.pools)).toContain('development.');
  });

  it.each([
    ['fresh', false, true],
    ['expiring', false, true],
    ['stale', true, false],
    ['unknown', true, false]
  ] as const)(
    'maps production %s freshness to safe recommendation use',
    async (freshness, notCurrent, usable) => {
      const service = new TheaterScenarioService({
        enableDevelopmentScenarios: false,
        developmentFixturePath: '/must-not-read.json',
        productionSnapshot: async () => ({
          status: 'last-known-good',
          trustedUse: 'production',
          freshness,
          checkedAt: '2026-07-23T00:00:00.000Z',
          publication: {
            payload: theaterScenario(),
            integrity: {
              scope: 'payload',
              serialization: 'RFC8785-JCS',
              hash: {
                algorithm: 'sha256',
                encoding: 'base64',
                value: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
              },
              signature: {
                algorithm: 'ed25519',
                keyId: 'test-key',
                encoding: 'base64',
                value:
                  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
              }
            }
          },
          refreshErrorCode: 'network-unavailable'
        })
      });
      await expect(service.getView()).resolves.toMatchObject({
        status: 'ready',
        trust: 'production',
        snapshotStatus: 'last-known-good',
        freshness,
        notCurrent,
        usableForRecommendation: usable,
        refreshWarning: '正在使用最近一次已确认的资料；本次刷新失败。'
      });
    }
  );

  it('never reads development data when the flag is disabled', async () => {
    let reads = 0;
    const service = new TheaterScenarioService({
      enableDevelopmentScenarios: false,
      developmentFixturePath: '/must-not-read.json',
      readFile: async () => {
        reads += 1;
        return '{}';
      }
    });
    await expect(service.getView()).resolves.toMatchObject({ status: 'unavailable' });
    expect(reads).toBe(0);
  });
});
