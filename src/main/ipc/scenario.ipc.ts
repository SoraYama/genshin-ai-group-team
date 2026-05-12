import { z } from 'zod';
import type { ScenarioMode } from '../../shared/domain.js';
import { ALL_SCENARIO_MODES } from '../../shared/domain.js';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import type { ScenarioStore } from '../services/scenario-store.js';
import type { ScenarioRefresher } from '../services/scenario-refresher.js';
import { registerHandler } from './registry.js';

const modeSchema = z.object({
  mode: z.enum(ALL_SCENARIO_MODES as [ScenarioMode, ...ScenarioMode[]])
});

const refreshSchema = z.object({
  mode: z.enum(ALL_SCENARIO_MODES as [ScenarioMode, ...ScenarioMode[]]).optional(),
  force: z.boolean().optional()
});

export interface ScenarioIpcDeps {
  store: ScenarioStore;
  refresher: ScenarioRefresher;
}

export function registerScenarioIpc({ store, refresher }: ScenarioIpcDeps): void {
  registerHandler('scenario:list', async () => store.list());

  registerHandler('scenario:get', async (payload) => {
    const parsed = modeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((i) => i.message).join('; ')
      );
    }
    try {
      return store.getScenario(parsed.data.mode);
    } catch (error) {
      throw new IpcError(
        IpcErrorCodes.Internal,
        error instanceof Error ? error.message : 'scenario not loaded'
      );
    }
  });

  registerHandler('scenario:refresh', async (payload) => {
    const parsed = refreshSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((i) => i.message).join('; ')
      );
    }
    if (parsed.data.force) {
      // Force-run the refresher inline; otherwise queue a one-off via the store.
      await refresher.runOnce();
    }
    const refreshed = await store.refresh(parsed.data);
    return { refreshed };
  });
}
