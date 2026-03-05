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
    profileCacheFile: path.resolve('/tmp', `genshin-api-cache-recommend-${randomUUID()}.json`),
    recommendationCacheFile: path.resolve('/tmp', `genshin-api-recommend-history-${randomUUID()}.json`),
    llmProvider: 'zhipu',
    llmHealthUrl: 'https://example.com/llm-health',
    llmChatUrl: 'https://example.com/llm-chat',
    llmModel: 'glm-4.5-air',
    llmApiKey: 'test-key'
  };
}

const characters = [
  {
    id: 1001,
    name: '胡桃',
    element: 'Fire',
    rarity: 5,
    imageUrl: 'https://example.com/hutao.png',
    stats: { level: 90, hp: 35000, atk: 2200, def: 800, critRate: 75, critDmg: 230, energyRecharge: 120, elementalMastery: 120 }
  },
  {
    id: 1002,
    name: '夜兰',
    element: 'Water',
    rarity: 5,
    imageUrl: 'https://example.com/yelan.png',
    stats: { level: 90, hp: 41000, atk: 1450, def: 760, critRate: 70, critDmg: 210, energyRecharge: 180, elementalMastery: 80 }
  },
  {
    id: 1003,
    name: '钟离',
    element: 'Rock',
    rarity: 5,
    imageUrl: 'https://example.com/zhongli.png',
    stats: { level: 90, hp: 48000, atk: 1300, def: 920, critRate: 55, critDmg: 150, energyRecharge: 130, elementalMastery: 40 }
  },
  {
    id: 1004,
    name: '行秋',
    element: 'Water',
    rarity: 4,
    imageUrl: 'https://example.com/xingqiu.png',
    stats: { level: 90, hp: 21000, atk: 1600, def: 780, critRate: 55, critDmg: 140, energyRecharge: 230, elementalMastery: 60 }
  }
];

describe('Phase3 recommendation endpoints', () => {
  it('returns llm recommendation when llm responds with valid json', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/llm-chat')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: '推荐以胡桃蒸发为核心。',
                    teams: [
                      {
                        name: '蒸发稳定队',
                        characterIds: [1001, 1002, 1004, 1003],
                        reasoning: '输出与生存平衡。',
                        rotationTip: '先挂水后火输出。'
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
    }) as unknown as typeof fetch;

    const app = buildServer({ config: makeConfig(), fetchImpl });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/recommend',
      payload: {
        characters,
        enemyNames: ['abyss-mage']
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.data.source).toBe('llm');
    expect(body.data.teams).toHaveLength(1);
    expect(body.data.teams[0].characters).toHaveLength(4);

    const enemyResponse = await app.inject({
      method: 'GET',
      url: '/api/enemy/current'
    });
    expect(enemyResponse.statusCode).toBe(200);
    expect(enemyResponse.json().ok).toBe(true);

    await app.close();
  });

  it('falls back when llm fails', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/llm-chat')) {
        return new Response(JSON.stringify({ error: 'down' }), { status: 500 });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const app = buildServer({ config: makeConfig(), fetchImpl });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/recommend',
      payload: {
        characters,
        enemyNames: ['abyss-lector']
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.data.source).toBe('fallback');
    expect(body.data.teams[0].characters.length).toBeGreaterThanOrEqual(4);

    await app.close();
  });

  it('stores history and supports compare endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/llm-chat')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: '推荐生成成功',
                    teams: [
                      {
                        name: '标准队',
                        characterIds: [1001, 1002, 1003, 1004],
                        reasoning: '覆盖多元素',
                        rotationTip: '先辅助后主C'
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

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const app = buildServer({ config: makeConfig(), fetchImpl });

    const recommendResponse = await app.inject({
      method: 'POST',
      url: '/api/ai/recommend',
      payload: {
        uid: '123456789',
        characters,
        enemyNames: ['abyss-mage']
      }
    });
    expect(recommendResponse.statusCode).toBe(200);

    const compareResponse = await app.inject({
      method: 'POST',
      url: '/api/recommend/compare',
      payload: {
        uid: '123456789',
        characters,
        leftEnemyNames: ['abyss-mage'],
        rightEnemyNames: ['ruin-guard']
      }
    });
    expect(compareResponse.statusCode).toBe(200);
    expect(compareResponse.json().data.diffSummary).toBeTruthy();

    const historyResponse = await app.inject({
      method: 'GET',
      url: '/api/recommend/history?uid=123456789&limit=2&offset=0'
    });

    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json().data.items.length).toBe(2);
    expect(historyResponse.json().data.total).toBeGreaterThanOrEqual(3);
    expect(historyResponse.json().data.hasMore).toBe(true);

    const filteredHistoryResponse = await app.inject({
      method: 'GET',
      url: '/api/recommend/history?uid=123456789&source=llm&enemyKeyword=abyss&limit=5'
    });

    expect(filteredHistoryResponse.statusCode).toBe(200);
    const filteredItems = filteredHistoryResponse.json().data.items as Array<{ source: string; enemyNames: string[] }>;
    expect(filteredItems.every((item) => item.source === 'llm')).toBe(true);

    const idToDelete = filteredItems[0]?.enemyNames ? filteredHistoryResponse.json().data.items[0]?.id : undefined;
    expect(typeof idToDelete).toBe('string');

    const deleteSingleResponse = await app.inject({
      method: 'DELETE',
      url: `/api/recommend/history/${idToDelete}`
    });
    expect(deleteSingleResponse.statusCode).toBe(200);
    expect(deleteSingleResponse.json().removed).toBe(1);

    const deleteManyResponse = await app.inject({
      method: 'DELETE',
      url: '/api/recommend/history?uid=123456789&source=llm'
    });
    expect(deleteManyResponse.statusCode).toBe(200);
    expect(deleteManyResponse.json().removed).toBeGreaterThanOrEqual(1);

    await app.close();
  });
});
