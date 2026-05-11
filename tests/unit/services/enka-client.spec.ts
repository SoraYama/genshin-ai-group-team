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
            }
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
      stats: {
        level: 90,
        hp: 35000,
        atk: 2200,
        def: 800,
        critRate: 72,
        critDmg: 234,
        energyRecharge: 121,
        elementalMastery: 120
      }
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
});
