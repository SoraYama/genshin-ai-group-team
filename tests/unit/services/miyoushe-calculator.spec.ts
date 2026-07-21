import { describe, expect, it, vi } from 'vitest';
import {
  mapCalculatorRoster,
  MiyousheCalculatorClient
} from '../../../src/main/services/miyoushe-calculator.js';

const rawCharacters = [
  {
    id: 10000046,
    name: 'Character A',
    element_attr_id: 1,
    avatar_level: 5,
    level_current: 90,
    icon:
      'https://act-webstatic.mihoyo.com/hk4e/e20200928calculate/item_icon/rev/character-a.png',
    constellation_num: 2,
    fetter_level: 10,
    weapon: {
      id: 11501,
      name: 'Weapon A',
      icon:
        'https://act-webstatic.mihoyo.com/hk4e/e20200928calculate/item_icon/rev/weapon-a.png',
      level_current: 90,
      weapon_level: 5
    },
    skill_list: [
      { id: 123456, group_id: 9991, level_current: 10, max_level: 10 },
      { id: 2000001, group_id: 9992, level_current: 9, max_level: 10 },
      { id: 2000002, group_id: 9999, level_current: 8, max_level: 10 }
    ]
  },
  {
    id: 10000037,
    name: 'Character B',
    element_attr_id: 7,
    avatar_level: 4,
    level_current: 80,
    icon: 'character-b.png',
    constellation_num: 0,
    fetter_level: 8,
    skill_list: []
  }
];

describe('mapCalculatorRoster', () => {
  it('maps a complete, de-duplicated owned roster without inventing build fields', () => {
    const result = mapCalculatorRoster({ list: rawCharacters, total: 2 });

    expect(result?.characters).toHaveLength(2);
    expect(result?.characters[0]).toMatchObject({
      id: 10000046,
      element: 'Pyro',
      rarity: 5,
      level: 90,
      constellation: 2,
      friendship: 10,
      weapon: {
        id: 11501,
        name: 'Weapon A',
        level: 90,
        rarity: 5
      },
      talents: { normalAttack: 10, elementalSkill: 9, elementalBurst: 8 }
    });
    expect(result?.characters[0]?.iconUrl).toMatch(/^gtai-img:\/\/remote\//);
    expect(result?.characters[0]?.weapon?.iconUrl).toMatch(/^gtai-img:\/\/remote\//);
    expect(result?.characters[0]?.weapon).not.toHaveProperty('refinement');
    expect(result?.characters[0]?.artifacts).toEqual([]);
    expect(result?.coverage).toMatchObject({
      expectedOwnedCount: 2,
      listedCount: 2,
      detailedCount: 2,
      duplicateCharacterIds: [],
      partial: false,
      fields: { weapon: 1, artifacts: 0, talents: 1, stats: 0 }
    });
  });
});

describe('MiyousheCalculatorClient', () => {
  it('uses the sync endpoint with DS1 and returns the authoritative roster', async () => {
    const request = vi.fn().mockResolvedValue({
      statusCode: 200,
      bodyText: JSON.stringify({ retcode: 0, data: { list: rawCharacters, total: 2 } })
    });
    const client = new MiyousheCalculatorClient({ request });

    const result = await client.fetchOwnedRoster(
      '100000001',
      'ltoken_v2=test; ltuid_v2=1; ltmid_v2=1; _MHYUUID=device; DEVICEFP=fingerprint'
    );

    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toContain('/event/e20200928calculate/v1/sync/avatar/list');
    expect(init.headers['DS']).toMatch(/^\d+,[a-z0-9]{6},[a-f0-9]{32}$/);
    expect(init.headers['x-rpc-client_type']).toBe('5');
    expect(init.headers['x-rpc-device_id']).toBe('device');
    expect(JSON.parse(init.body)).toMatchObject({
      uid: '100000001',
      region: 'cn_gf01',
      page: 1,
      size: 200,
      is_all: true
    });
  });

  it('reports calculator sync-disabled without pretending the roster is empty', async () => {
    const request = vi.fn().mockResolvedValue({
      statusCode: 200,
      bodyText: JSON.stringify({ retcode: -502002, message: 'sync disabled', data: null })
    });
    const client = new MiyousheCalculatorClient({ request });

    const result = await client.fetchOwnedRoster('100000001', 'ltoken_v2=test');

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'upstream',
        retcode: -502002,
        httpStatus: 200,
        message: '养成计算器角色同步未开启'
      }
    });
  });
});
