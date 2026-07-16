import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCookies = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {
    fromPartition: vi.fn(() => ({
      cookies: { get: getCookies }
    }))
  }
}));

import { MiyousheLoginWindow } from '../../../src/main/services/miyoushe-login-window.js';

describe('MiyousheLoginWindow persisted cookie projection', () => {
  beforeEach(() => {
    getCookies.mockReset();
  });

  it('keeps verification credentials in main while excluding unrelated cookies', async () => {
    getCookies.mockResolvedValue([
      { name: 'ltoken_v2', value: 'token-v2' },
      { name: 'ltuid_v2', value: 'uid-v2' },
      { name: 'ltmid_v2', value: 'mid-v2' },
      { name: 'account_id_v2', value: 'account-v2' },
      { name: 'cookie_token_v2', value: 'cookie-token-v2' },
      { name: '_MHYUUID', value: 'device-id' },
      { name: 'DEVICEFP', value: 'device-fp' },
      { name: 'acw_tc', value: 'unrelated' }
    ]);

    const cookie = await new MiyousheLoginWindow('persist:test').readPersistedCookie();

    expect(cookie).toContain('cookie_token_v2=cookie-token-v2');
    expect(cookie).toContain('account_id_v2=account-v2');
    expect(cookie).toContain('_MHYUUID=device-id');
    expect(cookie).not.toContain('acw_tc');
  });
});
