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
    guideResearch: {
      count: 2,
      sizeBytes: 768,
      updatedAt: '2026-07-24T00:00:00.000Z',
      fingerprint: 'g1'
    },
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
      getChallengeScopeSnapshot: vi.fn(() => ({
        count: state.history.count,
        fingerprint: state.historyToken
      })),
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
    guideResearch: {
      getDataManagementSnapshot: vi.fn(async () => state.guideResearch),
      clearAll: vi.fn(async () => {
        const removed = state.guideResearch.count;
        state.guideResearch = {
          count: 0,
          sizeBytes: 0,
          fingerprint: 'g0'
        } as typeof state.guideResearch;
        return removed;
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
      guideResearch: {
        count: 2,
        sizeBytes: 768,
        updatedAt: '2026-07-24T00:00:00.000Z'
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
    await expect(service.clear(request)).rejects.toMatchObject({
      code: 'DATA_CONFIRMATION_EXPIRED'
    });
  });

  it('passes the confirmed scenario snapshot into the serialized clear operation', async () => {
    const deps = createDeps();
    const service = new DataManagementService(deps);
    const confirmation = await service.prepareClear('scenarios');

    await service.clear({
      scope: 'scenarios',
      expectedCount: confirmation.count,
      confirmationToken: confirmation.confirmationToken
    });

    expect(deps.scenarios.clearDownloadedCache).toHaveBeenCalledWith({
      count: 2,
      fingerprint: 's1'
    });
    expect(deps.guideResearch.clearAll).toHaveBeenCalledWith({
      count: 2,
      fingerprint: 'g1'
    });
  });

  it('clears the guide cache with scenarios and reports only aggregate metadata', async () => {
    const deps = createDeps();
    const service = new DataManagementService(deps);
    const summary = await service.getSummary();
    expect(summary.guideResearch).toEqual({
      count: 2,
      sizeBytes: 768,
      updatedAt: '2026-07-24T00:00:00.000Z'
    });
    expect(JSON.stringify(summary)).not.toContain('https://');
    const confirmation = await service.prepareClear('scenarios');
    expect(confirmation.count).toBe(4);

    await expect(
      service.clear({
        scope: 'scenarios',
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).resolves.toMatchObject({
      removed: 4,
      summary: { guideResearch: { count: 0, sizeBytes: 0 } }
    });
  });

  it('prepares and clears scenarios when the guide cache file is missing', async () => {
    const deps = createDeps();
    deps.state.guideResearch = {
      count: 0,
      sizeBytes: 0,
      fingerprint: 'guide-cache-missing'
    } as typeof deps.state.guideResearch;
    const service = new DataManagementService(deps);

    const confirmation = await service.prepareClear('scenarios');
    expect(confirmation.count).toBe(2);
    await expect(
      service.clear({
        scope: 'scenarios',
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).resolves.toMatchObject({ removed: 2 });
    expect(deps.guideResearch.clearAll).toHaveBeenCalledWith({
      count: 0,
      fingerprint: 'guide-cache-missing'
    });
  });

  it('does not prepare scenario deletion when any managed file is unreadable', async () => {
    const deps = createDeps();
    deps.state.scenarios.sizeBytes = undefined as never;
    const service = new DataManagementService(deps);

    await expect(service.prepareClear('scenarios')).rejects.toMatchObject({
      code: 'DATA_FILE_INSPECTION_FAILED'
    });
    expect(deps.scenarios.clearDownloadedCache).not.toHaveBeenCalled();
  });

  it('turns a scenario fingerprint change into a stable selection-changed error', async () => {
    const deps = createDeps();
    const service = new DataManagementService(deps);
    const confirmation = await service.prepareClear('scenarios');
    deps.scenarios.clearDownloadedCache.mockRejectedValueOnce(
      Object.assign(new Error('Scenario fingerprint changed at /private/cache'), {
        code: 'SCENARIO_SELECTION_CHANGED'
      })
    );

    await expect(
      service.clear({
        scope: 'scenarios',
        expectedCount: confirmation.count,
        confirmationToken: confirmation.confirmationToken
      })
    ).rejects.toMatchObject({ code: 'DATA_SELECTION_CHANGED' });
  });
});
