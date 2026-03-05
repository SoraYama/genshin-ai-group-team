import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

function makeConfig(): AppConfig {
  return {
    port: 3001,
    requestTimeoutMs: 1000,
    genshinDbUrl: 'https://example.com/genshin-db',
    enemyDataUrl: 'https://example.com/enemy-data',
    miyousheRoleUrl: 'https://example.com/mys-roles',
    enkaApiUrl: 'https://example.com/enka/uid',
    enkaCharactersMetaUrl: 'https://example.com/enka/characters.json',
    enkaLocMetaUrl: 'https://example.com/enka/loc.json',
    profileCacheFile: path.resolve('/tmp', `genshin-api-cache-import-${randomUUID()}.json`),
    recommendationCacheFile: path.resolve('/tmp', `genshin-api-recommend-import-${randomUUID()}.json`),
    llmProvider: 'zhipu',
    llmHealthUrl: undefined,
    llmChatUrl: undefined,
    llmModel: 'glm-4.5-air',
    llmApiKey: undefined
  };
}

describe('POST /api/mys/import and GET /api/profile/:uid', () => {
  it('imports profiles from miyoushe + enka and stores in cache', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/mys-roles')) {
        return new Response(
          JSON.stringify({
            retcode: 0,
            data: {
              list: [
                {
                  game_uid: '123456789',
                  region: 'cn_gf01',
                  nickname: '旅行者',
                  level: 58
                }
              ]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes('/enka/characters.json')) {
        return new Response(
          JSON.stringify({
            '10000002': {
              NameTextMapHash: 1006042610,
              SideIconName: 'UI_AvatarIcon_Side_Ayaka',
              Element: 'Ice',
              QualityType: 'QUALITY_ORANGE'
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes('/enka/loc.json')) {
        return new Response(
          JSON.stringify({
            chs: {
              '1006042610': '神里绫华'
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes('/enka/uid/123456789')) {
        return new Response(
          JSON.stringify({
            uid: '123456789',
            region: 'CN',
            playerInfo: {
              nickname: '旅行者',
              level: 58,
              showAvatarInfoList: [{ avatarId: 10000002, level: 90 }]
            },
            avatarInfoList: [
              {
                avatarId: 10000002,
                propMap: {
                  '4001': { val: '90' }
                },
                fightPropMap: {
                  '2000': 24000,
                  '2001': 1900,
                  '2002': 900,
                  '20': 0.72,
                  '22': 2.04,
                  '23': 1.21,
                  '28': 120
                }
              }
            ]
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const app = buildServer({ config: makeConfig(), fetchImpl });

    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/mys/import',
      payload: { cookie: 'ltoken=foo; ltuid=bar;' }
    });

    expect(importResponse.statusCode).toBe(200);
    const importBody = importResponse.json();
    expect(importBody.ok).toBe(true);
    expect(importBody.data.uid).toBe('123456789');
    expect(importBody.data.source).toBe('miyoushe+enka');
    expect(importBody.data.profiles).toHaveLength(1);
    expect(importBody.data.profiles[0].name).toBe('神里绫华');
    expect(importBody.data.profiles[0].stats.level).toBe(90);

    const profileResponse = await app.inject({
      method: 'GET',
      url: '/api/profile/123456789'
    });
    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json().data.profiles).toHaveLength(1);

    await app.close();
  });

  it('falls back to miyoushe-only cache when enka import fails', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/mys-roles')) {
        return new Response(
          JSON.stringify({
            retcode: 0,
            data: {
              list: [{ game_uid: '888888888', region: 'cn_gf01', nickname: '派蒙', level: 30 }]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes('/enka/uid/888888888')) {
        throw new Error('enka unavailable');
      }

      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const app = buildServer({ config: makeConfig(), fetchImpl });

    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/mys/import',
      payload: { cookie: 'ltoken=foo; ltuid=bar;' }
    });

    expect(importResponse.statusCode).toBe(200);
    const importBody = importResponse.json();
    expect(importBody.data.uid).toBe('888888888');
    expect(importBody.data.source).toBe('miyoushe');
    expect(importBody.data.profiles).toHaveLength(0);

    await app.close();
  });
});
