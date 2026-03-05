import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CachedProfileEntry } from '../types/profile.js';

interface CacheFileShape {
  byUid: Record<string, CachedProfileEntry>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCachedProfileEntry(value: unknown): value is CachedProfileEntry {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.uid === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.source === 'miyoushe' || value.source === 'miyoushe+enka') &&
    Array.isArray(value.profiles)
  );
}

export class ProfileCache {
  private readonly byUid = new Map<string, CachedProfileEntry>();

  constructor(private readonly cacheFilePath: string) {}

  get(uid: string): CachedProfileEntry | undefined {
    return this.byUid.get(uid);
  }

  list(): CachedProfileEntry[] {
    return Array.from(this.byUid.values());
  }

  set(entry: CachedProfileEntry): void {
    this.byUid.set(entry.uid, entry);
  }

  async hydrate(): Promise<void> {
    try {
      const raw = await readFile(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed) || !isObject(parsed.byUid)) {
        return;
      }

      for (const [uid, value] of Object.entries(parsed.byUid)) {
        if (isCachedProfileEntry(value)) {
          this.byUid.set(uid, value);
        }
      }
    } catch {
      return;
    }
  }

  async persist(): Promise<void> {
    const payload: CacheFileShape = {
      byUid: Object.fromEntries(this.byUid.entries())
    };

    await mkdir(path.dirname(this.cacheFilePath), { recursive: true });
    await writeFile(this.cacheFilePath, JSON.stringify(payload), 'utf-8');
  }
}
