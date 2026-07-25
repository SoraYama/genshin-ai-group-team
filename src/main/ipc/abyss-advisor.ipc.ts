import type { BrowserWindow } from 'electron';
import { z } from 'zod';

import { abyssAdvisorPlanInputSchema } from '../../shared/abyss-advisor.js';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import { ABYSS_ADVISOR_EVENT_CHANNEL } from '../../shared/ipc-contract.js';
import type { AbyssAdvisorService } from '../services/abyss-advisor-service.js';
import type { AbyssScenarioService } from '../services/abyss-scenario-service.js';
import type { AgentRunTraceWriter } from '../services/agent-run-trace-store.js';
import { registerHandler } from './registry.js';

export interface AbyssAdvisorIpcDeps {
  scenario: Pick<AbyssScenarioService, 'getView'>;
  advisor: Pick<AbyssAdvisorService, 'recommend' | 'cancel'>;
  traceStore: Pick<AgentRunTraceWriter, 'latest'>;
  getMainWindow: () => BrowserWindow | undefined;
}

export function registerAbyssAdvisorIpc({
  scenario,
  advisor,
  traceStore,
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
    return advisor.recommend(parsed.data, (event) => {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(ABYSS_ADVISOR_EVENT_CHANNEL, { type: 'progress', ...event });
    });
  });

  registerHandler('advisor-v2:abyss-cancel', async (payload) => {
    const parsed = z.object({ correlationId: z.string().min(1).max(128) }).safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map(({ message }) => message).join('; ')
      );
    }
    return { ok: advisor.cancel(parsed.data.correlationId) };
  });

  registerHandler('advisor-v2:abyss-latest-trace', async () => traceStore.latest());
}
