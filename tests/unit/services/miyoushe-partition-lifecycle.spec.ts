import { describe, expect, it, vi } from 'vitest';
import {
  createMiyousheDeviceFpCooldown,
  MiyoushePartitionLifecycle,
  seedRosterSessionsFromPersistedCookie
} from '../../../src/main/services/miyoushe/partition-lifecycle.js';

const UID = '100000001';
const OLD_COOKIE = 'ltoken_v2=old; ltuid_v2=old; ltmid_v2=old';
const COMPLETED_OLD_COOKIE = `${OLD_COOKIE}; DEVICEFP=old-fingerprint`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 100): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('createMiyousheDeviceFpCooldown', () => {
  it('falls back to an in-memory cooldown when the persistent store constructor throws', () => {
    const secret = 'corrupt-store-secret';

    const cooldown = createMiyousheDeviceFpCooldown({
      createPersistent: () => {
        throw new Error(secret);
      }
    });

    cooldown.recordFailure('device-a', 'network');

    expect(cooldown.inspect('device-a')).toMatchObject({
      active: true,
      reason: 'network'
    });
    expect(JSON.stringify(cooldown)).not.toContain(secret);
  });
});

describe('MiyoushePartitionLifecycle', () => {
  it('runs nested runCurrent calls directly in the same generation', async () => {
    const lifecycle = new MiyoushePartitionLifecycle();
    const generation = lifecycle.capture();
    const nestedOperation = vi.fn().mockResolvedValue('nested-result');

    const result = await lifecycle.runAt(generation, () => lifecycle.runCurrent(nestedOperation));

    expect(result).toBe('nested-result');
    expect(nestedOperation).toHaveBeenCalledOnce();
  });

  it('rejects a nested runCurrent call when its inherited generation is stale', async () => {
    const lifecycle = new MiyoushePartitionLifecycle();
    const generation = lifecycle.capture();
    const outerStarted = deferred<void>();
    const continueOuter = deferred<void>();
    const nestedOperation = vi.fn().mockResolvedValue(undefined);
    const nestedErrors: unknown[] = [];
    const outer = lifecycle.runAt(generation, async () => {
      outerStarted.resolve();
      await continueOuter.promise;
      try {
        await lifecycle.runCurrent(nestedOperation);
      } catch (error) {
        nestedErrors.push(error);
      }
      try {
        await lifecycle.runAt(generation, nestedOperation);
      } catch (error) {
        nestedErrors.push(error);
      }
    });
    await outerStarted.promise;

    const logout = lifecycle.transition();
    await vi.waitFor(() => expect(lifecycle.isCurrent(generation)).toBe(false));
    continueOuter.resolve();

    expect(await settlesWithin(Promise.all([outer, logout]))).toBe(true);
    expect(nestedErrors).toHaveLength(2);
    expect(nestedErrors).toEqual([
      expect.objectContaining({ name: 'MiyoushePartitionStaleError' }),
      expect.objectContaining({ name: 'MiyoushePartitionStaleError' })
    ]);
    expect(nestedOperation).not.toHaveBeenCalled();
  });

  it('suppresses a stale device-cookie write that finishes after a newer login starts', async () => {
    const lifecycle = new MiyoushePartitionLifecycle();
    const writer = { writeDeviceCookies: vi.fn().mockResolvedValue(undefined) };
    const guardedWriter = lifecycle.guardCookieWriter(writer);
    const operationStarted = deferred<void>();
    const continueOperation = deferred<void>();
    const oldGeneration = lifecycle.capture();
    const oldEnsure = lifecycle.runAt(oldGeneration, async () => {
      operationStarted.resolve();
      await continueOperation.promise;
      await guardedWriter.writeDeviceCookies({ DEVICEFP: 'old-fingerprint' });
    });
    await operationStarted.promise;

    const newLoginStarted = vi.fn();
    const newLogin = lifecycle.transition(async () => {
      newLoginStarted();
    });
    await Promise.resolve();
    expect(newLoginStarted).not.toHaveBeenCalled();

    continueOperation.resolve();
    await Promise.all([oldEnsure, newLogin]);

    expect(writer.writeDeviceCookies).not.toHaveBeenCalled();
  });

  it('drains a device-cookie write already in progress before logout clears the partition', async () => {
    const lifecycle = new MiyoushePartitionLifecycle();
    const writeFinished = deferred<void>();
    const events: string[] = [];
    const guardedWriter = lifecycle.guardCookieWriter({
      writeDeviceCookies: vi.fn().mockImplementation(async () => {
        events.push('write-started');
        await writeFinished.promise;
        events.push('write-finished');
      })
    });
    const oldWrite = lifecycle.runAt(lifecycle.capture(), () =>
      guardedWriter.writeDeviceCookies({ DEVICEFP: 'old-fingerprint' })
    );
    await vi.waitFor(() => expect(events).toEqual(['write-started']));

    const logout = lifecycle.transition(async () => {
      events.push('partition-cleared');
    });
    await Promise.resolve();
    expect(events).toEqual(['write-started']);

    writeFinished.resolve();
    await Promise.all([oldWrite, logout]);

    expect(events).toEqual(['write-started', 'write-finished', 'partition-cleared']);
  });
});

describe('seedRosterSessionsFromPersistedCookie', () => {
  it('does not let an old startup seed overwrite a newer interactive login', async () => {
    const lifecycle = new MiyoushePartitionLifecycle();
    const pendingEnsure = deferred<{
      ok: true;
      cookie: string;
      deviceHash: string;
      refreshed: boolean;
    }>();
    const deps = {
      lifecycle,
      loginWindow: {
        readPersistedCookie: vi.fn().mockResolvedValue(OLD_COOKIE)
      },
      deviceFp: {
        ensureForSessionAt: vi
          .fn()
          .mockImplementation((generation: number) =>
            lifecycle.runAt(generation, () => pendingEnsure.promise)
          )
      },
      miyoushe: {
        fetchRoles: vi.fn().mockResolvedValue({
          ok: true,
          roles: [{ gameUid: UID }]
        })
      },
      rosterSessions: {
        put: vi.fn()
      }
    };

    const seed = seedRosterSessionsFromPersistedCookie(deps);
    await vi.waitFor(() => expect(deps.deviceFp.ensureForSessionAt).toHaveBeenCalledOnce());

    const newLoginStarted = vi.fn();
    const newLogin = lifecycle.transition(async () => {
      newLoginStarted();
    });
    await Promise.resolve();
    expect(newLoginStarted).not.toHaveBeenCalled();

    pendingEnsure.resolve({
      ok: true,
      cookie: COMPLETED_OLD_COOKIE,
      deviceHash: '0123456789ab',
      refreshed: true
    });
    await Promise.all([seed, newLogin]);

    expect(newLoginStarted).toHaveBeenCalledOnce();
    expect(deps.miyoushe.fetchRoles).not.toHaveBeenCalled();
    expect(deps.rosterSessions.put).not.toHaveBeenCalled();
  });
});
