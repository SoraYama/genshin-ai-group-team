import { describe, expect, it, vi, beforeEach } from 'vitest';

const electronStoreState = new Map<string, unknown>();
let encryptionAvailable = true;

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
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
  encryptionAvailable = true;
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

  it('encrypts custom header values and only exposes their names publicly', async () => {
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();

    config.setLlm({ customHeaders: { 'X-Api-Key': 'header-secret' } });

    expect(config.getCustomHeaders()).toEqual({ 'X-Api-Key': 'header-secret' });
    expect(config.getPublicView().customHeaderKeys).toEqual(['X-Api-Key']);
    expect(JSON.stringify(electronStoreState.get('llm'))).not.toContain('header-secret');
  });

  it('migrates legacy plaintext custom headers to encrypted storage', async () => {
    electronStoreState.set('llm', {
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
      customHeaders: { Authorization: 'legacy-secret' }
    });
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();

    expect(config.getCustomHeaders()).toEqual({ Authorization: 'legacy-secret' });
    const stored = electronStoreState.get('llm') as Record<string, unknown>;
    expect(stored.customHeaders).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('legacy-secret');
  });

  it('clears encrypted custom headers when replaced with an empty map', async () => {
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();
    config.setLlm({ customHeaders: { Authorization: 'secret' } });

    config.setLlm({ customHeaders: {} });

    expect(config.getCustomHeaders()).toEqual({});
    expect(config.getPublicView().customHeaderKeys).toEqual([]);
  });

  it('does not expose legacy header values while safeStorage is unavailable', async () => {
    electronStoreState.set('llm', {
      customHeaders: { Authorization: 'legacy-secret' }
    });
    encryptionAvailable = false;
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();

    expect(config.getCustomHeaders()).toEqual({});
    expect(config.getPublicView().customHeaderKeys).toEqual(['Authorization']);
  });

  it('accumulates only non-negative monthly SDK usage', async () => {
    const { ConfigService } = await import('../../../src/main/services/config-service.js');
    const config = new ConfigService();
    config.recordUsage(100, 20, 0.01);
    config.recordUsage(50, -1, 0.005);
    expect(config.getPublicConfig().monthlyUsage).toMatchObject({
      month: new Date().toISOString().slice(0, 7),
      inputTokens: 150,
      outputTokens: 20,
      estimatedCostUsd: 0.015
    });
  });
});
