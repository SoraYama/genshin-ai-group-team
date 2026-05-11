export interface LlmConfigInput {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  customHeaders?: Record<string, string>;
}

export interface LlmConfigPublicView {
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
  customHeaderKeys: string[];
}

export interface LlmHealthReport {
  ok: boolean;
  latencyMs: number;
  model: string;
  baseUrl: string;
  httpStatus?: number;
  message?: string;
}

export interface PublicConfig {
  llm: LlmConfigPublicView;
  appVersion: string;
}

export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface CharacterStats {
  level: number;
  hp: number;
  atk: number;
  def: number;
  critRate: number;
  critDmg: number;
  energyRecharge: number;
  elementalMastery: number;
}

export interface CharacterProfile {
  id: number;
  name: string;
  element: string;
  rarity: number;
  imageUrl: string;
  stats: CharacterStats;
}

export interface MiyousheRole {
  gameUid: string;
  region: string;
  regionName?: string;
  nickname?: string;
  level?: number;
}

export interface BindCookieResult {
  ok: boolean;
  retcode?: number;
  message?: string;
  roles: MiyousheRole[];
}

export type ProfileSource = 'miyoushe' | 'miyoushe+enka' | 'enka';

export interface PersistedProfile {
  uid: string;
  region?: string;
  nickname?: string;
  level?: number;
  source: ProfileSource;
  fetchedAt: string;
  characters: CharacterProfile[];
}

export interface ProfileListItem {
  uid: string;
  nickname?: string;
  level?: number;
  source: ProfileSource;
  fetchedAt: string;
  characterCount: number;
}

export interface ProfileStateView {
  activeUid?: string;
  profiles: ProfileListItem[];
}

export interface AdvisorRequest {
  uid: string;
  enemyNames: string[];
  preference?: string;
}

export interface TeamRecommendation {
  name: string;
  characters: Array<{ id: number; name: string; element: string }>;
  reasoning: string;
  rotationTip: string;
}

export interface RecommendationResult {
  source: 'llm' | 'fallback';
  summary: string;
  teams: TeamRecommendation[];
}

export type AdvisorSide = 'single' | 'left' | 'right';

export type AdvisorEvent =
  | { type: 'started'; correlationId: string; side: AdvisorSide }
  | { type: 'progress'; correlationId: string; side: AdvisorSide; stage: string; message?: string }
  | { type: 'delta'; correlationId: string; side: AdvisorSide; text: string }
  | { type: 'final'; correlationId: string; side: AdvisorSide; result: RecommendationResult }
  | { type: 'error'; correlationId: string; side: AdvisorSide; message: string }
  | { type: 'cancelled'; correlationId: string; side: AdvisorSide };

export interface RecommendationHistoryEntry {
  id: string;
  uid: string;
  createdAt: string;
  enemyNames: string[];
  preference?: string;
  result: RecommendationResult;
  side: AdvisorSide;
  compareGroupId?: string;
}

export interface HistoryQueryOptions {
  uid?: string;
  source?: 'llm' | 'fallback';
  enemyKeyword?: string;
  fromDate?: string;
  toDate?: string;
  offset?: number;
  limit?: number;
}

export interface HistoryQueryResult {
  items: RecommendationHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface AdvisorCompareRequest {
  uid: string;
  left: { enemyNames: string[]; preference?: string };
  right: { enemyNames: string[]; preference?: string };
}

export interface AdvisorCompareResult {
  groupId: string;
  left: RecommendationResult;
  right: RecommendationResult;
  diffSummary: string;
}
