import { describe, expect, it } from 'vitest';

import { StygianScenarioService } from '../../../src/main/services/stygian-scenario-service.js';
import { stygianScenario } from './stygian-test-fixtures.js';

describe('StygianScenarioService', () => {
  it('strictly reads the three-phase six-difficulty development wrapper only behind its flag', async () => {
    const service = new StygianScenarioService({
      enableDevelopmentScenarios: true,
      developmentFixturePath: 'resources/scenarios/v2/development-source/stygian-onslaught.json',
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
    expect(view.scenario.difficulties).toHaveLength(6);
    expect(view.scenario.phases).toHaveLength(3);
  });

  it.each([
    ['fresh', false, true],
    ['expiring', false, true],
    ['stale', true, false],
    ['unknown', true, false]
  ] as const)(
    'maps production %s freshness to safe recommendation use',
    async (freshness, notCurrent, usable) => {
      const scenario = stygianScenario();
      const service = new StygianScenarioService({
        enableDevelopmentScenarios: false,
        developmentFixturePath: '/must-not-read.json',
        productionSnapshot: async () => ({
          status: 'last-known-good',
          trustedUse: 'production',
          freshness,
          checkedAt: '2026-07-23T00:00:00.000Z',
          publication: {
            payload: scenario,
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

  it('does not read development data when production is absent and the flag is disabled', async () => {
    let reads = 0;
    const service = new StygianScenarioService({
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
