import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { AppConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

function createConfig(): AppConfig {
  return {
    port: 0,
    requestTimeoutMs: 1000,
    genshinDbUrl: 'https://example.com/genshin-db',
    enemyDataUrl: 'https://example.com/enemy-data',
    miyousheRoleUrl: 'https://example.com/mys-roles',
    enkaApiUrl: 'https://example.com/enka/uid',
    enkaCharactersMetaUrl: 'https://example.com/enka/characters.json',
    enkaLocMetaUrl: 'https://example.com/enka/loc.json',
    profileCacheFile: path.resolve('/tmp', `genshin-api-e2e-profile-${randomUUID()}.json`),
    recommendationCacheFile: path.resolve('/tmp', `genshin-api-e2e-recommend-${randomUUID()}.json`),
    llmProvider: 'zhipu',
    llmHealthUrl: 'https://example.com/llm-health',
    llmChatUrl: 'https://example.com/llm-chat',
    llmModel: 'glm-4.5-air',
    llmApiKey: 'test-key'
  };
}

test('Phase5 E2E: import -> recommend -> compare -> history', async ({ request }) => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/mys-roles')) {
      return new Response(
        JSON.stringify({
          retcode: 0,
          data: {
            list: [{ game_uid: '123456789', region: 'cn_gf01', nickname: '旅行者', level: 60 }]
          }
        }),
        { status: 200 }
      );
    }

    if (url.includes('/enka/characters.json')) {
      return new Response(
        JSON.stringify({
          '1001': {
            NameTextMapHash: 1,
            SideIconName: 'UI_AvatarIcon_Side_Hutao',
            Element: 'Fire',
            QualityType: 'QUALITY_ORANGE'
          },
          '1002': {
            NameTextMapHash: 2,
            SideIconName: 'UI_AvatarIcon_Side_Yelan',
            Element: 'Water',
            QualityType: 'QUALITY_ORANGE'
          },
          '1003': {
            NameTextMapHash: 3,
            SideIconName: 'UI_AvatarIcon_Side_Zhongli',
            Element: 'Rock',
            QualityType: 'QUALITY_ORANGE'
          },
          '1004': {
            NameTextMapHash: 4,
            SideIconName: 'UI_AvatarIcon_Side_Xingqiu',
            Element: 'Water',
            QualityType: 'QUALITY_PURPLE'
          }
        }),
        { status: 200 }
      );
    }

    if (url.includes('/enka/loc.json')) {
      return new Response(JSON.stringify({ chs: { '1': '胡桃', '2': '夜兰', '3': '钟离', '4': '行秋' } }), {
        status: 200
      });
    }

    if (url.includes('/enka/uid/123456789')) {
      return new Response(
        JSON.stringify({
          uid: '123456789',
          playerInfo: {
            nickname: '旅行者',
            level: 60,
            showAvatarInfoList: [
              { avatarId: 1001, level: 90 },
              { avatarId: 1002, level: 90 },
              { avatarId: 1003, level: 90 },
              { avatarId: 1004, level: 90 }
            ]
          },
          avatarInfoList: [
            { avatarId: 1001, propMap: { '4001': { val: '90' } }, fightPropMap: { '2000': 35000, '2001': 2200, '2002': 800, '20': 0.7, '22': 2.2, '23': 1.2, '28': 120 } },
            { avatarId: 1002, propMap: { '4001': { val: '90' } }, fightPropMap: { '2000': 42000, '2001': 1500, '2002': 780, '20': 0.7, '22': 2.0, '23': 1.8, '28': 80 } },
            { avatarId: 1003, propMap: { '4001': { val: '90' } }, fightPropMap: { '2000': 50000, '2001': 1300, '2002': 1000, '20': 0.5, '22': 1.4, '23': 1.3, '28': 40 } },
            { avatarId: 1004, propMap: { '4001': { val: '90' } }, fightPropMap: { '2000': 21000, '2001': 1650, '2002': 760, '20': 0.55, '22': 1.5, '23': 2.2, '28': 60 } }
          ]
        }),
        { status: 200 }
      );
    }

    if (url.includes('/llm-chat')) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '推荐蒸发体系。',
                  teams: [
                    {
                      name: '蒸发队',
                      characterIds: [1001, 1002, 1004, 1003],
                      reasoning: '输出稳定。',
                      rotationTip: '先挂水再火输出。'
                    }
                  ]
                })
              }
            }
          ]
        }),
        { status: 200 }
      );
    }

    if (url.includes('/enemy-data')) {
      return new Response(JSON.stringify(['abyss-mage', 'ruin-guard']), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const app = buildServer({
    config: createConfig(),
    fetchImpl
  });

  const address = await app.listen({ port: 0, host: '127.0.0.1' });

  try {
    const importResponse = await request.post(`${address}/api/mys/import`, {
      data: { cookie: 'ltoken=foo; ltuid=bar;' }
    });
    expect(importResponse.ok()).toBeTruthy();

    const importBody = await importResponse.json();
    expect(importBody.data.profiles.length).toBeGreaterThanOrEqual(4);

    const recommendResponse = await request.post(`${address}/api/ai/recommend`, {
      data: {
        uid: '123456789',
        enemyNames: ['abyss-mage'],
        preference: '容错高'
      }
    });

    expect(recommendResponse.ok()).toBeTruthy();
    const recommendBody = await recommendResponse.json();
    expect(recommendBody.data.teams.length).toBeGreaterThan(0);

    const compareResponse = await request.post(`${address}/api/recommend/compare`, {
      data: {
        uid: '123456789',
        leftEnemyNames: ['abyss-mage'],
        rightEnemyNames: ['ruin-guard']
      }
    });

    expect(compareResponse.ok()).toBeTruthy();
    const compareBody = await compareResponse.json();
    expect(typeof compareBody.data.diffSummary).toBe('string');

    const historyResponse = await request.get(`${address}/api/recommend/history?uid=123456789&limit=10`);
    expect(historyResponse.ok()).toBeTruthy();
    const historyBody = await historyResponse.json();
    expect(historyBody.data.items.length).toBeGreaterThanOrEqual(3);
  } finally {
    await app.close();
  }
});
