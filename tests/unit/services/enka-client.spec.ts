import { describe, expect, it, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();

vi.mock('undici', () => ({
  request: requestMock
}));

beforeEach(() => {
  requestMock.mockReset();
});

function mockJson(status: number, payload: unknown) {
  return {
    statusCode: status,
    body: {
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    }
  };
}

describe('EnkaClient', () => {
  it('maps avatar info into normalized character profiles', async () => {
    const { AvatarMetadataService } = await import(
      '../../../src/main/services/avatar-metadata.js'
    );
    const { EnkaClient } = await import('../../../src/main/services/enka-client.js');

    const metadata = new AvatarMetadataService();
    vi.spyOn(metadata, 'load').mockResolvedValue(
      new Map([
        [
          10000046,
          {
            id: 10000046,
            name: '胡桃',
            icon: 'https://enka.network/ui/UI_AvatarIcon_Hutao.png',
            element: 'Fire',
            rarity: 5
          }
        ]
      ])
    );

    requestMock.mockResolvedValueOnce(
      mockJson(200, {
        uid: '123456789',
        region: 'CN',
        ttl: 300,
        playerInfo: {
          nickname: '旅行者',
          level: 60,
          showAvatarInfoList: [{ avatarId: 10000046, level: 90 }]
        },
        avatarInfoList: [
          {
            avatarId: 10000046,
            propMap: { '4001': { val: '90' } },
            fightPropMap: {
              '2000': 35000,
              '2001': 2200,
              '2002': 800,
              '20': 0.72,
              '22': 2.34,
              '23': 1.21,
              '28': 120
            },
            skillLevelMap: { '1001': 6, '1002': 9, '1003': 10 },
            talentIdList: [1, 2],
            equipList: [
              {
                itemId: 13501,
                weapon: { level: 90, affixMap: { '1': 0 } },
                flat: {
                  itemType: 'ITEM_WEAPON',
                  icon: 'UI_EquipIcon_Pole_Homa',
                  rankLevel: 5,
                  weaponStats: [
                    { appendPropId: 'FIGHT_PROP_BASE_ATTACK', statValue: 608 },
                    { appendPropId: 'FIGHT_PROP_CRITICAL_HURT', statValue: 66.2 }
                  ]
                }
              },
              {
                itemId: 75513,
                reliquary: { level: 21 },
                flat: {
                  itemType: 'ITEM_RELIQUARY',
                  equipType: 'EQUIP_SHOES',
                  icon: 'UI_RelicIcon_Test_3',
                  rankLevel: 5,
                  setNameTextMapHash: 12345,
                  reliquaryMainstat: {
                    mainPropId: 'FIGHT_PROP_CHARGE_EFFICIENCY',
                    statValue: 51.8
                  },
                  reliquarySubstats: [
                    { appendPropId: 'FIGHT_PROP_CRITICAL', statValue: 3.9 }
                  ]
                }
              }
            ]
          }
        ]
      })
    );

    const client = new EnkaClient(metadata);
    const result = await client.fetchProfile('123456789');

    expect(result.uid).toBe('123456789');
    expect(result.nickname).toBe('旅行者');
    expect(result.characters).toHaveLength(1);
    expect(result.characters[0]).toMatchObject({
      id: 10000046,
      name: '胡桃',
      element: 'Fire',
      rarity: 5,
      imageUrl: 'https://enka.network/ui/UI_AvatarIcon_Hutao.png',
      level: 90,
      constellation: 2,
      completeness: 'detailed',
      build: {
        stats: {
          hp: 35000,
          atk: 2200,
          def: 800,
          critRate: 72,
          critDmg: 234,
          energyRecharge: 121,
          elementalMastery: 120
        },
        weapon: { id: 13501, level: 90, refinement: 1, rarity: 5 },
        talents: { normalAttack: 6, elementalSkill: 9, elementalBurst: 10 }
      }
    });
    expect(result.ttlSeconds).toBe(300);
    expect(result.showcaseStatus).toBe('available');
    expect(result.characters[0]?.build?.artifacts?.[0]).toMatchObject({
      slot: 'sands',
      level: 20,
      mainStat: { key: 'FIGHT_PROP_CHARGE_EFFICIENCY', value: 51.8 }
    });
  });

  it('throws on 404', async () => {
    const { AvatarMetadataService } = await import(
      '../../../src/main/services/avatar-metadata.js'
    );
    const { EnkaClient } = await import('../../../src/main/services/enka-client.js');

    const metadata = new AvatarMetadataService();
    vi.spyOn(metadata, 'load').mockResolvedValue(new Map());

    requestMock.mockResolvedValueOnce({
      statusCode: 404,
      body: {
        json: async () => ({}),
        text: async () => 'not found'
      }
    });

    const client = new EnkaClient(metadata);
    await expect(client.fetchProfile('111222333')).rejects.toThrow(/Enka 未找到/);
  });

  it('rejects malformed UID without contacting metadata or upstream', async () => {
    const { AvatarMetadataService } = await import(
      '../../../src/main/services/avatar-metadata.js'
    );
    const { EnkaClient } = await import('../../../src/main/services/enka-client.js');

    const metadata = new AvatarMetadataService();
    const loadSpy = vi.spyOn(metadata, 'load');

    const client = new EnkaClient(metadata);
    await expect(client.fetchProfile('abc')).rejects.toThrow(/9 位数字/);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('honors response TTL and does not repeatedly consume the UID rate limit', async () => {
    const { AvatarMetadataService } = await import(
      '../../../src/main/services/avatar-metadata.js'
    );
    const { EnkaClient } = await import('../../../src/main/services/enka-client.js');
    const metadata = new AvatarMetadataService();
    vi.spyOn(metadata, 'load').mockResolvedValue(new Map());
    let now = 1_000_000;
    requestMock
      .mockResolvedValueOnce(mockJson(200, { ttl: 10, playerInfo: {}, avatarInfoList: [] }))
      .mockResolvedValueOnce(mockJson(200, { ttl: 10, playerInfo: {}, avatarInfoList: [] }));
    const client = new EnkaClient(metadata, { now: () => now });

    await client.fetchProfile('123456789');
    await client.fetchProfile('123456789');
    expect(requestMock).toHaveBeenCalledTimes(1);
    now += 10_001;
    await client.fetchProfile('123456789');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('treats a missing avatarInfoList as a closed or empty showcase', async () => {
    const { AvatarMetadataService } = await import(
      '../../../src/main/services/avatar-metadata.js'
    );
    const { EnkaClient } = await import('../../../src/main/services/enka-client.js');
    const metadata = new AvatarMetadataService();
    vi.spyOn(metadata, 'load').mockResolvedValue(new Map());
    requestMock.mockResolvedValueOnce(mockJson(200, { ttl: 60, playerInfo: { level: 60 } }));

    const result = await new EnkaClient(metadata).fetchProfile('123456789');
    expect(result.showcaseStatus).toBe('closed-or-empty');
    expect(result.characters).toEqual([]);
  });

  it('classifies 429 with retry-after without exposing the response body', async () => {
    const { AvatarMetadataService } = await import(
      '../../../src/main/services/avatar-metadata.js'
    );
    const { EnkaClient, EnkaClientError } = await import(
      '../../../src/main/services/enka-client.js'
    );
    const metadata = new AvatarMetadataService();
    vi.spyOn(metadata, 'load').mockResolvedValue(new Map());
    requestMock.mockResolvedValueOnce({
      statusCode: 429,
      headers: { 'retry-after': '30' },
      body: { json: async () => ({}), text: async () => 'private upstream body' }
    });

    await expect(new EnkaClient(metadata).fetchProfile('123456789')).rejects.toMatchObject({
      constructor: EnkaClientError,
      kind: 'rate-limited',
      retryAfterSeconds: 30
    });
  });
});
