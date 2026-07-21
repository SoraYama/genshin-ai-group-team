import type { MiyousheBrowserTransport } from '../miyoushe-game-record.js';

export interface ChromiumSessionFetch {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

function hasExplicitCookie(headers: Readonly<Record<string, string>>): boolean {
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === 'cookie' && value.length > 0
  );
}

/**
 * Use Chromium's network stack without allowing its cookie jar to replace the
 * complete Main-process Cookie header. With `credentials: include`, Chromium
 * rebuilds Cookie from the target domain and silently drops account context
 * that only exists on `.miyoushe.com` (for example cookie_token_v2).
 */
export function createMiyousheBrowserTransport(
  chromiumSession: ChromiumSessionFetch
): MiyousheBrowserTransport {
  return async (url, request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await chromiumSession.fetch(url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        credentials: hasExplicitCookie(request.headers) ? 'omit' : 'include',
        signal: controller.signal
      });
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bodyText: await response.text()
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
