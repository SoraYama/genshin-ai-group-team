import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
}));

vi.mock('../../../src/main/ipc/registry.js', () => ({
  registerHandler: (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) => {
    handlers.set(channel, handler);
  }
}));

import { registerStygianAdvisorIpc } from '../../../src/main/ipc/stygian-advisor.ipc.js';
import { STYGIAN_ADVISOR_EVENT_CHANNEL } from '../../../src/shared/ipc-contract.js';
import { stygianInput } from '../services/stygian-test-fixtures.js';

beforeEach(() => handlers.clear());

describe('Stygian advisor IPC', () => {
  it('registers scenario, plan and cancel channels and emits correlated semantic progress', async () => {
    const send = vi.fn();
    const scenario = { getView: vi.fn().mockResolvedValue({ status: 'unavailable' }) };
    const advisor = {
      recommend: vi.fn().mockImplementation(async (_input, progress) => {
        progress({ correlationId: 'stygian-test-request', step: 'allocating-parties' });
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
    registerStygianAdvisorIpc({
      scenario,
      advisor,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never
    });
    expect([...handlers.keys()]).toEqual([
      'advisor-v2:stygian-scenario',
      'advisor-v2:stygian-plan',
      'advisor-v2:stygian-cancel'
    ]);
    await handlers.get('advisor-v2:stygian-plan')?.(stygianInput());
    expect(send).toHaveBeenCalledWith(STYGIAN_ADVISOR_EVENT_CHANNEL, {
      type: 'progress',
      correlationId: 'stygian-test-request',
      step: 'allocating-parties'
    });
    await expect(
      handlers.get('advisor-v2:stygian-cancel')?.({ correlationId: 'stygian-test-request' })
    ).resolves.toEqual({
      ok: true
    });
    expect(advisor.cancel).toHaveBeenCalledWith('stygian-test-request');
  });

  it('normalizes player-facing reward copy and rejects non-canonical character IDs before service', async () => {
    const advisor = { recommend: vi.fn(), cancel: vi.fn() };
    registerStygianAdvisorIpc({
      scenario: { getView: vi.fn() },
      advisor,
      getMainWindow: () => undefined
    });
    await handlers.get('advisor-v2:stygian-plan')?.(stygianInput({ target: '冲高难奖励' }));
    expect(advisor.recommend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'high-reward' }),
      expect.any(Function)
    );
    await expect(
      handlers.get('advisor-v2:stygian-plan')?.({
        ...stygianInput(),
        excludedCharacterIds: ['01001']
      })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_FAILED' });
  });
});
