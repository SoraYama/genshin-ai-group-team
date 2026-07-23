import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
}));

vi.mock('../../../src/main/ipc/registry.js', () => ({
  registerHandler: (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) => {
    handlers.set(channel, handler);
  }
}));

import { registerHistoryIpc } from '../../../src/main/ipc/history.ipc.js';

beforeEach(() => handlers.clear());

describe('history IPC abyss plans', () => {
  it('lists and deletes the separate immutable abyss history collection', async () => {
    const history = {
      query: vi.fn(),
      removeById: vi.fn(),
      removeMany: vi.fn(),
      queryAbyss: vi.fn().mockReturnValue([{ id: 'abyss-history-id' }]),
      removeAbyssById: vi.fn().mockReturnValue(true),
      queryStygian: vi.fn().mockReturnValue([{ id: 'stygian-history-id' }]),
      removeStygianById: vi.fn().mockReturnValue(true)
    };
    registerHistoryIpc({ history: history as never });

    await expect(handlers.get('history:abyss-list')?.({ uid: '123456789' })).resolves.toEqual([
      { id: 'abyss-history-id' }
    ]);
    expect(history.queryAbyss).toHaveBeenCalledWith({ uid: '123456789' });
    await expect(
      handlers.get('history:abyss-delete')?.({ id: 'abyss-history-id' })
    ).resolves.toEqual({ ok: true });
    expect(history.removeAbyssById).toHaveBeenCalledWith('abyss-history-id');
    await expect(handlers.get('history:stygian-list')?.({ uid: '123456789' })).resolves.toEqual([
      { id: 'stygian-history-id' }
    ]);
    expect(history.queryStygian).toHaveBeenCalledWith({ uid: '123456789' });
    await expect(
      handlers.get('history:stygian-delete')?.({ id: 'stygian-history-id' })
    ).resolves.toEqual({ ok: true });
    expect(history.removeStygianById).toHaveBeenCalledWith('stygian-history-id');
  });

  it('requires an explicit scope and expected count for destructive group or all-history removal', async () => {
    const history = {
      query: vi.fn(),
      removeById: vi.fn(),
      removeMany: vi.fn(),
      queryAbyss: vi.fn().mockReturnValue([]),
      removeAbyssById: vi.fn(),
      queryStygian: vi.fn().mockReturnValue([]),
      removeStygianById: vi.fn(),
      queryTheater: vi.fn().mockReturnValue([]),
      removeTheaterById: vi.fn(),
      getChallengeScopeConfirmation: vi.fn().mockReturnValue({
        count: 3,
        confirmationToken: 'opaque-confirmation-token'
      }),
      removeChallengeScope: vi.fn().mockReturnValue(3)
    };
    registerHistoryIpc({ history: history as never });

    await expect(
      handlers.get('history:prepare-delete-scope')?.({
        scope: 'group',
        uid: '123456789',
        mode: 'spiral-abyss',
        scenarioId: 'abyss.2026-07'
      })
    ).resolves.toEqual({ count: 3, confirmationToken: 'opaque-confirmation-token' });
    await expect(
      handlers.get('history:delete-scope')?.({
        scope: 'group',
        uid: '123456789',
        mode: 'spiral-abyss',
        scenarioId: 'abyss.2026-07',
        expectedCount: 3,
        confirmationToken: 'opaque-confirmation-token'
      })
    ).resolves.toEqual({ removed: 3 });
    expect(history.removeChallengeScope).toHaveBeenCalledWith({
      scope: 'group',
      uid: '123456789',
      mode: 'spiral-abyss',
      scenarioId: 'abyss.2026-07',
      expectedCount: 3,
      confirmationToken: 'opaque-confirmation-token'
    });

    await expect(handlers.get('history:delete-scope')?.({ scope: 'all' })).rejects.toMatchObject({
      code: 'IPC_VALIDATION_FAILED'
    });
  });
});
