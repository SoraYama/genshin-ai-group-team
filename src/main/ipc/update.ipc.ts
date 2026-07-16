import type { UpdateService } from '../services/update-service.js';
import { registerHandler } from './registry.js';

export function registerUpdateIpc(update: UpdateService): void {
  registerHandler('update:get-state', () => update.getState());
  registerHandler('update:check', async () => {
    await update.check();
    return { ok: true };
  });
  registerHandler('update:download', async () => {
    await update.download();
    return { ok: true };
  });
  registerHandler('update:install', () => {
    update.install();
    return { ok: true };
  });
}
