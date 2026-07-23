import type { BrowserWindow } from 'electron';
import { z } from 'zod';

import { theaterAdvisorPlanInputSchema } from '../../shared/theater-advisor.js';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import { THEATER_ADVISOR_EVENT_CHANNEL } from '../../shared/ipc-contract.js';
import type { TheaterAdvisorService } from '../services/theater-advisor-service.js';
import type { TheaterScenarioService } from '../services/theater-scenario-service.js';
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

export interface TheaterAdvisorIpcDeps {
  scenario: Pick<TheaterScenarioService, 'getView'>;
  advisor: Pick<TheaterAdvisorService, 'recommend' | 'cancel'>;
  getMainWindow: () => BrowserWindow | undefined;
}

export function registerTheaterAdvisorIpc({
  scenario,
  advisor,
  getMainWindow
}: TheaterAdvisorIpcDeps): void {
  registerHandler('advisor-v2:theater-scenario', async () => scenario.getView());
  registerHandler('advisor-v2:theater-plan', async (payload) => {
    const parsed = theaterAdvisorPlanInputSchema.safeParse(payload);
    if (!parsed.success)
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map(({ message }) => message).join('; ')
      );
    return advisor.recommend(parsed.data, (event) => {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(THEATER_ADVISOR_EVENT_CHANNEL, { type: 'progress', ...event });
    });
  });
  registerHandler('advisor-v2:theater-cancel', async (payload) => {
    const parsed = cancelSchema.safeParse(payload);
    if (!parsed.success)
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map(({ message }) => message).join('; ')
      );
    return { ok: advisor.cancel(parsed.data.correlationId) };
  });
}
