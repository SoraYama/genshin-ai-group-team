import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
}));

vi.mock('../../../src/main/ipc/registry.js', () => ({
  registerHandler: (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) => {
    handlers.set(channel, handler);
  }
}));

import { registerDataManagementIpc } from '../../../src/main/ipc/data-management.ipc.js';

beforeEach(() => handlers.clear());

describe('data management IPC', () => {
  it('preserves stable data-management error meaning without forwarding service messages', async () => {
    const service = {
      getSummary: vi.fn(),
      prepareClear: vi.fn().mockRejectedValue(
        Object.assign(new Error('Scenario files at /private/path could not be fully inspected'), {
          code: 'DATA_FILE_INSPECTION_FAILED'
        })
      ),
      clear: vi.fn().mockRejectedValue(
        Object.assign(new Error('Clear confirmation expired; token abc'), {
          code: 'DATA_CONFIRMATION_EXPIRED'
        })
      )
    };
    registerDataManagementIpc({ service: service as never });

    await expect(
      handlers.get('data-management:prepare-clear')?.({ scope: 'scenarios' })
    ).rejects.toMatchObject({
      code: 'IPC_FILE_INSPECTION_FAILED',
      message: 'Data management request failed'
    });
    await expect(
      handlers.get('data-management:clear')?.({
        scope: 'profiles',
        expectedCount: 1,
        confirmationToken: 'confirmation-token'
      })
    ).rejects.toMatchObject({
      code: 'IPC_CONFIRMATION_EXPIRED',
      message: 'Data management request failed'
    });
  });

  it('validates explicit scopes, passes opaque tokens, and allowlists public summary fields', async () => {
    const summaryWithPrivateFields = {
      profiles: { count: 0, fingerprint: 'private-profile-fingerprint' },
      scenarios: {
        count: 2,
        clearableCount: 1,
        sizeBytes: 128,
        fingerprint: 'private-scenario-fingerprint'
      },
      history: { count: 0, fingerprint: 'private-history-fingerprint' },
      guideResearch: {
        count: 3,
        sizeBytes: 96,
        fingerprint: 'private-guide-fingerprint',
        privateContents: 'https://secret.example/raw-guide'
      },
      serviceKey: { count: 1, fingerprint: 'private-key-fingerprint' }
    };
    const service = {
      getSummary: vi.fn().mockResolvedValue(summaryWithPrivateFields),
      prepareClear: vi
        .fn()
        .mockResolvedValue({ count: 2, confirmationToken: 'confirmation-token' }),
      clear: vi.fn().mockResolvedValue({ removed: 2, summary: summaryWithPrivateFields })
    };
    registerDataManagementIpc({ service: service as never });

    await expect(handlers.get('data-management:summary')?.(undefined)).resolves.toEqual({
      profiles: { count: 0 },
      scenarios: { count: 2, clearableCount: 1, sizeBytes: 128 },
      history: { count: 0 },
      guideResearch: { count: 3, sizeBytes: 96 },
      serviceKey: { count: 1 }
    });
    await expect(
      handlers.get('data-management:prepare-clear')?.({ scope: 'profiles' })
    ).resolves.toEqual({ count: 2, confirmationToken: 'confirmation-token' });
    await expect(
      handlers.get('data-management:clear')?.({
        scope: 'profiles',
        expectedCount: 2,
        confirmationToken: 'confirmation-token'
      })
    ).resolves.toEqual({
      removed: 2,
      summary: {
        profiles: { count: 0 },
        scenarios: { count: 2, clearableCount: 1, sizeBytes: 128 },
        history: { count: 0 },
        guideResearch: { count: 3, sizeBytes: 96 },
        serviceKey: { count: 1 }
      }
    });
    await expect(
      handlers.get('data-management:clear')?.({
        scope: 'everything',
        expectedCount: 2,
        confirmationToken: 'confirmation-token'
      })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_FAILED' });
  });
});
