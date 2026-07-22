import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { makeScenario } from '../scenario-publication/fixtures.js';
import { AbyssScenarioService } from '../../../src/main/services/abyss-scenario-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('AbyssScenarioService', () => {
  it('returns typed unavailable when no verified production source is configured', async () => {
    const service = new AbyssScenarioService({
      enableDevelopmentScenarios: false,
      developmentFixturePath: '/unused.json',
      now: () => new Date('2026-07-23T00:00:00.000Z')
    });

    await expect(service.getView()).resolves.toEqual({
      status: 'unavailable',
      reason: 'production-source-not-configured',
      message: '暂时没有可验证的深境螺旋资料。'
    });
  });

  it('never opens the development fixture unless the explicit flag is enabled', async () => {
    let reads = 0;
    const service = new AbyssScenarioService({
      enableDevelopmentScenarios: false,
      developmentFixturePath: '/must-not-read.json',
      readFile: async () => {
        reads += 1;
        return '{}';
      }
    });

    await service.getView();
    expect(reads).toBe(0);
  });

  it('strictly parses the dedicated wrapper and marks it as a non-current sample', async () => {
    const fixturePath = path.resolve('resources/scenarios/v2/development-source/spiral-abyss.json');
    const service = new AbyssScenarioService({
      enableDevelopmentScenarios: true,
      developmentFixturePath: fixturePath,
      now: () => new Date('2026-07-23T00:00:00.000Z')
    });

    const view = await service.getView();
    expect(view).toMatchObject({
      status: 'ready',
      trust: 'development-sample',
      notCurrent: true,
      freshness: 'stale'
    });
    if (view.status !== 'ready') throw new Error('Expected ready sample');
    expect(view.scenario.floors[0]?.chambers[0]?.firstHalf.waves[0]?.enemies[0]).toMatchObject({
      enemy: { names: { 'zh-CN': '训练灵体' } },
      count: 2,
      level: 100,
      mechanics: { tags: ['development-sample'] }
    });
  });

  it('returns typed unavailable for schema drift instead of accepting a loose sample', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gta-abyss-fixture-'));
    temporaryDirectories.push(directory);
    const source = await readFile(
      path.resolve('resources/scenarios/v2/development-source/spiral-abyss.json'),
      'utf8'
    );
    const parsed = JSON.parse(source) as Record<string, unknown>;
    parsed['unexpectedProductionClaim'] = true;
    const fixturePath = path.join(directory, 'spiral-abyss.json');
    await writeFile(fixturePath, JSON.stringify(parsed));

    const service = new AbyssScenarioService({
      enableDevelopmentScenarios: true,
      developmentFixturePath: fixturePath
    });

    await expect(service.getView()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'development-sample-invalid'
    });
  });

  it('consumes an already-verified production publication snapshot without legacy fallback', async () => {
    const scenario = makeScenario('spiral-abyss', 'production', '2026.07.1');
    if (scenario.mode !== 'spiral-abyss') throw new Error('Expected abyss fixture');
    const service = new AbyssScenarioService({
      enableDevelopmentScenarios: false,
      developmentFixturePath: '/unused.json',
      productionSnapshot: async () => ({
        status: 'last-known-good',
        trustedUse: 'production',
        freshness: 'fresh',
        checkedAt: '2026-01-15T00:00:00.000Z',
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
      notCurrent: false,
      scenario: { id: scenario.id, meta: { dataVersion: '2026.07.1' } }
    });
  });
});
