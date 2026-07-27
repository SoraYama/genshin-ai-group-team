import { describe, expect, it, vi } from 'vitest';

import {
  ZhipuWebSearchClient,
  supportsZhipuWebSearch
} from '../../../src/main/services/zhipu-web-search-client.js';

describe('ZhipuWebSearchClient', () => {
  it('recognizes only the official Zhipu API origin', () => {
    expect(supportsZhipuWebSearch('https://open.bigmodel.cn/api/anthropic')).toBe(true);
    expect(supportsZhipuWebSearch('https://OPEN.BIGMODEL.CN/api/anthropic/')).toBe(true);
    expect(supportsZhipuWebSearch('https://open.bigmodel.cn.attacker.test/api/anthropic')).toBe(
      false
    );
    expect(supportsZhipuWebSearch('https://api.anthropic.com')).toBe(false);
    expect(supportsZhipuWebSearch('not-a-url')).toBe(false);
  });

  it('uses the saved key only against the official endpoint and returns bounded results', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        Authorization: 'Bearer saved-zhipu-key',
        'Content-Type': 'application/json'
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        search_query: '原神 雷电将军 配队攻略',
        search_engine: 'search_std',
        search_intent: false,
        count: 10,
        search_domain_filter: 'www.hoyolab.com',
        search_recency_filter: 'noLimit',
        content_size: 'high'
      });
      return new Response(
        JSON.stringify({
          search_result: [
            {
              title: '雷电将军配队攻略',
              content: '雷电将军可在队伍中承担爆发输出职责。',
              link: 'https://www.hoyolab.com/article/12345678',
              publish_date: '2026-07-20'
            },
            { title: '', content: 'invalid', link: 'not-a-url' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const client = new ZhipuWebSearchClient({
      apiKey: 'saved-zhipu-key',
      fetchImpl: fetchImpl as typeof fetch,
      domain: 'www.hoyolab.com'
    });

    await expect(client.search('原神 雷电将军 配队攻略')).resolves.toEqual([
      {
        title: '雷电将军配队攻略',
        snippet: '雷电将军可在队伍中承担爆发输出职责。',
        url: 'https://www.hoyolab.com/article/12345678',
        publishedAt: '2026-07-20'
      }
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/paas/v4/web_search',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rejects overlong queries before sending the key', async () => {
    const fetchImpl = vi.fn();
    const client = new ZhipuWebSearchClient({
      apiKey: 'saved-zhipu-key',
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(client.search('原'.repeat(71))).rejects.toThrow('70');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
