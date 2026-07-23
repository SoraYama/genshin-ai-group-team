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
  monthlyUsage: LlmMonthlyUsage;
}

export interface LlmMonthlyUsage {
  month: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export type DataManagementScope = 'profiles' | 'scenarios' | 'history' | 'service-key';

export interface DataAreaSummary {
  count: number;
  sizeBytes?: number;
  updatedAt?: string;
}

export interface ScenarioDataAreaSummary extends DataAreaSummary {
  clearableCount: number;
}

export interface DataManagementSummary {
  profiles: DataAreaSummary;
  scenarios: ScenarioDataAreaSummary;
  history: DataAreaSummary;
  serviceKey: { count: 0 | 1 };
}

export interface DataClearRequest {
  scope: DataManagementScope;
  expectedCount: number;
  confirmationToken: string;
}

export type UpdateStatus =
  | { state: 'disabled'; currentVersion: string; reason: 'development' | 'unsupported' }
  | { state: 'idle'; currentVersion: string }
  | { state: 'checking'; currentVersion: string }
  | { state: 'available'; currentVersion: string; version: string }
  | { state: 'not-available'; currentVersion: string }
  | {
      state: 'downloading';
      currentVersion: string;
      version?: string;
      percent: number;
      transferred: number;
      total: number;
    }
  | { state: 'downloaded'; currentVersion: string; version: string }
  | { state: 'error'; currentVersion: string; message: string };

export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface CharacterStats {
  hp?: number;
  atk?: number;
  def?: number;
  critRate?: number;
  critDmg?: number;
  energyRecharge?: number;
  elementalMastery?: number;
}

export function hasCoreCharacterStats(
  stats: CharacterStats | undefined
): stats is CharacterStats & Required<Pick<CharacterStats, 'hp' | 'atk' | 'def'>> {
  return [stats?.hp, stats?.atk, stats?.def].every(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
  );
}

export type DataCompleteness = 'basic' | 'build' | 'detailed';
export type BuildField = 'stats' | 'weapon' | 'artifacts' | 'talents';
export type FieldSource = 'miyoushe-index' | 'miyoushe-list' | 'miyoushe-detail' | 'enka';

export interface FieldProvenance {
  source: FieldSource;
  fetchedAt: string;
  stale?: boolean;
}

export interface CharacterBuildSnapshot {
  stats?: CharacterStats;
  weapon?: CharacterWeapon;
  artifacts?: ArtifactPiece[];
  talents?: CharacterTalents;
}

export interface CharacterProvenance {
  ownership: FieldProvenance;
  build?: FieldProvenance;
  stats?: FieldProvenance;
}

export interface CharacterProfile {
  id: number;
  name: string;
  element: string;
  rarity: number;
  imageUrl: string;
  level?: number;
  build?: CharacterBuildSnapshot;
  constellation?: number;
  friendship?: number;
  source?: CharacterSource;
  completeness: DataCompleteness;
  missingFields: BuildField[];
  provenance: CharacterProvenance;
}

export type CharacterSource = 'enka' | 'miyoushe' | 'merged';

export interface CharacterWeapon {
  id: number;
  name: string;
  iconUrl: string;
  level: number;
  /** Undefined when a source exposes the equipped weapon but not its refinement rank. */
  refinement?: number;
  rarity: number;
  mainStat?: StatPair;
  subStat?: StatPair;
}

export interface CharacterTalents {
  normalAttack: number;
  elementalSkill: number;
  elementalBurst: number;
}

export interface StatPair {
  key: string;
  value: number;
}

export type ArtifactSlot = 'flower' | 'plume' | 'sands' | 'goblet' | 'circlet';

export interface ArtifactPiece {
  slot: ArtifactSlot;
  setId: number;
  setName: string;
  level: number;
  rarity: number;
  mainStat: StatPair;
  subStats: StatPair[];
  iconUrl?: string;
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

export type ProfileSource = 'miyoushe' | 'miyoushe+enka' | 'enka' | 'merged' | 'miyoushe-stale';
export type ProfileCredentialSource = 'manual' | 'partition';

export interface ProfileCoverage {
  expectedOwnedCount?: number;
  ownedCount: number;
  detailedCount: number;
  buildCount: number;
  statsCount: number;
  enkaShowcaseCount: number;
  missingDetailCount: number;
  partial: boolean;
}

export interface PersistedProfile {
  schemaVersion: 2;
  uid: string;
  /** Non-sensitive binding that controls whether this UID may use the shared browser partition. */
  credentialSource?: ProfileCredentialSource;
  region?: string;
  nickname?: string;
  /** Legacy field name retained for schema compatibility; this is Adventure Rank, not World Level. */
  level?: number;
  source: ProfileSource;
  fetchedAt: string;
  characters: CharacterProfile[];
  coverage: ProfileCoverage;
}

export interface ProfileListItem {
  uid: string;
  nickname?: string;
  /** Legacy field name retained for schema compatibility; this is Adventure Rank, not World Level. */
  level?: number;
  source: ProfileSource;
  fetchedAt: string;
  characterCount: number;
  coverage: ProfileCoverage;
}

export interface ProfileStateView {
  activeUid?: string;
  profiles: ProfileListItem[];
}

export type RefreshSourceStatus =
  | 'ok'
  | 'failed'
  | 'skipped'
  | 'no-cookie'
  | 'auth-expired'
  | 'captcha-required'
  | 'rate-limited';

export interface RefreshSummary {
  enka: RefreshSourceStatus;
  enkaCharacterCount: number;
  enkaError?: string;
  miyoushe: RefreshSourceStatus;
  miyousheCharacterCount: number;
  miyousheError?: string;
  totalCharacterCount: number;
}

export interface RefreshOutcome {
  profile: PersistedProfile;
  summary: RefreshSummary;
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
  confidence?: 'low' | 'medium' | 'high';
  assumptions?: string[];
  critiqueIssues?: string[];
}

export interface RecommendationResult {
  source: 'llm' | 'fallback';
  summary: string;
  teams: TeamRecommendation[];
  partial?: boolean;
  dataNotes?: string[];
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

export type PlayerCycleSnapshot =
  | {
      status: 'known';
      label: string;
      effectiveFrom: string;
      effectiveTo?: string;
    }
  | { status: 'unknown' };

export interface AbyssPlanHistoryEntry {
  id: string;
  createdAt: string;
  uid: string;
  scenarioId: string;
  playerCycle: PlayerCycleSnapshot;
  schemaVersion: 2;
  dataVersion: string;
  mode: 'spiral-abyss';
  target: { floor: number; chamber?: number };
  source: 'smart-service' | 'local-rules';
  scenarioTrust: 'production' | 'development-sample';
  scenarioFreshness: 'fresh' | 'expiring' | 'stale' | 'unknown';
  scenarioNotCurrent: boolean;
  interventions: {
    locale?: import('./advisor-narrative.js').AdvisorLocale | null;
    lockedCharacterIds: string[];
    excludedCharacterIds: string[];
    preferences: import('./scenario-v2.js').PlayerPreferences;
    recomputeHalf?: 'firstHalf' | 'secondHalf';
  };
  narrative?: import('./advisor-narrative.js').AdvisorNarrative;
  teamRisks?: import('./advisor-narrative.js').AbyssTeamRisk[];
  characters: Array<{
    id: string;
    name: string;
    element: string;
    level?: number;
  }>;
  plan: import('./scenario-v2.js').AbyssPlan;
}

export interface StygianPlanHistoryEntry {
  id: string;
  createdAt: string;
  uid: string;
  scenarioId: string;
  playerCycle: PlayerCycleSnapshot;
  schemaVersion: 2;
  dataVersion: string;
  mode: 'stygian-onslaught';
  difficultyId: string;
  difficultyNames?: import('./advisor-narrative.js').LocalizedAdvisorText;
  /** Raw compatibility field accepted only while reading legacy v2 records. */
  difficultyName?: string;
  legacyDifficultyName?: {
    text: string;
    locale: import('./advisor-narrative.js').AdvisorLocale | null;
  };
  phase?: number;
  target: import('./stygian-advisor.js').StygianRewardTarget;
  reusePolicy: import('./scenario-v2.js').CrossPartyReusePolicy;
  source: 'smart-service' | 'local-rules';
  scenarioTrust: 'production' | 'development-sample';
  scenarioFreshness: 'fresh' | 'expiring' | 'stale' | 'unknown';
  scenarioNotCurrent: boolean;
  interventions: {
    locale?: import('./advisor-narrative.js').AdvisorLocale | null;
    lockedCharacterIds: string[];
    excludedCharacterIds: string[];
    target: import('./stygian-advisor.js').StygianRewardTarget;
    difficultyId: string;
    preferences: import('./scenario-v2.js').PlayerPreferences;
  };
  narrative?: import('./advisor-narrative.js').AdvisorNarrative;
  characters: Array<{
    id: string;
    name: string;
    element: string;
    level?: number;
  }>;
  phaseGuidance: import('./stygian-advisor.js').StygianPhaseGuidance | null;
  difficultyAssessment: import('./stygian-advisor.js').StygianDifficultyAssessment | null;
  plan: import('./scenario-v2.js').StygianPlan;
}

export interface TheaterPlanHistoryEntry {
  id: string;
  createdAt: string;
  uid: string;
  scenarioId: string;
  playerCycle: PlayerCycleSnapshot;
  schemaVersion: 2;
  dataVersion: string;
  mode: 'imaginarium-theater';
  act?: number;
  target: import('./theater-advisor.js').TheaterObjective;
  source: 'smart-service' | 'local-rules';
  scenarioTrust: 'production' | 'development-sample';
  scenarioFreshness: 'fresh' | 'expiring' | 'stale' | 'unknown';
  scenarioNotCurrent: boolean;
  interventions: Omit<import('./theater-advisor.js').TheaterAdvisorPlanInput, 'locale'> & {
    locale?: import('./advisor-narrative.js').AdvisorLocale | null;
  };
  eligibility: import('./theater-advisor.js').TheaterEligibilityReport;
  cast: Array<{
    id: string;
    name: string;
    names?: Record<string, string>;
    nameRef?: {
      kind: 'profile-character' | 'scenario-entity' | 'legacy-name';
      id: string;
    };
    element?: string;
    level?: number;
    source: 'owned' | 'opening' | 'trial' | 'special-guest' | 'support';
    poolSources?: Array<'opening' | 'trial' | 'special-guest' | 'support'>;
  }>;
  vigorBudget: Array<{
    act: number;
    characterId: string;
    before: number;
    spent: number;
    after: number;
  }>;
  nodeBudget: import('./theater-advisor.js').TheaterNodeBudgetItem[];
  arcanaSnapshots?: Array<{
    id: string;
    nameRef: string;
    names: Record<string, string>;
  }>;
  encounterSnapshots?: Array<{
    act: number;
    encounterId: string;
    enemyRefs: Array<{
      id: string;
      names: Record<string, string>;
    }>;
  }>;
  routeGuidance: import('./theater-advisor.js').TheaterRouteGuidance;
  narrative?: import('./advisor-narrative.js').AdvisorNarrative;
  plan: import('./scenario-v2.js').TheaterPlan;
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

export type HistoryDeleteScopeSelection =
  | {
      scope: 'group';
      uid: string;
      mode: ScenarioMode;
      scenarioId: string;
    }
  | { scope: 'uid'; uid: string }
  | { scope: 'all' };

export type HistoryDeleteScope = HistoryDeleteScopeSelection & {
  expectedCount: number;
  confirmationToken: string;
};

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

// ---------- Scenario data (v0.6) ----------

export type ScenarioMode = 'spiral-abyss' | 'stygian-onslaught' | 'imaginarium-theater';

export const ALL_SCENARIO_MODES: ScenarioMode[] = [
  'spiral-abyss',
  'stygian-onslaught',
  'imaginarium-theater'
];

export type ScenarioSourceTag = 'bundled' | 'remote' | 'web-fallback';

export interface ScenarioMeta {
  fetchedAt: string;
  sourceVersion: string;
  expiresAt: string;
  source: ScenarioSourceTag;
  stale?: boolean;
}

export interface ScenarioEnvelope<T> {
  mode: ScenarioMode;
  meta: ScenarioMeta;
  scenario: T;
}

export interface EnemyRef {
  id?: number;
  name: string;
  element?: string;
  shield?: string;
  resistances?: Record<string, number>;
}

export interface EnemyLineup {
  primary: EnemyRef[];
  reinforcement?: EnemyRef[];
}

export interface SpiralAbyssScenario {
  cycleId: string;
  startsAt: string;
  endsAt: string;
  blessingOfAbyssalMoon: { name: string; description: string };
  floors: Array<{
    floor: 9 | 10 | 11 | 12;
    ley?: string;
    chambers: Array<{
      chamber: 1 | 2 | 3;
      firstHalf: EnemyLineup;
      secondHalf: EnemyLineup;
      ley?: string;
    }>;
  }>;
}

export interface StygianOnslaughtScenario {
  rotationId: string;
  difficulty: 1 | 2 | 3 | 4 | 5 | 6;
  enemies: EnemyLineup;
  buffs: Array<{ name: string; description: string }>;
}

export interface ImaginariumTheaterScenario {
  seasonId: string;
  themeElements: string[];
  requiredCharacters: number[];
  trialCharacters: number[];
  acts: Array<{
    act: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    enemies: EnemyLineup;
    specialEffects: string[];
  }>;
}

export type ScenarioPayload =
  | SpiralAbyssScenario
  | StygianOnslaughtScenario
  | ImaginariumTheaterScenario;

export interface ScenarioListItem {
  mode: ScenarioMode;
  meta: ScenarioMeta;
}
