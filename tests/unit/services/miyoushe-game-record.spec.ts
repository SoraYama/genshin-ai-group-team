import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();

vi.mock('undici', () => ({
  request: requestMock
}));

function mockJson(status: number, payload: unknown) {
  return {
    statusCode: status,
    body: { text: async () => JSON.stringify(payload) }
  };
}

function mockText(status: number, text: string) {
  return {
    statusCode: status,
    body: { text: async () => text }
  };
}

const list = [
  {
    id: 10000046,
    name: 'Character A',
    element: 'Pyro',
    level: 90,
    rarity: 5,
    icon: 'icon-a.png',
    actived_constellation_num: 1,
    fetter: 10
  },
  {
    id: 10000037,
    name: 'Character B',
    element: 'Cryo',
    level: 80,
    rarity: 5,
    icon: 'icon-b.png',
    actived_constellation_num: 0,
    fetter: 8
  }
];

beforeEach(() => {
  requestMock.mockReset();
});

describe('regionFromUid', () => {
  it('maps UID prefixes to expected servers', async () => {
    const { regionFromUid } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    expect(regionFromUid('100000001').region).toBe('cn_gf01');
    expect(regionFromUid('500000001').region).toBe('cn_qd01');
    expect(regionFromUid('600000001')).toEqual({ region: 'os_usa', isGlobal: true });
    expect(regionFromUid('700000001')).toEqual({ region: 'os_euro', isGlobal: true });
    expect(regionFromUid('800000001')).toEqual({ region: 'os_asia', isGlobal: true });
    expect(regionFromUid('900000001')).toEqual({ region: 'os_cht', isGlobal: true });
  });
});

describe('deviceHeadersFromCookie', () => {
  it('uses only a complete device id/fingerprint pair from the same cookie context', async () => {
    const { deviceHeadersFromCookie } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    expect(
      deviceHeadersFromCookie(
        'ltoken_v2=token; _MHYUUID=device-id; DEVICEFP=device-fingerprint'
      )
    ).toEqual({
      'x-rpc-device_id': 'device-id',
      'x-rpc-device_fp': 'device-fingerprint'
    });
    expect(deviceHeadersFromCookie('ltoken_v2=token; _MHYUUID=device-id')).toEqual({});
    expect(deviceHeadersFromCookie('ltoken_v2=token; DEVICEFP=device-fingerprint')).toEqual({});
  });
});

describe('Chromium transport fallback', () => {
  it('retries a captcha-classified response once through the browser session', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    requestMock.mockResolvedValueOnce(
      mockJson(200, { retcode: 5003, message: '访问异常，请稍后重试' })
    );
    const browserTransport = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: {},
      bodyText: JSON.stringify({
        retcode: 0,
        data: {
          role: { nickname: 'Traveler' },
          stats: { world_level: 9, avatar_number: 80 }
        }
      })
    });
    const client = new MiyousheGameRecordClient({ browserTransport });

    await expect(client.ping('100000001', 'cookie=valid-enough')).resolves.toEqual({
      ok: true,
      data: {
        nickname: 'Traveler',
        worldLevel: 9,
        activeDays: undefined,
        totalCharacters: 80
      }
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(browserTransport).toHaveBeenCalledTimes(1);
    expect(browserTransport.mock.calls[0]?.[1].headers).toHaveProperty('DS');
  });

  it('retries with user verification headers after Chromium also returns 5003', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    requestMock.mockResolvedValueOnce(
      mockJson(200, { retcode: 5003, message: '访问异常，请稍后重试' })
    );
    const browserTransport = vi
      .fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        bodyText: JSON.stringify({ retcode: 5003, message: '访问异常，请稍后重试' })
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        bodyText: JSON.stringify({ retcode: 0, data: { stats: { avatar_number: 80 } } })
      });
    const verificationProvider = vi.fn().mockResolvedValue({
      ok: true,
      headers: { 'x-rpc-challenge': 'final-challenge' }
    });
    const client = new MiyousheGameRecordClient({
      browserTransport,
      verificationProvider
    });

    const result = await client.ping('100000001', 'cookie=valid-enough');
    expect(result.ok).toBe(true);
    expect(verificationProvider).toHaveBeenCalledWith(
      'cookie=valid-enough',
      '/game_record/app/genshin/api/index'
    );
    expect(browserTransport).toHaveBeenCalledTimes(2);
    expect(browserTransport.mock.calls[1]?.[1].headers).toMatchObject({
      'x-rpc-challenge': 'final-challenge'
    });
  });

  it('surfaces a rejected interactive verification without hiding the cached-data fallback', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003 }));
    const browserTransport = vi.fn().mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      bodyText: JSON.stringify({ retcode: 5003 })
    });
    const client = new MiyousheGameRecordClient({
      browserTransport,
      verificationProvider: vi.fn().mockResolvedValue({
        ok: false,
        retcode: 10306,
        message: '已保留本地角色缓存'
      })
    });

    const result = await client.ping('100000001', 'cookie=valid-enough');

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'captcha-required',
        retcode: 10306,
        message: '已保留本地角色缓存'
      }
    });
  });
});

describe('browser bridge payload mappers', () => {
  it('uses the same list/detail mapping contract as direct HTTP', async () => {
    const { mapMiyousheCharacterDetailData, mapMiyousheCharacterListData } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    expect(mapMiyousheCharacterListData({ list })?.map((character) => character.id)).toEqual([
      10000046,
      10000037
    ]);
    const detailed = mapMiyousheCharacterDetailData({
      list: [
        {
          base: list[0],
          weapon: { id: 1, name: 'Bridge Weapon', level: 90, rarity: 5, affix_level: 3 },
          relics: [],
          skills: [
            { skill_type: 1, level: 6 },
            { skill_type: 2, level: 8 },
            { skill_type: 3, level: 9 }
          ],
          selected_properties: [{ property_type: 20, final: '0.55' }]
        }
      ]
    });
    expect(detailed?.[0]).toMatchObject({
      id: 10000046,
      weapon: { name: 'Bridge Weapon', refinement: 3 },
      talents: { normalAttack: 6, elementalSkill: 8, elementalBurst: 9 },
      stats: { critRate: 55 }
    });
    expect(mapMiyousheCharacterDetailData({ wrong: [] })).toBeUndefined();
  });
});

describe('MiyousheGameRecordClient.fetchDetailedRoster', () => {
  it('POSTs list/detail with the exact body, preserves order, and maps build fields', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );

    requestMock
      .mockResolvedValueOnce(mockJson(200, { retcode: 0, data: { list } }))
      .mockResolvedValueOnce(
        mockJson(200, {
          retcode: 0,
          data: {
            property_map: {
              '20': { property_type: 20, name: 'CRIT Rate' },
              '22': { property_type: 22, name: 'CRIT DMG' }
            },
            list: [
              {
                base: list[1],
                weapon: {
                  id: 11501,
                  name: 'Weapon B',
                  icon: 'weapon-b.png',
                  rarity: 5,
                  level: 90,
                  affix_level: 2,
                  main_property: { property_type: 4, final: '608' },
                  sub_property: { property_type: 22, final: '66.2%' }
                },
                relics: [
                  {
                    id: 50120,
                    pos: 3,
                    rarity: 5,
                    level: 20,
                    set: { id: 15001, name: 'Test Set' },
                    main_property: { property_type: 23, value: '51.8%' },
                    sub_property_list: [{ property_type: 20, value: '3.9%' }]
                  }
                ],
                skills: [
                  { skill_type: 1, level: 6, is_unlock: true },
                  { skill_type: 2, level: 9, is_unlock: true },
                  { skill_type: 3, level: 10, is_unlock: true }
                ],
                selected_properties: [
                  { property_type: 20, final: '0.612' },
                  { property_type: 22, final: '1.84' },
                  { property_type: 23, final: '1.35' }
                ]
              },
              {
                base: list[0],
                weapon: {
                  id: 13501,
                  name: 'Weapon A',
                  icon: 'weapon-a.png',
                  rarity: 5,
                  level: 90,
                  affix_level: 1
                },
                relics: [],
                skills: [
                  { skill_type: 1, level: 6 },
                  { skill_type: 2, level: 8 },
                  { skill_type: 3, level: 8 }
                ],
                base_properties: [
                  { property_type: 1, final: '32000' },
                  { property_type: 4, final: '1800' },
                  { property_type: 7, final: '900' }
                ]
              }
            ]
          }
        })
      );

    const client = new MiyousheGameRecordClient();
    const result = await client.fetchDetailedRoster('100000001', 'ltoken=x; ltuid=y', {
      expectedOwnedCount: 2
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.characters.map((character) => character.id)).toEqual([
      10000046,
      10000037
    ]);
    expect(result.data.characters[0]?.weapon?.name).toBe('Weapon A');
    expect(result.data.characters[1]?.artifacts[0]).toMatchObject({
      slot: 'sands',
      setName: 'Test Set',
      mainStat: { key: 'energyRecharge', value: 51.8 }
    });
    expect(result.data.characters[1]?.talents).toEqual({
      normalAttack: 6,
      elementalSkill: 9,
      elementalBurst: 10
    });
    expect(result.data.characters[1]?.stats).toEqual({
      critRate: 61.2,
      critDmg: 184,
      energyRecharge: 135
    });
    expect(result.data.coverage).toMatchObject({
      expectedOwnedCount: 2,
      listedCount: 2,
      detailedCount: 2,
      partial: false,
      fields: { weapon: 2, artifacts: 1, talents: 2, stats: 2 }
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    const listCall = requestMock.mock.calls[0]!;
    expect(String(listCall[0])).toContain('/game_record/app/genshin/api/character/list');
    expect((listCall[1] as { body: string }).body).toBe(
      JSON.stringify({ role_id: '100000001', server: 'cn_gf01' })
    );
    expect((listCall[1] as { headers: Record<string, string> }).headers).not.toHaveProperty(
      'x-rpc-device_id'
    );
    const detailCall = requestMock.mock.calls[1]!;
    expect((detailCall[1] as { body: string }).body).toBe(
      JSON.stringify({
        role_id: '100000001',
        server: 'cn_gf01',
        character_ids: [10000046, 10000037]
      })
    );
    const headers = (detailCall[1] as { headers: Record<string, string> }).headers;
    expect(headers.DS).toMatch(/^\d+,\d{6},[a-f0-9]{32}$/);
    expect(headers['x-rpc-device_id']).toBeUndefined();
    expect(headers['x-rpc-device_fp']).toBeUndefined();
  });

  it('batches detail requests and reports missing/duplicate IDs as partial', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    requestMock
      .mockResolvedValueOnce(
        mockJson(200, { retcode: 0, data: { list: [list[0], list[0], list[1]] } })
      )
      .mockResolvedValueOnce(
        mockJson(200, { retcode: 0, data: { list: [{ base: list[0] }] } })
      )
      .mockResolvedValueOnce(mockJson(429, { retcode: 0, message: 'too many requests' }));

    const client = new MiyousheGameRecordClient();
    const result = await client.fetchDetailedRoster('100000001', 'cookie=valid-enough', {
      expectedOwnedCount: 3,
      batchSize: 1
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.characters).toHaveLength(2);
    expect(result.data.coverage).toMatchObject({
      listedCount: 2,
      detailedCount: 1,
      duplicateCharacterIds: [10000046],
      missingCharacterIds: [10000037],
      failedBatches: [{ batchIndex: 1, kind: 'rate-limited' }],
      partial: true
    });
    expect(result.data.characters[1]?.artifacts).toEqual([]);
    expect(result.data.characters[1]?.talents).toBeUndefined();
  });

  it.each([
    [5003, 200, 'captcha-required'],
    [1034, 200, 'captcha-required'],
    [-5003, 200, 'signature'],
    [-100, 200, 'auth-expired'],
    [10101, 200, 'rate-limited']
  ])('classifies retcode %s as %s', async (retcode, status, expectedKind) => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    requestMock.mockResolvedValueOnce(mockJson(status, { retcode, message: 'failure' }));
    const result = await new MiyousheGameRecordClient().fetchDetailedRoster(
      '100000001',
      'cookie=valid-enough'
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe(expectedKind);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('classifies non-JSON without leaking response text', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    requestMock.mockResolvedValueOnce(mockText(403, 'secret upstream response body'));
    const result = await new MiyousheGameRecordClient().fetchDetailedRoster(
      '100000001',
      'cookie=valid-enough'
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse');
    expect(result.error.message).not.toContain('secret upstream response body');
  });

  it('uses the current sg-public-api route for global UIDs', async () => {
    const { MiyousheGameRecordClient } = await import(
      '../../../src/main/services/miyoushe-game-record.js'
    );
    requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 0, data: { list: [] } }));
    const result = await new MiyousheGameRecordClient().fetchDetailedRoster(
      '800000001',
      'cookie=valid-enough'
    );
    expect(result.ok).toBe(true);
    expect(String(requestMock.mock.calls[0]?.[0])).toBe(
      'https://sg-public-api.hoyolab.com/event/game_record/app/genshin/api/character/list'
    );
  });
});
