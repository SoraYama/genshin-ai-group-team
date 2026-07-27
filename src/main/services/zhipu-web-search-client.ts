import {
  privacySafeResearchText,
  privacySafeResearchUrl
} from './research-privacy.js';

const ZHIPU_WEB_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const ZHIPU_API_HOST = 'open.bigmodel.cn';
const MAX_QUERY_CHARACTERS = 70;

export interface GuideWebSearchResult {
  title: string;
  snippet: string;
  url: string;
  publishedAt?: string;
}

export interface GuideWebSearchClient {
  search(query: string, options?: { signal?: AbortSignal }): Promise<GuideWebSearchResult[]>;
}

export interface ZhipuWebSearchClientOptions {
  apiKey: string;
  domain?: string;
  fetchImpl?: typeof fetch;
}

export class ZhipuWebSearchClient {
  private readonly apiKey: string;
  private readonly domain: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ZhipuWebSearchClientOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) throw new Error('Zhipu Web Search requires an API key.');
    this.apiKey = apiKey;
    this.domain = options.domain;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(
    query: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<GuideWebSearchResult[]> {
    const safeQuery = privacySafeResearchText(query);
    if (
      safeQuery === undefined ||
      safeQuery.length === 0 ||
      Array.from(safeQuery).length > MAX_QUERY_CHARACTERS
    ) {
      throw new Error('Zhipu Web Search query must contain at most 70 safe characters.');
    }
    const response = await this.fetchImpl(ZHIPU_WEB_SEARCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        search_query: safeQuery,
        search_engine: 'search_std',
        search_intent: false,
        count: 10,
        ...(this.domain === undefined ? {} : { search_domain_filter: this.domain }),
        search_recency_filter: 'noLimit',
        content_size: 'high'
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (!response.ok) {
      throw new Error(`Zhipu Web Search request failed with HTTP ${response.status}.`);
    }
    const decoded: unknown = await response.json();
    if (!isRecord(decoded) || !Array.isArray(decoded['search_result'])) {
      throw new Error('Zhipu Web Search returned an invalid response.');
    }
    return decoded['search_result'].slice(0, 10).flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const title =
        typeof candidate['title'] === 'string'
          ? privacySafeResearchText(candidate['title'].slice(0, 200))
          : undefined;
      const snippet =
        typeof candidate['content'] === 'string'
          ? privacySafeResearchText(candidate['content'].slice(0, 4_000))
          : undefined;
      const url =
        typeof candidate['link'] === 'string'
          ? privacySafeResearchUrl(candidate['link'])
          : undefined;
      const publishedAt =
        typeof candidate['publish_date'] === 'string'
          ? privacySafeResearchText(candidate['publish_date'].slice(0, 240))
          : undefined;
      if (!title || !snippet || !url) return [];
      return [{ title, snippet, url, ...(publishedAt ? { publishedAt } : {}) }];
    });
  }
}

export function supportsZhipuWebSearch(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === ZHIPU_API_HOST;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
