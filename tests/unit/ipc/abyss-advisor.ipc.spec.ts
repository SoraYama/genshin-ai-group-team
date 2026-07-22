import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
}));

vi.mock('../../../src/main/ipc/registry.js', () => ({
  registerHandler: (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) => {
    handlers.set(channel, handler);
  }
}));

import { registerAbyssAdvisorIpc } from '../../../src/main/ipc/abyss-advisor.ipc.js';
import { ABYSS_ADVISOR_EVENT_CHANNEL } from '../../../src/shared/ipc-contract.js';
import { abyssInput } from '../services/abyss-test-fixtures.js';

beforeEach(() => handlers.clear());

describe('abyss advisor IPC', () => {
  it('registers scenario, plan and cancel channels and emits semantic progress', async () => {
    const send = vi.fn();
    const scenario = { getView: vi.fn().mockResolvedValue({ status: 'unavailable' }) };
    const advisor = {
      recommend: vi.fn().mockImplementation(async (_input, progress) => {
        progress({ correlationId: 'abyss-test-request', step: 'reading-roster' });
        return {
          status: 'blocked',
          source: 'local-rules',
          issues: [],
          warnings: [],
          assumptions: []
        };
      }),
      cancel: vi.fn().mockReturnValue(true)
    };
    registerAbyssAdvisorIpc({
      scenario,
      advisor,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never
    });

    expect([...handlers.keys()]).toEqual([
      'advisor-v2:abyss-scenario',
      'advisor-v2:abyss-plan',
      'advisor-v2:abyss-cancel'
    ]);
    await handlers.get('advisor-v2:abyss-scenario')?.(undefined);
    expect(scenario.getView).toHaveBeenCalledOnce();
    await handlers.get('advisor-v2:abyss-plan')?.(abyssInput());
    expect(advisor.recommend).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(ABYSS_ADVISOR_EVENT_CHANNEL, {
      type: 'progress',
      correlationId: 'abyss-test-request',
      step: 'reading-roster'
    });
    await expect(handlers.get('advisor-v2:abyss-cancel')?.(undefined)).resolves.toEqual({
      ok: true
    });
  });

  it('rejects invalid UID and non-canonical character IDs before calling the service', async () => {
    const advisor = { recommend: vi.fn(), cancel: vi.fn() };
    registerAbyssAdvisorIpc({
      scenario: { getView: vi.fn() },
      advisor,
      getMainWindow: () => undefined
    });

    await expect(
      handlers.get('advisor-v2:abyss-plan')?.({
        ...abyssInput(),
        uid: '123',
        lockedCharacterIds: ['01001']
      })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_FAILED' });
    expect(advisor.recommend).not.toHaveBeenCalled();
  });
});
