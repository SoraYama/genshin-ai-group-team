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
    const next = [entry, ...this.store.get('abyssPlans')].slice(0, MAX_ENTRIES);
    this.store.set('abyssPlans', next);
    return structuredClone(entry);
  }

  queryAbyss(options: { uid?: string } = {}): AbyssPlanHistoryEntry[] {
    return structuredClone(
      this.store
        .get('abyssPlans')
        .filter((entry) => options.uid === undefined || entry.uid === options.uid)
    );
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
