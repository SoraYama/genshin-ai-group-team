import { randomUUID } from 'node:crypto';
import type { DeviceFpPersistence } from './miyoushe/device-fp.js';

interface SessionEntry {
  cookie: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class LoginSessionStore {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  put(cookie: string): string {
    this.gc();
    const sessionId = randomUUID();
    this.entries.set(sessionId, {
      cookie,
      expiresAt: Date.now() + this.ttlMs
    });
    return sessionId;
  }

  consume(sessionId: string): string | undefined {
    this.gc();
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(sessionId);
    return entry.cookie;
  }

  clear(): void {
    this.entries.clear();
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(id);
      }
    }
  }
}

export interface RosterSession {
  uid: string;
  cookie: string;
  persistence: DeviceFpPersistence;
  expiresAt: number;
}

const ROSTER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory cookie cache for refreshing miyoushe game_record after the initial
 * onboarding. Keyed by UID so each profile's refresh can find its own cookie
 * without leaking across accounts. Crucially:
 *
 * - Never persisted (CLAUDE.md §10 forbids it).
 * - `peek()` does NOT consume; the roster refresh path may be called many times.
 * - TTL defaults to 24h; app restarts wipe the store and the user must re-login.
 */
export class RosterSessionStore {
  private readonly entries = new Map<string, RosterSession>();
  private readonly ttlMs: number;

  constructor(ttlMs = ROSTER_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  put(uid: string, cookie: string, persistence: DeviceFpPersistence = 'partition'): void {
    this.gc();
    this.entries.set(uid, {
      uid,
      cookie,
      persistence,
      expiresAt: Date.now() + this.ttlMs
    });
  }

  peek(uid: string): string | undefined {
    this.gc();
    return this.entries.get(uid)?.cookie;
  }

  peekSession(uid: string): Readonly<Pick<RosterSession, 'cookie' | 'persistence'>> | undefined {
    this.gc();
    const entry = this.entries.get(uid);
    if (!entry) return undefined;
    return { cookie: entry.cookie, persistence: entry.persistence };
  }

  hasCookie(uid: string): boolean {
    this.gc();
    return this.entries.has(uid);
  }

  revoke(uid: string): void {
    this.entries.delete(uid);
  }

  clear(): void {
    this.entries.clear();
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(id);
      }
    }
  }
}
