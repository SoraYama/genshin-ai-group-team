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
    if (snapshot.count < 1) throw new Error('Nothing to clear for this scope');
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
      throw new Error('Clear confirmation expired; confirm again');
    }
    if (
      confirmation.scope !== request.scope ||
      confirmation.snapshot.count !== request.expectedCount
    ) {
      throw new Error('Clear scope changed; confirm again');
    }
    let removed = 0;
    if (request.scope === 'scenarios') {
      removed = await this.deps.scenarios.clearDownloadedCache(confirmation.snapshot);
      return { removed, summary: await this.getSummary() };
    }
    const current = await this.snapshot(request.scope);
    if (
      current.count !== confirmation.snapshot.count ||
      current.fingerprint !== confirmation.snapshot.fingerprint
    ) {
      throw new Error('Data selection changed; confirm again');
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
