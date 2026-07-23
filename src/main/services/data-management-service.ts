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
  clearDownloadedCache(expected: { count: number; fingerprint: string }): Promise<number>;
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

export interface DataManagementDeps {
  profiles: ProfileDataManager;
  scenarios: ScenarioDataManager;
  history: HistoryDataManager;
  config: ConfigDataManager;
}

export type DataManagementErrorCode =
  | 'DATA_CONFIRMATION_EXPIRED'
  | 'DATA_SELECTION_CHANGED'
  | 'DATA_FILE_INSPECTION_FAILED'
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
    { scope: DataManagementScope; snapshot: Snapshot; expiresAt: number }
  >();

  constructor(
    private readonly deps: DataManagementDeps,
    private readonly now: () => number = Date.now
  ) {}

  async getSummary(): Promise<DataManagementSummary> {
    const profiles = this.deps.profiles.getDataManagementSnapshot();
    const scenarios = await this.deps.scenarios.getDataManagementSnapshot();
    const history = this.deps.history.getSummary();
    return {
      profiles: withoutFingerprint(profiles),
      scenarios: withoutFingerprint(scenarios),
      history,
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
      try {
        removed = await this.deps.scenarios.clearDownloadedCache(confirmation.snapshot);
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

  private async snapshot(scope: DataManagementScope): Promise<Snapshot> {
    switch (scope) {
      case 'profiles': {
        const value = this.deps.profiles.getDataManagementSnapshot();
        return { count: value.count, fingerprint: value.fingerprint };
      }
      case 'scenarios': {
        const value = await this.deps.scenarios.getDataManagementSnapshot();
        if (value.sizeBytes === undefined) {
          throw new DataManagementError(
            'DATA_FILE_INSPECTION_FAILED',
            'Scenario files could not be fully inspected; clear is unavailable'
          );
        }
        return { count: value.clearableCount, fingerprint: value.fingerprint };
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
  const result = { ...value };
  delete (result as Partial<T>).fingerprint;
  return result;
}
