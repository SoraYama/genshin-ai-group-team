import { randomUUID } from 'node:crypto';
import type {
  DataClearRequest,
  DataManagementScope,
  DataManagementSummary
} from '../../shared/domain.js';

interface Snapshot {
  count: number;
  fingerprint: string;
}

interface RelatedClearTransaction {
  removed: number;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface ScenarioClearSnapshot extends Snapshot {
  scenario: Snapshot;
  guideResearch: { clearableCount: number; fingerprint: string };
}

interface ProfileDataManager {
  getDataManagementSnapshot(): {
    count: number;
    sizeBytes?: number;
    updatedAt?: string;
    fingerprint: string;
  };
  clearAll(): number;
}

interface ScenarioDataManager {
  getDataManagementSnapshot(): Promise<{
    count: number;
    clearableCount: number;
    sizeBytes?: number;
    updatedAt?: string;
    fingerprint: string;
  }>;
  clearDownloadedCacheWithRelated(
    expected: { count: number; fingerprint: string },
    relatedClear: () => Promise<RelatedClearTransaction>
  ): Promise<{ scenarioRemoved: number; relatedRemoved: number }>;
}

interface HistoryDataManager {
  getSummary(): { count: number; sizeBytes?: number; updatedAt?: string };
  getChallengeScopeSnapshot(scope: { scope: 'all' }): { count: number; fingerprint: string };
  getChallengeScopeConfirmation(scope: { scope: 'all' }): {
    count: number;
    confirmationToken: string;
  };
  removeChallengeScope(scope: {
    scope: 'all';
    expectedCount: number;
    confirmationToken: string;
  }): number;
}

interface ConfigDataManager {
  getPublicView(): { hasApiKey: boolean };
  getSecretFingerprint(): string;
  clearApiKey(): void;
}

interface GuideResearchDataManager {
  getDataManagementSnapshot(): Promise<{
    count: number;
    clearableCount: number;
    physicalFilePresent: boolean;
    sizeBytes?: number;
    updatedAt?: string;
    fingerprint: string;
  }>;
  beginClear(expected: {
    clearableCount: number;
    fingerprint: string;
  }): Promise<RelatedClearTransaction>;
}

export interface DataManagementDeps {
  profiles: ProfileDataManager;
  scenarios: ScenarioDataManager;
  history: HistoryDataManager;
  guideResearch: GuideResearchDataManager;
  config: ConfigDataManager;
}

export type DataManagementErrorCode =
  | 'DATA_CONFIRMATION_EXPIRED'
  | 'DATA_SELECTION_CHANGED'
  | 'DATA_FILE_INSPECTION_FAILED'
  | 'DATA_CLEAR_INCOMPLETE'
  | 'DATA_NOTHING_TO_CLEAR';

export class DataManagementError extends Error {
  override readonly name = 'DataManagementError';

  constructor(
    readonly code: DataManagementErrorCode,
    message: string
  ) {
    super(message);
  }
}

export class DataManagementService {
  private readonly confirmations = new Map<
    string,
    { scope: DataManagementScope; snapshot: Snapshot | ScenarioClearSnapshot; expiresAt: number }
  >();

  constructor(
    private readonly deps: DataManagementDeps,
    private readonly now: () => number = Date.now
  ) {}

  async getSummary(): Promise<DataManagementSummary> {
    const profiles = this.deps.profiles.getDataManagementSnapshot();
    const scenarios = await this.deps.scenarios.getDataManagementSnapshot();
    const guideResearch = await this.deps.guideResearch.getDataManagementSnapshot();
    const history = this.deps.history.getSummary();
    return {
      profiles: withoutFingerprint(profiles),
      scenarios: withoutFingerprint(scenarios),
      history,
      guideResearch: publicGuideDataArea(guideResearch),
      serviceKey: { count: this.deps.config.getPublicView().hasApiKey ? 1 : 0 }
    };
  }

  async prepareClear(
    scope: DataManagementScope
  ): Promise<{ count: number; confirmationToken: string }> {
    const snapshot = await this.snapshot(scope);
    if (snapshot.count < 1)
      throw new DataManagementError('DATA_NOTHING_TO_CLEAR', 'Nothing to clear for this scope');
    const confirmationToken = randomUUID();
    this.confirmations.set(confirmationToken, {
      scope,
      snapshot,
      expiresAt: this.now() + 5 * 60_000
    });
    return { count: snapshot.count, confirmationToken };
  }

  async clear(
    request: DataClearRequest
  ): Promise<{ removed: number; summary: DataManagementSummary }> {
    const confirmation = this.confirmations.get(request.confirmationToken);
    this.confirmations.delete(request.confirmationToken);
    if (!confirmation || confirmation.expiresAt < this.now()) {
      throw new DataManagementError(
        'DATA_CONFIRMATION_EXPIRED',
        'Clear confirmation expired; confirm again'
      );
    }
    if (
      confirmation.scope !== request.scope ||
      confirmation.snapshot.count !== request.expectedCount
    ) {
      throw new DataManagementError('DATA_SELECTION_CHANGED', 'Clear scope changed; confirm again');
    }
    let removed = 0;
    if (request.scope === 'scenarios') {
      const snapshot = confirmation.snapshot;
      if (!isScenarioClearSnapshot(snapshot)) {
        throw new DataManagementError(
          'DATA_SELECTION_CHANGED',
          'Scenario clear snapshot is no longer valid'
        );
      }
      try {
        const result = await this.deps.scenarios.clearDownloadedCacheWithRelated(
          snapshot.scenario,
          () => this.deps.guideResearch.beginClear(snapshot.guideResearch)
        );
        removed = result.scenarioRemoved + result.relatedRemoved;
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : '';
        if (code === 'SCENARIO_FILE_INSPECTION_FAILED') {
          throw new DataManagementError(
            'DATA_FILE_INSPECTION_FAILED',
            'Scenario files could not be fully inspected; clear is unavailable'
          );
        }
        if (code === 'SCENARIO_SELECTION_CHANGED') {
          throw new DataManagementError(
            'DATA_SELECTION_CHANGED',
            'Scenario data changed; confirm again'
          );
        }
        if (code === 'GUIDE_RESEARCH_SELECTION_CHANGED') {
          throw new DataManagementError(
            'DATA_SELECTION_CHANGED',
            'Temporary guide cache changed; confirm again'
          );
        }
        if (code === 'SCENARIO_CLEAR_INCOMPLETE' || code === 'GUIDE_RESEARCH_CLEAR_INCOMPLETE') {
          throw new DataManagementError(
            'DATA_CLEAR_INCOMPLETE',
            'Challenge cache clear is incomplete; managed data can be retried'
          );
        }
        throw error;
      }
      return { removed, summary: await this.getSummary() };
    }
    const current = await this.snapshot(request.scope);
    if (
      current.count !== confirmation.snapshot.count ||
      current.fingerprint !== confirmation.snapshot.fingerprint
    ) {
      throw new DataManagementError(
        'DATA_SELECTION_CHANGED',
        'Data selection changed; confirm again'
      );
    }
    switch (request.scope) {
      case 'profiles':
        removed = this.deps.profiles.clearAll();
        break;
      case 'history': {
        const fresh = this.deps.history.getChallengeScopeConfirmation({ scope: 'all' });
        removed = this.deps.history.removeChallengeScope({
          scope: 'all',
          expectedCount: fresh.count,
          confirmationToken: fresh.confirmationToken
        });
        break;
      }
      case 'service-key':
        this.deps.config.clearApiKey();
        removed = 1;
        break;
    }
    return { removed, summary: await this.getSummary() };
  }

  private async snapshot(scope: DataManagementScope): Promise<Snapshot | ScenarioClearSnapshot> {
    switch (scope) {
      case 'profiles': {
        const value = this.deps.profiles.getDataManagementSnapshot();
        return { count: value.count, fingerprint: value.fingerprint };
      }
      case 'scenarios': {
        const [scenario, guideResearch] = await Promise.all([
          this.deps.scenarios.getDataManagementSnapshot(),
          this.deps.guideResearch.getDataManagementSnapshot()
        ]);
        if (scenario.sizeBytes === undefined || guideResearch.sizeBytes === undefined) {
          throw new DataManagementError(
            'DATA_FILE_INSPECTION_FAILED',
            'Scenario files could not be fully inspected; clear is unavailable'
          );
        }
        return {
          count: scenario.clearableCount + guideResearch.clearableCount,
          fingerprint: `${scenario.fingerprint}:${guideResearch.fingerprint}`,
          scenario: { count: scenario.clearableCount, fingerprint: scenario.fingerprint },
          guideResearch: {
            clearableCount: guideResearch.clearableCount,
            fingerprint: guideResearch.fingerprint
          }
        };
      }
      case 'history': {
        return this.deps.history.getChallengeScopeSnapshot({ scope: 'all' });
      }
      case 'service-key':
        return {
          count: this.deps.config.getPublicView().hasApiKey ? 1 : 0,
          fingerprint: this.deps.config.getSecretFingerprint()
        };
    }
  }
}

function withoutFingerprint<
  T extends { fingerprint: string; count: number; sizeBytes?: number; updatedAt?: string }
>(value: T): Omit<T, 'fingerprint'> {
  const result = { ...value } as Partial<T>;
  delete result.fingerprint;
  if (result.sizeBytes === undefined) delete result.sizeBytes;
  if (result.updatedAt === undefined) delete result.updatedAt;
  return result as Omit<T, 'fingerprint'>;
}

function isScenarioClearSnapshot(snapshot: Snapshot): snapshot is ScenarioClearSnapshot {
  return 'scenario' in snapshot && 'guideResearch' in snapshot;
}

function publicGuideDataArea(value: {
  count: number;
  physicalFilePresent: boolean;
  sizeBytes?: number;
  updatedAt?: string;
}): {
  count: number;
  sizeBytes?: number;
  updatedAt?: string;
} {
  return {
    count: value.count,
    ...(!value.physicalFilePresent || value.sizeBytes === undefined
      ? {}
      : { sizeBytes: value.sizeBytes }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt })
  };
}
