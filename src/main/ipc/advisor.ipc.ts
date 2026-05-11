import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import { ADVISOR_EVENT_CHANNEL } from '../../shared/ipc-contract.js';
import type { AdvisorEvent } from '../../shared/domain.js';
import type { AdvisorAgent } from '../services/advisor-agent.js';
import { registerHandler } from './registry.js';

const recommendSchema = z.object({
  uid: z.string().regex(/^\d{9}$/, 'UID 必须为 9 位数字'),
  enemyNames: z.array(z.string()).default([]),
  preference: z.string().optional()
});

const compareSchema = z.object({
  uid: z.string().regex(/^\d{9}$/, 'UID 必须为 9 位数字'),
  left: z.object({
    enemyNames: z.array(z.string()).default([]),
    preference: z.string().optional()
  }),
  right: z.object({
    enemyNames: z.array(z.string()).default([]),
    preference: z.string().optional()
  })
});

export interface AdvisorIpcDeps {
  advisor: AdvisorAgent;
  getMainWindow: () => BrowserWindow | undefined;
}

export function registerAdvisorIpc({ advisor, getMainWindow }: AdvisorIpcDeps): void {
  const emit = (event: AdvisorEvent): void => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(ADVISOR_EVENT_CHANNEL, event);
    }
  };

  registerHandler('advisor:recommend', async (payload) => {
    const parsed = recommendSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }

    try {
      return await advisor.recommend(parsed.data, emit);
    } catch (error) {
      if (error instanceof Error && error.message === 'cancelled') {
        throw new IpcError(IpcErrorCodes.Internal, '用户取消推荐');
      }
      throw error;
    }
  });

  registerHandler('advisor:compare', async (payload) => {
    const parsed = compareSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    try {
      return await advisor.compare(parsed.data, emit);
    } catch (error) {
      if (error instanceof Error && error.message === 'cancelled') {
        throw new IpcError(IpcErrorCodes.Internal, '用户取消对比');
      }
      throw error;
    }
  });

  registerHandler('advisor:cancel', async () => {
    const ok = advisor.cancel();
    return { ok };
  });
}
