import type { BrowserWindow } from 'electron';
import { z } from 'zod';

import { stygianAdvisorPlanInputSchema } from '../../shared/stygian-advisor.js';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import { STYGIAN_ADVISOR_EVENT_CHANNEL } from '../../shared/ipc-contract.js';
import type { StygianAdvisorService } from '../services/stygian-advisor-service.js';
import type { StygianScenarioService } from '../services/stygian-scenario-service.js';
import { registerHandler } from './registry.js';

const cancelSchema = z
  .object({
    correlationId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
  })
  .strict();

export interface StygianAdvisorIpcDeps {
  scenario: Pick<StygianScenarioService, 'getView'>;
  advisor: Pick<StygianAdvisorService, 'recommend' | 'cancel'>;
  getMainWindow: () => BrowserWindow | undefined;
}

export function registerStygianAdvisorIpc({
  scenario,
  advisor,
  getMainWindow
}: StygianAdvisorIpcDeps): void {
  registerHandler('advisor-v2:stygian-scenario', async () => scenario.getView());
  registerHandler('advisor-v2:stygian-plan', async (payload) => {
    const parsed = stygianAdvisorPlanInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map(({ message }) => message).join('; ')
      );
    }
    return advisor.recommend(parsed.data, (event) => {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(STYGIAN_ADVISOR_EVENT_CHANNEL, { type: 'progress', ...event });
    });
  });
  registerHandler('advisor-v2:stygian-cancel', async (payload) => {
    const parsed = cancelSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map(({ message }) => message).join('; ')
      );
    }
    return { ok: advisor.cancel(parsed.data.correlationId) };
  });
}
