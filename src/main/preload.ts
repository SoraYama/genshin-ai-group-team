import { contextBridge, ipcRenderer } from 'electron';
import { ALL_IPC_CHANNELS, ADVISOR_EVENT_CHANNEL } from '../shared/ipc-contract.js';
import type { IpcChannel, IpcContract, RendererApi } from '../shared/ipc-contract.js';
import type { AdvisorEvent } from '../shared/domain.js';

interface IpcEnvelope<T> {
  ok: true;
  data: T;
}

interface IpcErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
}

type Envelope<T> = IpcEnvelope<T> | IpcErrorEnvelope;

async function invoke<C extends IpcChannel>(
  channel: C,
  payload: IpcContract[C]['req']
): Promise<IpcContract[C]['res']> {
  if (!ALL_IPC_CHANNELS.includes(channel)) {
    throw new Error(`Channel not in whitelist: ${channel}`);
  }

  const envelope = (await ipcRenderer.invoke(channel, payload)) as Envelope<
    IpcContract[C]['res']
  >;

  if (!envelope.ok) {
    const error = new Error(envelope.error.message) as Error & { code?: string };
    error.code = envelope.error.code;
    throw error;
  }

  return envelope.data;
}

const api: RendererApi = {
  config: {
    getPublic: () => invoke('config:get-public', undefined),
    setLlm: (input: IpcContract['config:set-llm']['req']) => invoke('config:set-llm', input),
    testLlm: () => invoke('config:test-llm', undefined),
    clearLlm: () => invoke('config:clear-llm', undefined)
  },
  miyoushe: {
    bind: (input) => invoke('miyoushe:bind', input),
    loginViaBrowser: () => invoke('miyoushe:login-via-browser', undefined)
  },
  profile: {
    state: () => invoke('profile:state', undefined),
    get: (input) => invoke('profile:get', input),
    setActive: (input) => invoke('profile:set-active', input),
    refresh: (input) => invoke('profile:refresh', input),
    importFromCookie: (input) => invoke('profile:import-from-cookie', input),
    importFromSession: (input) => invoke('profile:import-from-session', input),
    delete: (input) => invoke('profile:delete', input)
  },
  advisor: {
    recommend: (input) => invoke('advisor:recommend', input),
    compare: (input) => invoke('advisor:compare', input),
    cancel: () => invoke('advisor:cancel', undefined),
    onEvent: (cb: (event: AdvisorEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: AdvisorEvent) => cb(value);
      ipcRenderer.on(ADVISOR_EVENT_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(ADVISOR_EVENT_CHANNEL, handler);
      };
    }
  },
  history: {
    list: (input) => invoke('history:list', input),
    delete: (input) => invoke('history:delete', input),
    clear: (input) => invoke('history:clear', input)
  }
};

contextBridge.exposeInMainWorld('api', api);
