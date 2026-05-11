import { describe, expect, it, vi, beforeEach } from 'vitest';

const electronStoreState = new Map<string, unknown>();

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.0-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc::${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc::/, '')
  }
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      if (opts.defaults) {
        for (const [key, value] of Object.entries(opts.defaults)) {
          if (!electronStoreState.has(key)) {
            electronStoreState.set(key, value);
          }
        }
      }
    }
    get(key: string) {
      return electronStoreState.get(key);
    }
    set(key: string, value: unknown) {
      electronStoreState.set(key, value);
    }
  }
}));

beforeEach(() => {
  electronStoreState.clear();
});

describe('ConfigService', () => {
  it('round-trips an api key through safeStorage encryption', async () => {
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();

    config.setLlm({ apiKey: 'sk-test-123' });

    expect(config.getPublicView().hasApiKey).toBe(true);
    expect(config.getApiKey()).toBe('sk-test-123');
  });

  it('persists baseUrl and model overrides', async () => {
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();

    config.setLlm({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com',
      model: 'claude-test-9'
    });

    const view = config.getPublicView();
    expect(view.baseUrl).toBe('https://example.com');
    expect(view.model).toBe('claude-test-9');
  });

  it('falls back to defaults after clearLlm', async () => {
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();

    config.setLlm({ apiKey: 'sk-test', baseUrl: 'https://example.com' });
    config.clearLlm();

    const view = config.getPublicView();
    expect(view.hasApiKey).toBe(false);
    expect(view.baseUrl).toBe('https://api.anthropic.com');
    expect(config.getApiKey()).toBeUndefined();
  });

  it('does not overwrite existing key when called with empty apiKey', async () => {
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();

    config.setLlm({ apiKey: 'sk-original' });
    config.setLlm({ apiKey: '', model: 'claude-changed' });

    expect(config.getApiKey()).toBe('sk-original');
    expect(config.getModel()).toBe('claude-changed');
  });
});
