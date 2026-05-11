import { ipcMain } from 'electron';
import type { IpcChannel, IpcContract } from '../../shared/ipc-contract.js';
import { ALL_IPC_CHANNELS } from '../../shared/ipc-contract.js';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';

export type Handler<C extends IpcChannel> = (
  req: IpcContract[C]['req']
) => Promise<IpcContract[C]['res']> | IpcContract[C]['res'];

const REGISTERED = new Set<IpcChannel>();

export function registerHandler<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  if (!ALL_IPC_CHANNELS.includes(channel)) {
    throw new Error(`Refusing to register unlisted IPC channel: ${channel}`);
  }

  if (REGISTERED.has(channel)) {
    throw new Error(`IPC channel already registered: ${channel}`);
  }

  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await handler(payload as IpcContract[C]['req']) };
    } catch (error) {
      if (error instanceof IpcError) {
        return { ok: false, error: error.toJSON() };
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        ok: false,
        error: { code: IpcErrorCodes.Internal, message }
      };
    }
  });

  REGISTERED.add(channel);
}

export function ensureAllChannelsRegistered(): void {
  const missing = ALL_IPC_CHANNELS.filter((channel) => !REGISTERED.has(channel));
  if (missing.length > 0) {
    throw new Error(`Some IPC channels are not registered: ${missing.join(', ')}`);
  }
}
