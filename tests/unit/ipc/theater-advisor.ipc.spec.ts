import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
}));
vi.mock('../../../src/main/ipc/registry.js', () => ({
  registerHandler: (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) =>
    handlers.set(channel, handler)
}));

import { registerTheaterAdvisorIpc } from '../../../src/main/ipc/theater-advisor.ipc.js';
import { THEATER_ADVISOR_EVENT_CHANNEL } from '../../../src/shared/ipc-contract.js';
import { theaterInput } from '../services/theater-test-fixtures.js';

beforeEach(() => handlers.clear());

describe('Theater advisor IPC', () => {
  it('registers scenario, plan and cancel channels and emits correlated progress', async () => {
    const send = vi.fn();
    const advisor = {
      recommend: vi.fn().mockImplementation(async (_input, progress) => {
        progress({ correlationId: 'theater-test-request', step: 'planning-cast' });
        return { status: 'blocked' };
      }),
      cancel: vi.fn().mockReturnValue(true)
    };
    registerTheaterAdvisorIpc({
      scenario: { getView: vi.fn().mockResolvedValue({ status: 'unavailable' }) },
      advisor,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never
    });
    expect([...handlers.keys()]).toEqual([
      'advisor-v2:theater-scenario',
      'advisor-v2:theater-plan',
      'advisor-v2:theater-cancel'
    ]);
    await handlers.get('advisor-v2:theater-plan')?.(theaterInput({ target: '稳妥通关' }));
    expect(advisor.recommend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'safe-clear' }),
      expect.any(Function)
    );
    expect(send).toHaveBeenCalledWith(THEATER_ADVISOR_EVENT_CHANNEL, {
      type: 'progress',
      correlationId: 'theater-test-request',
      step: 'planning-cast'
    });
    await expect(
      handlers.get('advisor-v2:theater-cancel')?.({ correlationId: 'theater-test-request' })
    ).resolves.toEqual({ ok: true });
  });

  it('rejects non-canonical owned IDs before reaching the service', async () => {
    const advisor = { recommend: vi.fn(), cancel: vi.fn() };
    registerTheaterAdvisorIpc({
      scenario: { getView: vi.fn() },
      advisor,
      getMainWindow: () => undefined
    });
    await expect(
      handlers.get('advisor-v2:theater-plan')?.({
        ...theaterInput(),
        selectedCharacterIds: ['01001']
      })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_FAILED' });
    expect(advisor.recommend).not.toHaveBeenCalled();
  });
});
