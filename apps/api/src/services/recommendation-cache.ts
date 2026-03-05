import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RecommendationHistoryEntry } from '../types/recommendation.js';

interface RecommendationCacheFile {
  entries: RecommendationHistoryEntry[];
}

interface QueryOptions {
  uid?: string;
  offset?: number;
  limit?: number;
  source?: RecommendationHistoryEntry['source'];
  enemyKeyword?: string;
  fromDate?: string;
  toDate?: string;
}

interface QueryResult {
  items: RecommendationHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHistoryEntry(value: unknown): value is RecommendationHistoryEntry {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.createdAt === 'string' &&
    Array.isArray(value.enemyNames) &&
    typeof value.summary === 'string' &&
    (value.source === 'llm' || value.source === 'fallback') &&
    Array.isArray(value.teams)
  );
}

export class RecommendationCache {
  private entries: RecommendationHistoryEntry[] = [];
  private byUidIndex = new Map<string, RecommendationHistoryEntry[]>();
  private bySourceIndex = new Map<RecommendationHistoryEntry['source'], RecommendationHistoryEntry[]>();
  private queryMemo = new Map<string, { version: number; result: QueryResult }>();
  private version = 0;

  constructor(private readonly cacheFilePath: string) {}

  private rebuildIndexes(): void {
    this.byUidIndex.clear();
    this.bySourceIndex.set('llm', []);
    this.bySourceIndex.set('fallback', []);

    for (const entry of this.entries) {
      const sourceBucket = this.bySourceIndex.get(entry.source);
      if (sourceBucket) {
        sourceBucket.push(entry);
      }

      if (entry.uid) {
        const uidBucket = this.byUidIndex.get(entry.uid);
        if (uidBucket) {
          uidBucket.push(entry);
        } else {
          this.byUidIndex.set(entry.uid, [entry]);
        }
      }
    }
  }

  private invalidateQueryCache(): void {
    this.version += 1;
    this.queryMemo.clear();
  }

  private buildQueryKey(input: Record<string, string | number | boolean>): string {
    return JSON.stringify(input);
  }

  async hydrate(): Promise<void> {
    try {
      const raw = await readFile(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;

      if (!isObject(parsed) || !Array.isArray(parsed.entries)) {
        return;
      }

      this.entries = parsed.entries.filter((entry) => isHistoryEntry(entry));
      this.rebuildIndexes();
      this.invalidateQueryCache();
    } catch {
      return;
    }
  }

  async persist(): Promise<void> {
    const payload: RecommendationCacheFile = {
      entries: this.entries
    };

    await mkdir(path.dirname(this.cacheFilePath), { recursive: true });
    await writeFile(this.cacheFilePath, JSON.stringify(payload), 'utf-8');
  }

  append(input: Omit<RecommendationHistoryEntry, 'id' | 'createdAt'>): RecommendationHistoryEntry {
    const entry: RecommendationHistoryEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };

    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, 200);
    this.rebuildIndexes();
    this.invalidateQueryCache();
    return entry;
  }

  query(options?: QueryOptions): QueryResult {
    const normalized: Required<QueryOptions> = {
      uid: options?.uid ?? '',
      offset: options?.offset && options.offset > 0 ? options.offset : 0,
      limit: options?.limit && options.limit > 0 ? Math.min(options.limit, 100) : 20,
      source: options?.source ?? 'llm',
      enemyKeyword: options?.enemyKeyword?.trim().toLowerCase() ?? '',
      fromDate: options?.fromDate ?? '',
      toDate: options?.toDate ?? ''
    };

    const fromTimestamp = normalized.fromDate ? Date.parse(normalized.fromDate) : Number.NEGATIVE_INFINITY;
    const toTimestamp = normalized.toDate ? Date.parse(normalized.toDate) : Number.POSITIVE_INFINITY;

    const key = this.buildQueryKey({
      uid: normalized.uid,
      offset: normalized.offset,
      limit: normalized.limit,
      source: options?.source ?? 'all',
      enemyKeyword: normalized.enemyKeyword,
      fromDate: normalized.fromDate,
      toDate: normalized.toDate
    });
    const cached = this.queryMemo.get(key);
    if (cached && cached.version === this.version) {
      return cached.result;
    }

    let candidates = this.entries;
    if (normalized.uid) {
      candidates = this.byUidIndex.get(normalized.uid) ?? [];
    }

    if (options?.source) {
      if (normalized.uid) {
        candidates = candidates.filter((entry) => entry.source === normalized.source);
      } else {
        candidates = this.bySourceIndex.get(normalized.source) ?? [];
      }
    }

    const filtered = candidates.filter((entry) => {
      if (normalized.uid && entry.uid !== normalized.uid) {
        return false;
      }

      if (options?.source && entry.source !== normalized.source) {
        return false;
      }

      if (normalized.enemyKeyword) {
        const haystack = entry.enemyNames.join(' ').toLowerCase();
        if (!haystack.includes(normalized.enemyKeyword)) {
          return false;
        }
      }

      const createdAt = Date.parse(entry.createdAt);
      if (Number.isFinite(fromTimestamp) && createdAt < fromTimestamp) {
        return false;
      }

      if (Number.isFinite(toTimestamp) && createdAt > toTimestamp) {
        return false;
      }

      return true;
    });

    const total = filtered.length;
    const items = filtered.slice(normalized.offset, normalized.offset + normalized.limit);

    const result: QueryResult = {
      items,
      total,
      offset: normalized.offset,
      limit: normalized.limit,
      hasMore: normalized.offset + normalized.limit < total
    };

    this.queryMemo.set(key, {
      version: this.version,
      result
    });

    return result;
  }

  removeById(id: string): boolean {
    const initialLength = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    const changed = this.entries.length < initialLength;
    if (changed) {
      this.rebuildIndexes();
      this.invalidateQueryCache();
    }
    return changed;
  }

  removeMany(options?: {
    uid?: string;
    source?: RecommendationHistoryEntry['source'];
    enemyKeyword?: string;
  }): number {
    const enemyKeyword = options?.enemyKeyword?.trim().toLowerCase();
    const beforeLength = this.entries.length;

    this.entries = this.entries.filter((entry) => {
      if (options?.uid && entry.uid !== options.uid) {
        return true;
      }

      if (options?.source && entry.source !== options.source) {
        return true;
      }

      if (enemyKeyword) {
        const haystack = entry.enemyNames.join(' ').toLowerCase();
        if (!haystack.includes(enemyKeyword)) {
          return true;
        }
      }

      if (!options?.uid && !options?.source && !enemyKeyword) {
        return false;
      }

      return false;
    });

    const removed = beforeLength - this.entries.length;
    if (removed > 0) {
      this.rebuildIndexes();
      this.invalidateQueryCache();
    }

    return removed;
  }
}
