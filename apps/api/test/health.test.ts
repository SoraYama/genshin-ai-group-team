import { afterEach, describe, expect, it, vi } from 'vitest';
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
  profileCacheFile: '/tmp/genshin-api-cache-health-test.json',
  recommendationCacheFile: '/tmp/genshin-api-recommend-health-test.json',
  llmProvider: 'zhipu',
  llmHealthUrl: undefined,
  llmChatUrl: undefined,
  llmModel: 'glm-4.5-air',
  llmApiKey: undefined
};

function createMockFetch(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('genshin-db')) {
      return new Response(JSON.stringify({ name: 'Amber' }), { status: 200 });
    }

    if (url.includes('enemy-data')) {
      return new Response(JSON.stringify({ retcode: 0, data: { items: {} } }), { status: 200 });
    }

    if (url.includes('mys-roles')) {
      return new Response(JSON.stringify({ retcode: 0, data: { list: [] } }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('returns ok when required checks are up', async () => {
    const app = buildServer({ config: mockConfig, fetchImpl: createMockFetch() });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(response.json().required).toEqual(['genshinDb', 'enemyData']);

    await app.close();
  });

  it('returns 503 when required check fails', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('genshin-db')) {
        return new Response(JSON.stringify({ error: 'bad' }), { status: 500 });
      }

      return new Response(JSON.stringify({ retcode: 0, data: { items: {} } }), { status: 200 });
    }) as unknown as typeof fetch;

    const app = buildServer({ config: mockConfig, fetchImpl });
    const response = await app.inject({
      method: 'GET',
      url: '/api/health'
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().ok).toBe(false);

    await app.close();
  });
});
