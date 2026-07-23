import { contextBridge, ipcRenderer } from 'electron';
import {
  ALL_IPC_CHANNELS,
  ADVISOR_EVENT_CHANNEL,
  ABYSS_ADVISOR_EVENT_CHANNEL,
  STYGIAN_ADVISOR_EVENT_CHANNEL,
  THEATER_ADVISOR_EVENT_CHANNEL,
  UPDATE_EVENT_CHANNEL
} from '../shared/ipc-contract.js';
import type { IpcChannel, IpcContract, RendererApi } from '../shared/ipc-contract.js';
import type { AbyssAdvisorEvent } from '../shared/abyss-advisor.js';
import type { StygianAdvisorEvent } from '../shared/stygian-advisor.js';
import type { TheaterAdvisorEvent } from '../shared/theater-advisor.js';
import type { AdvisorEvent, UpdateStatus } from '../shared/domain.js';

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

  const envelope = (await ipcRenderer.invoke(channel, payload)) as Envelope<IpcContract[C]['res']>;

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
  update: {
    getState: () => invoke('update:get-state', undefined),
    check: () => invoke('update:check', undefined),
    download: () => invoke('update:download', undefined),
    install: () => invoke('update:install', undefined),
    onEvent: (cb: (event: UpdateStatus) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: UpdateStatus) => cb(value);
      ipcRenderer.on(UPDATE_EVENT_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(UPDATE_EVENT_CHANNEL, handler);
      };
    }
  },
  miyoushe: {
    bind: (input) => invoke('miyoushe:bind', input),
    loginViaBrowser: () => invoke('miyoushe:login-via-browser', undefined),
    logout: () => invoke('miyoushe:logout', undefined),
    authState: () => invoke('miyoushe:auth-state', undefined),
    ping: (input) => invoke('miyoushe:ping', input)
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
  abyssAdvisor: {
    getScenario: () => invoke('advisor-v2:abyss-scenario', undefined),
    recommend: (input) => invoke('advisor-v2:abyss-plan', input),
    cancel: () => invoke('advisor-v2:abyss-cancel', undefined),
    onEvent: (cb: (event: AbyssAdvisorEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: AbyssAdvisorEvent) => cb(value);
      ipcRenderer.on(ABYSS_ADVISOR_EVENT_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(ABYSS_ADVISOR_EVENT_CHANNEL, handler);
      };
    }
  },
  stygianAdvisor: {
    getScenario: () => invoke('advisor-v2:stygian-scenario', undefined),
    recommend: (input) => invoke('advisor-v2:stygian-plan', input),
    cancel: (input) => invoke('advisor-v2:stygian-cancel', input),
    onEvent: (cb: (event: StygianAdvisorEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: StygianAdvisorEvent) => cb(value);
      ipcRenderer.on(STYGIAN_ADVISOR_EVENT_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(STYGIAN_ADVISOR_EVENT_CHANNEL, handler);
      };
    }
  },
  theaterAdvisor: {
    getScenario: () => invoke('advisor-v2:theater-scenario', undefined),
    recommend: (input) => invoke('advisor-v2:theater-plan', input),
    cancel: (input) => invoke('advisor-v2:theater-cancel', input),
    onEvent: (cb: (event: TheaterAdvisorEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: TheaterAdvisorEvent) => cb(value);
      ipcRenderer.on(THEATER_ADVISOR_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(THEATER_ADVISOR_EVENT_CHANNEL, handler);
    }
  },
  history: {
    list: (input) => invoke('history:list', input),
    delete: (input) => invoke('history:delete', input),
    listAbyss: (input) => invoke('history:abyss-list', input),
    deleteAbyss: (input) => invoke('history:abyss-delete', input),
    listStygian: (input) => invoke('history:stygian-list', input),
    deleteStygian: (input) => invoke('history:stygian-delete', input),
    listTheater: (input) => invoke('history:theater-list', input),
    deleteTheater: (input) => invoke('history:theater-delete', input),
    clear: (input) => invoke('history:clear', input)
  },
  scenario: {
    list: () => invoke('scenario:list', undefined),
    get: (input) => invoke('scenario:get', input),
    refresh: (input) => invoke('scenario:refresh', input)
  }
};

contextBridge.exposeInMainWorld('api', api);
