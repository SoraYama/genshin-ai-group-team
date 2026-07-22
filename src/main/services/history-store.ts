import { randomUUID } from 'node:crypto';
import Store from 'electron-store';
import type {
  AbyssPlanHistoryEntry,
  HistoryQueryOptions,
  HistoryQueryResult,
  RecommendationHistoryEntry
} from '../../shared/domain.js';

interface HistoryStoreSchema {
  entries: RecommendationHistoryEntry[];
  abyssPlans: AbyssPlanHistoryEntry[];
}

const MAX_ENTRIES = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const DEFAULTS: HistoryStoreSchema = {
  entries: [],
  abyssPlans: []
};

export class HistoryStore {
  private readonly store: Store<HistoryStoreSchema>;

  constructor() {
    this.store = new Store<HistoryStoreSchema>({
      name: 'history',
      defaults: DEFAULTS
    });
    this.migrateAbyssPlans();
  }

  append(input: Omit<RecommendationHistoryEntry, 'id' | 'createdAt'>): RecommendationHistoryEntry {
    const entry: RecommendationHistoryEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };

    const next = [entry, ...this.store.get('entries')].slice(0, MAX_ENTRIES);
    this.store.set('entries', next);
    return entry;
  }

  appendAbyss(input: Omit<AbyssPlanHistoryEntry, 'id' | 'createdAt'>): AbyssPlanHistoryEntry {
    const entry: AbyssPlanHistoryEntry = structuredClone({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    });
    const next = [entry, ...this.readAbyssPlans()].slice(0, MAX_ENTRIES);
    this.store.set('abyssPlans', next);
    return structuredClone(entry);
  }

  queryAbyss(options: { uid?: string } = {}): AbyssPlanHistoryEntry[] {
    return structuredClone(
      this.readAbyssPlans().filter(
        (entry) => options.uid === undefined || entry.uid === options.uid
      )
    );
  }

  removeAbyssById(id: string): boolean {
    const entries = this.readAbyssPlans();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    this.store.set('abyssPlans', next);
    return true;
  }

  private readAbyssPlans(): AbyssPlanHistoryEntry[] {
    const stored = this.store.get('abyssPlans') as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((entry) => {
      const normalized = normalizeAbyssPlanHistoryEntry(entry);
      return normalized ? [normalized] : [];
    });
  }

  private migrateAbyssPlans(): void {
    const stored = this.store.get('abyssPlans') as unknown;
    if (!Array.isArray(stored)) {
      this.store.set('abyssPlans', []);
      return;
    }
    const needsMigration = stored.some(
      (entry) =>
        !isRecord(entry) ||
        !Array.isArray(entry.characters) ||
        !isScenarioTrust(entry.scenarioTrust) ||
        !isScenarioFreshness(entry.scenarioFreshness) ||
        typeof entry.scenarioNotCurrent !== 'boolean'
    );
    if (needsMigration) this.store.set('abyssPlans', this.readAbyssPlans());
  }

  query(options: HistoryQueryOptions = {}): HistoryQueryResult {
    const offset = options.offset && options.offset > 0 ? options.offset : 0;
    const limit =
      options.limit && options.limit > 0 ? Math.min(options.limit, MAX_LIMIT) : DEFAULT_LIMIT;
    const enemyKeyword = options.enemyKeyword?.trim().toLowerCase() ?? '';
    const fromTs = options.fromDate ? Date.parse(options.fromDate) : Number.NEGATIVE_INFINITY;
    const toTs = options.toDate ? Date.parse(options.toDate) : Number.POSITIVE_INFINITY;

    const filtered = this.store.get('entries').filter((entry) => {
      if (options.uid && entry.uid !== options.uid) {
        return false;
      }
      if (options.source && entry.result.source !== options.source) {
        return false;
      }
      if (enemyKeyword) {
        const hay = entry.enemyNames.join(' ').toLowerCase();
        if (!hay.includes(enemyKeyword)) {
          return false;
        }
      }
      const ts = Date.parse(entry.createdAt);
      if (Number.isFinite(fromTs) && ts < fromTs) {
        return false;
      }
      if (Number.isFinite(toTs) && ts > toTs) {
        return false;
      }
      return true;
    });

    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + limit < filtered.length
    };
  }

  removeById(id: string): boolean {
    const before = this.store.get('entries');
    const next = before.filter((entry) => entry.id !== id);
    if (next.length === before.length) {
      return false;
    }
    this.store.set('entries', next);
    return true;
  }

  removeMany(filter: { uid?: string; source?: 'llm' | 'fallback'; enemyKeyword?: string }): number {
    if (!filter.uid && !filter.source && !filter.enemyKeyword) {
      throw new Error(
        'removeMany requires at least one filter (uid / source / enemyKeyword) to prevent accidental clear'
      );
    }
    const keyword = filter.enemyKeyword?.trim().toLowerCase();
    const before = this.store.get('entries');
    const next = before.filter((entry) => {
      if (filter.uid && entry.uid !== filter.uid) {
        return true;
      }
      if (filter.source && entry.result.source !== filter.source) {
        return true;
      }
      if (keyword) {
        const hay = entry.enemyNames.join(' ').toLowerCase();
        if (!hay.includes(keyword)) {
          return true;
        }
      }
      return false;
    });
    this.store.set('entries', next);
    return before.length - next.length;
  }
}

function normalizeAbyssPlanHistoryEntry(value: unknown): AbyssPlanHistoryEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.uid !== 'string' ||
    typeof value.scenarioId !== 'string' ||
    typeof value.dataVersion !== 'string' ||
    !isRecord(value.plan)
  ) {
    return undefined;
  }
  const inferredDevelopment =
    value.scenarioId.startsWith('development.') || value.dataVersion.startsWith('development.');
  const characters = Array.isArray(value.characters)
    ? value.characters.flatMap((character) => {
        if (
          !isRecord(character) ||
          typeof character.id !== 'string' ||
          typeof character.name !== 'string' ||
          typeof character.element !== 'string'
        ) {
          return [];
        }
        return [
          {
            id: character.id,
            name: character.name,
            element: character.element,
            ...(typeof character.level === 'number' ? { level: character.level } : {})
          }
        ];
      })
    : [];
  return structuredClone({
    ...value,
    characters,
    scenarioTrust: isScenarioTrust(value.scenarioTrust)
      ? value.scenarioTrust
      : inferredDevelopment
        ? 'development-sample'
        : 'production',
    scenarioFreshness: isScenarioFreshness(value.scenarioFreshness)
      ? value.scenarioFreshness
      : 'unknown',
    scenarioNotCurrent:
      typeof value.scenarioNotCurrent === 'boolean'
        ? value.scenarioNotCurrent
        : true
  }) as AbyssPlanHistoryEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScenarioTrust(value: unknown): value is AbyssPlanHistoryEntry['scenarioTrust'] {
  return value === 'production' || value === 'development-sample';
}

function isScenarioFreshness(value: unknown): value is AbyssPlanHistoryEntry['scenarioFreshness'] {
  return value === 'fresh' || value === 'expiring' || value === 'stale' || value === 'unknown';
}
