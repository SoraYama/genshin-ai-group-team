import { describe, expect, it, vi } from 'vitest';
import { createMiyousheBrowserTransport } from '../../../src/main/services/miyoushe/browser-transport.js';

describe('createMiyousheBrowserTransport', () => {
  it('preserves the complete explicit account cookie instead of replacing it with session cookies', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ retcode: 0, data: {} }), {
        status: 200,
        headers: { 'x-trace-id': 'trace' }
      })
    );
    const transport = createMiyousheBrowserTransport({ fetch });

    await transport('https://api-takumi-record.mihoyo.com/example', {
      method: 'GET',
      headers: {
        cookie: 'ltoken_v2=token; cookie_token_v2=account-token; account_id_v2=account'
      },
      timeoutMs: 1_000
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api-takumi-record.mihoyo.com/example',
      expect.objectContaining({
        credentials: 'omit',
        headers: expect.objectContaining({
          cookie: 'ltoken_v2=token; cookie_token_v2=account-token; account_id_v2=account'
        })
      })
    );
  });
});
