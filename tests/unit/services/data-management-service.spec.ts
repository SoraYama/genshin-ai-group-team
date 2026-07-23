import { describe, expect, it, vi } from 'vitest';
import { DataManagementService } from '../../../src/main/services/data-management-service.js';

function createDeps() {
  const state = {
    profiles: {
      count: 2,
      sizeBytes: 512,
      updatedAt: '2026-07-23T00:00:00.000Z',
      fingerprint: 'p1'
    },
    scenarios: {
      count: 3,
      clearableCount: 2,
      sizeBytes: 1024,
      updatedAt: '2026-07-22T00:00:00.000Z',
      fingerprint: 's1'
    },
    history: { count: 4, sizeBytes: 2048, updatedAt: '2026-07-21T00:00:00.000Z' },
    historyToken: 'h1',
    hasKey: true,
    keyFingerprint: 'k1'
  };
  return {
    state,
    profiles: {
      getDataManagementSnapshot: vi.fn(() => state.profiles),
      clearAll: vi.fn(() => {
        state.profiles = { count: 0, sizeBytes: 20, fingerprint: 'p0' } as typeof state.profiles;
        return 2;
      })
    },
    scenarios: {
      getDataManagementSnapshot: vi.fn(async () => state.scenarios),
      clearDownloadedCache: vi.fn(async () => {
        state.scenarios = {
          ...state.scenarios,
          clearableCount: 0,
          sizeBytes: 0,
          fingerprint: 's0'
        };
        return 2;
      })
    },
    history: {
      getSummary: vi.fn(() => state.history),
      getChallengeScopeConfirmation: vi.fn(() => ({
        count: state.history.count,
        confirmationToken: state.historyToken
      })),
      removeChallengeScope: vi.fn(() => {
        state.history = { count: 0, sizeBytes: 20 } as typeof state.history;
        state.historyToken = 'h0';
        return 4;
      })
    },
    config: {
      getPublicView: vi.fn(() => ({
        hasApiKey: state.hasKey,
        baseUrl: 'https://example.test',
        model: 'model',
        customHeaderKeys: []
      })),
      getSecretFingerprint: vi.fn(() => state.keyFingerprint),
      clearApiKey: vi.fn(() => {
        state.hasKey = false;
        state.keyFingerprint = 'k0';
      })
    }
  };
}

describe('DataManagementService', () => {
  it('reports real counts and omits size when a store cannot calculate it', async () => {
    const deps = createDeps();
    deps.state.profiles.sizeBytes = undefined as never;
    const service = new DataManagementService(deps);
    await expect(service.getSummary()).resolves.toEqual({
      profiles: {
        count: 2,
        updatedAt: '2026-07-23T00:00:00.000Z'
      },
      scenarios: {
        count: 3,
        clearableCount: 2,
        sizeBytes: 1024,
        updatedAt: '2026-07-22T00:00:00.000Z'
      },
      history: {
        count: 4,
        sizeBytes: 2048,
        updatedAt: '2026-07-21T00:00:00.000Z'
      },
      serviceKey: { count: 1 }
    });
  });

  it('requires a one-time snapshot token and rejects same-count replacement', async () => {
    const deps = createDeps();
    const service = new DataManagementService(deps);
    const confirmation = await service.prepareClear('profiles');
    expect(confirmation.count).toBe(2);
    deps.state.profiles.fingerprint = 'p2';

    await expect(
      service.clear({
        scope: 'profiles',
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).rejects.toThrow(/changed/i);
    expect(deps.profiles.clearAll).not.toHaveBeenCalled();
  });

  it('clears each scope independently and never reuses a confirmation token', async () => {
    const deps = createDeps();
    const service = new DataManagementService(deps);
    const confirmation = await service.prepareClear('service-key');
    const request = {
      scope: 'service-key' as const,
      expectedCount: confirmation.count,
      confirmationToken: confirmation.confirmationToken
    };

    await expect(service.clear(request)).resolves.toMatchObject({
      removed: 1,
      summary: { serviceKey: { count: 0 } }
    });
    expect(deps.config.clearApiKey).toHaveBeenCalledOnce();
    await expect(service.clear(request)).rejects.toThrow(/expired/i);
  });
});
