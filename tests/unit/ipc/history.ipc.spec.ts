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
});
