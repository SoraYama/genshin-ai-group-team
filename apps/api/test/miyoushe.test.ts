import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const mockConfig: AppConfig = {
  port: 3001,
  requestTimeoutMs: 1000,
  genshinDbUrl: 'https://example.com/genshin-db',
  enemyDataUrl: 'https://example.com/enemy-data',
  miyousheRoleUrl: 'https://example.com/mys-roles',
  enkaApiUrl: 'https://example.com/enka/uid',
  enkaCharactersMetaUrl: 'https://example.com/enka/characters.json',
  enkaLocMetaUrl: 'https://example.com/enka/loc.json',
  profileCacheFile: '/tmp/genshin-api-cache-miyoushe-test.json',
  recommendationCacheFile: '/tmp/genshin-api-recommend-miyoushe-test.json',
  llmProvider: 'zhipu',
  llmHealthUrl: undefined,
  llmChatUrl: undefined,
  llmModel: 'glm-4.5-air',
  llmApiKey: undefined
};

describe('POST /api/mys/validate-cookie', () => {
  it('validates cookie and returns role count', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ retcode: 0, data: { list: [{ game_uid: '123', region: 'cn_gf01' }] } }), {
        status: 200
      })
    ) as unknown as typeof fetch;

    const app = buildServer({ config: mockConfig, fetchImpl });

    const response = await app.inject({
      method: 'POST',
      url: '/api/mys/validate-cookie',
      payload: { cookie: 'ltoken=foo; ltuid=bar;' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(response.json().roleCount).toBe(1);

    await app.close();
  });

  it('rejects short cookie payload', async () => {
    const app = buildServer({ config: mockConfig, fetchImpl: vi.fn() as unknown as typeof fetch });

    const response = await app.inject({
      method: 'POST',
      url: '/api/mys/validate-cookie',
      payload: { cookie: 'short' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().ok).toBe(false);

    await app.close();
  });
});
