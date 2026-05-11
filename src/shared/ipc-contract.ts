import type {
  AdvisorCompareRequest,
  AdvisorCompareResult,
  AdvisorEvent,
  AdvisorRequest,
  BindCookieResult,
  HistoryQueryOptions,
  HistoryQueryResult,
  LlmConfigInput,
  LlmHealthReport,
  PersistedProfile,
  ProfileStateView,
  PublicConfig,
  RecommendationResult
} from './domain.js';

export const ADVISOR_EVENT_CHANNEL = 'advisor:event' as const;

export interface IpcContract {
  'config:get-public': { req: void; res: PublicConfig };
  'config:set-llm': { req: LlmConfigInput; res: { ok: true } };
  'config:test-llm': { req: void; res: LlmHealthReport };
  'config:clear-llm': { req: void; res: { ok: true } };

  'miyoushe:bind': { req: { cookie: string }; res: BindCookieResult };
  'miyoushe:login-via-browser': {
    req: void;
    res:
      | { ok: true; bind: BindCookieResult; sessionId: string }
      | { ok: false; reason: 'cancelled' | 'timeout' | 'load-failed' | 'bind-failed'; message?: string };
  };

  'profile:state': { req: void; res: ProfileStateView };
  'profile:get': { req: { uid: string }; res: PersistedProfile | null };
  'profile:set-active': { req: { uid: string }; res: { ok: true } };
  'profile:refresh': { req: { uid: string }; res: PersistedProfile };
  'profile:import-from-cookie': {
    req: { cookie: string; uid?: string };
    res: PersistedProfile;
  };
  'profile:import-from-session': {
    req: { sessionId: string; uid?: string };
    res: PersistedProfile;
  };
  'profile:delete': { req: { uid: string }; res: { ok: true } };

  'advisor:recommend': { req: AdvisorRequest; res: RecommendationResult };
  'advisor:compare': { req: AdvisorCompareRequest; res: AdvisorCompareResult };
  'advisor:cancel': { req: void; res: { ok: boolean } };

  'history:list': { req: HistoryQueryOptions; res: HistoryQueryResult };
  'history:delete': { req: { id: string }; res: { ok: boolean } };
  'history:clear': {
    req: { uid?: string; source?: 'llm' | 'fallback'; enemyKeyword?: string };
    res: { removed: number };
  };
}

export type IpcChannel = keyof IpcContract;

export type IpcRequest<C extends IpcChannel> = IpcContract[C]['req'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['res'];

export const ALL_IPC_CHANNELS: IpcChannel[] = [
  'config:get-public',
  'config:set-llm',
  'config:test-llm',
  'config:clear-llm',
  'miyoushe:bind',
  'miyoushe:login-via-browser',
  'profile:state',
  'profile:get',
  'profile:set-active',
  'profile:refresh',
  'profile:import-from-cookie',
  'profile:import-from-session',
  'profile:delete',
  'advisor:recommend',
  'advisor:compare',
  'advisor:cancel',
  'history:list',
  'history:delete',
  'history:clear'
];

export interface RendererApi {
  config: {
    getPublic: () => Promise<IpcResponse<'config:get-public'>>;
    setLlm: (input: IpcRequest<'config:set-llm'>) => Promise<IpcResponse<'config:set-llm'>>;
    testLlm: () => Promise<IpcResponse<'config:test-llm'>>;
    clearLlm: () => Promise<IpcResponse<'config:clear-llm'>>;
  };
  miyoushe: {
    bind: (input: IpcRequest<'miyoushe:bind'>) => Promise<IpcResponse<'miyoushe:bind'>>;
    loginViaBrowser: () => Promise<IpcResponse<'miyoushe:login-via-browser'>>;
  };
  profile: {
    state: () => Promise<IpcResponse<'profile:state'>>;
    get: (input: IpcRequest<'profile:get'>) => Promise<IpcResponse<'profile:get'>>;
    setActive: (input: IpcRequest<'profile:set-active'>) => Promise<IpcResponse<'profile:set-active'>>;
    refresh: (input: IpcRequest<'profile:refresh'>) => Promise<IpcResponse<'profile:refresh'>>;
    importFromCookie: (
      input: IpcRequest<'profile:import-from-cookie'>
    ) => Promise<IpcResponse<'profile:import-from-cookie'>>;
    importFromSession: (
      input: IpcRequest<'profile:import-from-session'>
    ) => Promise<IpcResponse<'profile:import-from-session'>>;
    delete: (input: IpcRequest<'profile:delete'>) => Promise<IpcResponse<'profile:delete'>>;
  };
  advisor: {
    recommend: (input: IpcRequest<'advisor:recommend'>) => Promise<IpcResponse<'advisor:recommend'>>;
    compare: (input: IpcRequest<'advisor:compare'>) => Promise<IpcResponse<'advisor:compare'>>;
    cancel: () => Promise<IpcResponse<'advisor:cancel'>>;
    onEvent: (cb: (event: AdvisorEvent) => void) => () => void;
  };
  history: {
    list: (input: IpcRequest<'history:list'>) => Promise<IpcResponse<'history:list'>>;
    delete: (input: IpcRequest<'history:delete'>) => Promise<IpcResponse<'history:delete'>>;
    clear: (input: IpcRequest<'history:clear'>) => Promise<IpcResponse<'history:clear'>>;
  };
}
