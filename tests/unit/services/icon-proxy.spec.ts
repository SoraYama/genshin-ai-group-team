import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/gta-icon-test') },
  net: { fetch: vi.fn() },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn()
  }
}));

describe('calculator icon proxy URL', () => {
  it('round-trips an allowlisted MiHoYo PNG through gtai-img', async () => {
    const { resolveProxyUpstreamUrl, rewriteIconToProxyUrl } = await import(
      '../../../src/main/services/icon-proxy.js'
    );
    const upstream =
      'https://act-webstatic.mihoyo.com/hk4e/e20200928calculate/item_icon/rev/icon.png';

    const proxied = rewriteIconToProxyUrl(upstream);

    expect(proxied).toMatch(/^gtai-img:\/\/remote\/[A-Za-z0-9_-]+$/);
    expect(resolveProxyUpstreamUrl(proxied)).toBe(upstream);
  });

  it('does not proxy an arbitrary remote origin', async () => {
    const { resolveProxyUpstreamUrl, rewriteIconToProxyUrl } = await import(
      '../../../src/main/services/icon-proxy.js'
    );
    const untrusted = 'https://attacker.example/icon.png';

    expect(rewriteIconToProxyUrl(untrusted)).toBe(untrusted);
    expect(resolveProxyUpstreamUrl('gtai-img://remote/aHR0cHM6Ly9hdHRhY2tlci5leGFtcGxl')).toBeUndefined();
  });
});
