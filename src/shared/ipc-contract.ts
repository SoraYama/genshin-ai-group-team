import type {
  AdvisorCompareRequest,
  AdvisorCompareResult,
  AdvisorEvent,
  AdvisorRequest,
  AbyssPlanHistoryEntry,
  StygianPlanHistoryEntry,
  TheaterPlanHistoryEntry,
  BindCookieResult,
  HistoryQueryOptions,
  HistoryQueryResult,
  HistoryDeleteScope,
  HistoryDeleteScopeSelection,
  LlmConfigInput,
  LlmHealthReport,
  PersistedProfile,
  ProfileStateView,
  PublicConfig,
  RecommendationResult,
  RefreshOutcome,
  ScenarioEnvelope,
  ScenarioListItem,
  ScenarioMode,
  ScenarioPayload,
  UpdateStatus,
  DataManagementSummary,
  DataManagementScope,
  DataClearRequest
} from './domain.js';
import type {
  AbyssAdvisorEvent,
  AbyssAdvisorPlanInput,
  AbyssAdvisorResult,
  AbyssScenarioView
} from './abyss-advisor.js';
import type {
  StygianAdvisorEvent,
  StygianAdvisorPlanInput,
  StygianAdvisorResult,
  StygianScenarioView
} from './stygian-advisor.js';
import type {
  TheaterAdvisorEvent,
  TheaterAdvisorPlanInput,
  TheaterAdvisorResult,
  TheaterScenarioView
} from './theater-advisor.js';
import type { AgentRunTrace } from './agent-run-trace.js';

export const ADVISOR_EVENT_CHANNEL = 'advisor:event' as const;
export const ABYSS_ADVISOR_EVENT_CHANNEL = 'abyss-advisor:event' as const;
export const STYGIAN_ADVISOR_EVENT_CHANNEL = 'stygian-advisor:event' as const;
export const THEATER_ADVISOR_EVENT_CHANNEL = 'theater-advisor:event' as const;
export const UPDATE_EVENT_CHANNEL = 'update:event' as const;

export interface IpcContract {
  'config:get-public': { req: void; res: PublicConfig };
  'config:set-llm': { req: LlmConfigInput; res: { ok: true } };
  'config:test-llm': { req: void; res: LlmHealthReport };
  'config:clear-llm': { req: void; res: { ok: true } };
  'data-management:summary': { req: void; res: DataManagementSummary };
  'data-management:prepare-clear': {
    req: { scope: DataManagementScope };
    res: { count: number; confirmationToken: string };
  };
  'data-management:clear': {
    req: DataClearRequest;
    res: { removed: number; summary: DataManagementSummary };
  };

  'update:get-state': { req: void; res: UpdateStatus };
  'update:check': { req: void; res: { ok: true } };
  'update:download': { req: void; res: { ok: true } };
  'update:install': { req: void; res: { ok: true } };

  'miyoushe:bind': { req: { cookie: string }; res: BindCookieResult };
  'miyoushe:login-via-browser': {
    req: void;
    res:
      | { ok: true; bind: BindCookieResult; sessionId: string }
      | {
          ok: false;
          reason: 'cancelled' | 'timeout' | 'load-failed' | 'bind-failed';
          message?: string;
        };
  };
  'miyoushe:logout': { req: void; res: { ok: true } };
  'miyoushe:auth-state': {
    req: void;
    res: { hasCookie: boolean; uids: string[] };
  };
  'miyoushe:ping': {
    req: { uid: string };
    res:
      | { ok: true; nickname?: string; worldLevel?: number; totalCharacters?: number }
      | { ok: false; reason: string; retcode?: number };
  };

  'profile:state': { req: void; res: ProfileStateView };
  'profile:get': { req: { uid: string }; res: PersistedProfile | null };
  'profile:set-active': { req: { uid: string }; res: { ok: true } };
  'profile:refresh': { req: { uid: string }; res: RefreshOutcome };
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
  'advisor-v2:abyss-scenario': { req: void; res: AbyssScenarioView };
  'advisor-v2:abyss-plan': { req: AbyssAdvisorPlanInput; res: AbyssAdvisorResult };
  'advisor-v2:abyss-cancel': { req: { correlationId: string }; res: { ok: boolean } };
  'advisor-v2:abyss-latest-trace': { req: void; res: AgentRunTrace | null };
  'advisor-v2:stygian-scenario': { req: void; res: StygianScenarioView };
  'advisor-v2:stygian-plan': { req: StygianAdvisorPlanInput; res: StygianAdvisorResult };
  'advisor-v2:stygian-cancel': { req: { correlationId: string }; res: { ok: boolean } };
  'advisor-v2:theater-scenario': { req: void; res: TheaterScenarioView };
  'advisor-v2:theater-plan': { req: TheaterAdvisorPlanInput; res: TheaterAdvisorResult };
  'advisor-v2:theater-cancel': { req: { correlationId: string }; res: { ok: boolean } };

  'scenario:list': { req: void; res: ScenarioListItem[] };
  'scenario:get': {
    req: { mode: ScenarioMode };
    res: ScenarioEnvelope<ScenarioPayload>;
  };
  'scenario:refresh': {
    req: { mode?: ScenarioMode; force?: boolean };
    res: { refreshed: ScenarioMode[] };
  };

  'history:list': { req: HistoryQueryOptions; res: HistoryQueryResult };
  'history:delete': { req: { id: string }; res: { ok: boolean } };
  'history:abyss-list': { req: { uid?: string }; res: AbyssPlanHistoryEntry[] };
  'history:abyss-delete': { req: { id: string }; res: { ok: boolean } };
  'history:stygian-list': { req: { uid?: string }; res: StygianPlanHistoryEntry[] };
  'history:stygian-delete': { req: { id: string }; res: { ok: boolean } };
  'history:theater-list': { req: { uid?: string }; res: TheaterPlanHistoryEntry[] };
  'history:theater-delete': { req: { id: string }; res: { ok: boolean } };
  'history:prepare-delete-scope': {
    req: HistoryDeleteScopeSelection;
    res: { count: number; confirmationToken: string };
  };
  'history:delete-scope': { req: HistoryDeleteScope; res: { removed: number } };
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
  'data-management:summary',
  'data-management:prepare-clear',
  'data-management:clear',
  'update:get-state',
  'update:check',
  'update:download',
  'update:install',
  'miyoushe:bind',
  'miyoushe:login-via-browser',
  'miyoushe:logout',
  'miyoushe:auth-state',
  'miyoushe:ping',
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
  'advisor-v2:abyss-scenario',
  'advisor-v2:abyss-plan',
  'advisor-v2:abyss-cancel',
  'advisor-v2:abyss-latest-trace',
  'advisor-v2:stygian-scenario',
  'advisor-v2:stygian-plan',
  'advisor-v2:stygian-cancel',
  'advisor-v2:theater-scenario',
  'advisor-v2:theater-plan',
  'advisor-v2:theater-cancel',
  'scenario:list',
  'scenario:get',
  'scenario:refresh',
  'history:list',
  'history:delete',
  'history:abyss-list',
  'history:abyss-delete',
  'history:stygian-list',
  'history:stygian-delete',
  'history:theater-list',
  'history:theater-delete',
  'history:prepare-delete-scope',
  'history:delete-scope',
  'history:clear'
];

export interface RendererApi {
  config: {
    getPublic: () => Promise<IpcResponse<'config:get-public'>>;
    setLlm: (input: IpcRequest<'config:set-llm'>) => Promise<IpcResponse<'config:set-llm'>>;
    testLlm: () => Promise<IpcResponse<'config:test-llm'>>;
    clearLlm: () => Promise<IpcResponse<'config:clear-llm'>>;
  };
  dataManagement: {
    summary: () => Promise<IpcResponse<'data-management:summary'>>;
    prepareClear: (
      input: IpcRequest<'data-management:prepare-clear'>
    ) => Promise<IpcResponse<'data-management:prepare-clear'>>;
    clear: (
      input: IpcRequest<'data-management:clear'>
    ) => Promise<IpcResponse<'data-management:clear'>>;
  };
  update: {
    getState: () => Promise<IpcResponse<'update:get-state'>>;
    check: () => Promise<IpcResponse<'update:check'>>;
    download: () => Promise<IpcResponse<'update:download'>>;
    install: () => Promise<IpcResponse<'update:install'>>;
    onEvent: (cb: (event: UpdateStatus) => void) => () => void;
  };
  miyoushe: {
    bind: (input: IpcRequest<'miyoushe:bind'>) => Promise<IpcResponse<'miyoushe:bind'>>;
    loginViaBrowser: () => Promise<IpcResponse<'miyoushe:login-via-browser'>>;
    logout: () => Promise<IpcResponse<'miyoushe:logout'>>;
    authState: () => Promise<IpcResponse<'miyoushe:auth-state'>>;
    ping: (input: IpcRequest<'miyoushe:ping'>) => Promise<IpcResponse<'miyoushe:ping'>>;
  };
  profile: {
    state: () => Promise<IpcResponse<'profile:state'>>;
    get: (input: IpcRequest<'profile:get'>) => Promise<IpcResponse<'profile:get'>>;
    setActive: (
      input: IpcRequest<'profile:set-active'>
    ) => Promise<IpcResponse<'profile:set-active'>>;
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
    recommend: (
      input: IpcRequest<'advisor:recommend'>
    ) => Promise<IpcResponse<'advisor:recommend'>>;
    compare: (input: IpcRequest<'advisor:compare'>) => Promise<IpcResponse<'advisor:compare'>>;
    cancel: () => Promise<IpcResponse<'advisor:cancel'>>;
    onEvent: (cb: (event: AdvisorEvent) => void) => () => void;
  };
  abyssAdvisor: {
    getScenario: () => Promise<IpcResponse<'advisor-v2:abyss-scenario'>>;
    recommend: (
      input: IpcRequest<'advisor-v2:abyss-plan'>
    ) => Promise<IpcResponse<'advisor-v2:abyss-plan'>>;
    cancel: (
      input: IpcRequest<'advisor-v2:abyss-cancel'>
    ) => Promise<IpcResponse<'advisor-v2:abyss-cancel'>>;
    getLatestTrace: () => Promise<IpcResponse<'advisor-v2:abyss-latest-trace'>>;
    onEvent: (cb: (event: AbyssAdvisorEvent) => void) => () => void;
  };
  stygianAdvisor: {
    getScenario: () => Promise<IpcResponse<'advisor-v2:stygian-scenario'>>;
    recommend: (
      input: IpcRequest<'advisor-v2:stygian-plan'>
    ) => Promise<IpcResponse<'advisor-v2:stygian-plan'>>;
    cancel: (
      input: IpcRequest<'advisor-v2:stygian-cancel'>
    ) => Promise<IpcResponse<'advisor-v2:stygian-cancel'>>;
    onEvent: (cb: (event: StygianAdvisorEvent) => void) => () => void;
  };
  theaterAdvisor: {
    getScenario: () => Promise<IpcResponse<'advisor-v2:theater-scenario'>>;
    recommend: (
      input: IpcRequest<'advisor-v2:theater-plan'>
    ) => Promise<IpcResponse<'advisor-v2:theater-plan'>>;
    cancel: (
      input: IpcRequest<'advisor-v2:theater-cancel'>
    ) => Promise<IpcResponse<'advisor-v2:theater-cancel'>>;
    onEvent: (cb: (event: TheaterAdvisorEvent) => void) => () => void;
  };
  scenario: {
    list: () => Promise<IpcResponse<'scenario:list'>>;
    get: (input: IpcRequest<'scenario:get'>) => Promise<IpcResponse<'scenario:get'>>;
    refresh: (input: IpcRequest<'scenario:refresh'>) => Promise<IpcResponse<'scenario:refresh'>>;
  };
  history: {
    list: (input: IpcRequest<'history:list'>) => Promise<IpcResponse<'history:list'>>;
    delete: (input: IpcRequest<'history:delete'>) => Promise<IpcResponse<'history:delete'>>;
    listAbyss: (
      input: IpcRequest<'history:abyss-list'>
    ) => Promise<IpcResponse<'history:abyss-list'>>;
    deleteAbyss: (
      input: IpcRequest<'history:abyss-delete'>
    ) => Promise<IpcResponse<'history:abyss-delete'>>;
    listStygian: (
      input: IpcRequest<'history:stygian-list'>
    ) => Promise<IpcResponse<'history:stygian-list'>>;
    deleteStygian: (
      input: IpcRequest<'history:stygian-delete'>
    ) => Promise<IpcResponse<'history:stygian-delete'>>;
    listTheater: (
      input: IpcRequest<'history:theater-list'>
    ) => Promise<IpcResponse<'history:theater-list'>>;
    deleteTheater: (
      input: IpcRequest<'history:theater-delete'>
    ) => Promise<IpcResponse<'history:theater-delete'>>;
    prepareDeleteScope: (
      input: IpcRequest<'history:prepare-delete-scope'>
    ) => Promise<IpcResponse<'history:prepare-delete-scope'>>;
    deleteScope: (
      input: IpcRequest<'history:delete-scope'>
    ) => Promise<IpcResponse<'history:delete-scope'>>;
    clear: (input: IpcRequest<'history:clear'>) => Promise<IpcResponse<'history:clear'>>;
  };
}
