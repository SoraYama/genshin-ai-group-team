import { randomUUID } from 'node:crypto';

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
