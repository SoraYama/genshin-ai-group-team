import type { BrowserWindow } from 'electron';

import { abyssAdvisorPlanInputSchema } from '../../shared/abyss-advisor.js';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import { ABYSS_ADVISOR_EVENT_CHANNEL } from '../../shared/ipc-contract.js';
import type { AbyssAdvisorService } from '../services/abyss-advisor-service.js';
import type { AbyssScenarioService } from '../services/abyss-scenario-service.js';
import { registerHandler } from './registry.js';

export interface AbyssAdvisorIpcDeps {
  scenario: Pick<AbyssScenarioService, 'getView'>;
  advisor: Pick<AbyssAdvisorService, 'recommend' | 'cancel'>;
  getMainWindow: () => BrowserWindow | undefined;
}

export function registerAbyssAdvisorIpc({
  scenario,
  advisor,
  getMainWindow
}: AbyssAdvisorIpcDeps): void {
  registerHandler('advisor-v2:abyss-scenario', async () => scenario.getView());

  registerHandler('advisor-v2:abyss-plan', async (payload) => {
    const parsed = abyssAdvisorPlanInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map(({ message }) => message).join('; ')
      );
    }
    return advisor.recommend(parsed.data, (step) => {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(ABYSS_ADVISOR_EVENT_CHANNEL, { type: 'progress', step });
    });
  });

  registerHandler('advisor-v2:abyss-cancel', async () => ({ ok: advisor.cancel() }));
}
