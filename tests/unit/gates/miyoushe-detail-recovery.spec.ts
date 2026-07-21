import { describe, expect, it, vi } from 'vitest';
import { MiyousheDetailGateDeviceFpCoordinator } from '../../../src/main/gates/miyoushe-detail-recovery.js';

const INITIAL_COOKIE = 'ltoken_v2=secret; DEVICEFP=initial-fp';
const FINAL_COOKIE = 'ltoken_v2=secret; DEVICEFP=final-fp';

function createRawDeviceFp(options: {
  ensure: () => Promise<
    | { ok: true; cookie: string; deviceHash: string; refreshed: boolean }
    | { ok: false; cookie: string; reason: 'network' | 'cooldown'; retryAt?: number }
  >;
  recover?: () => Promise<
    | { ok: true; cookie: string; deviceHash: string; refreshed: boolean }
    | { ok: false; cookie: string; reason: 'network' | 'cooldown'; retryAt?: number }
  >;
}) {
  return {
    applyKnownFingerprint: vi.fn((cookie: string) => cookie),
    ensureForSession: vi.fn(options.ensure),
    recoverFrom5003: vi.fn(
      options.recover ??
        (async () => ({
          ok: true as const,
          cookie: FINAL_COOKIE,
          deviceHash: 'device-hash',
          refreshed: true
        }))
    ),
    finishReplay: vi.fn()
  };
}

describe('MiyousheDetailGateDeviceFpCoordinator', () => {
  it('reuses the exact refreshed startup result without starting raw recovery', async () => {
    const refreshed = {
      ok: true as const,
      cookie: FINAL_COOKIE,
      deviceHash: 'device-hash',
      refreshed: true
    };
    const raw = createRawDeviceFp({ ensure: async () => refreshed });
    const coordinator = new MiyousheDetailGateDeviceFpCoordinator(raw);

    await expect(coordinator.ensureForSession(INITIAL_COOKIE)).resolves.toBe(refreshed);
    await expect(coordinator.recoverFrom5003(INITIAL_COOKIE)).resolves.toBe(refreshed);
    await expect(coordinator.recoverFrom5003(INITIAL_COOKIE)).resolves.toBe(refreshed);

    expect(raw.ensureForSession).toHaveBeenCalledTimes(1);
    expect(raw.recoverFrom5003).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'cooldown',
      result: {
        ok: false as const,
        cookie: INITIAL_COOKIE,
        reason: 'cooldown' as const,
        retryAt: 1_900_000_000_000
      }
    },
    {
      name: 'failed refresh',
      result: { ok: false as const, cookie: INITIAL_COOKIE, reason: 'network' as const }
    }
  ])('reuses the startup $name result without a second raw attempt', async ({ result }) => {
    const raw = createRawDeviceFp({ ensure: async () => result });
    const coordinator = new MiyousheDetailGateDeviceFpCoordinator(raw);

    await expect(coordinator.ensureForSession(INITIAL_COOKIE)).resolves.toBe(result);
    await expect(coordinator.recoverFrom5003(INITIAL_COOKIE)).resolves.toBe(result);

    expect(raw.ensureForSession).toHaveBeenCalledTimes(1);
    expect(raw.recoverFrom5003).not.toHaveBeenCalled();
  });

  it('allows one raw recovery after unchanged startup ensure and memoizes its result', async () => {
    const recovered = {
      ok: true as const,
      cookie: FINAL_COOKIE,
      deviceHash: 'device-hash',
      refreshed: true
    };
    const raw = createRawDeviceFp({
      ensure: async () => ({
        ok: true as const,
        cookie: INITIAL_COOKIE,
        deviceHash: 'device-hash',
        refreshed: false
      }),
      recover: async () => recovered
    });
    const coordinator = new MiyousheDetailGateDeviceFpCoordinator(raw);

    await coordinator.ensureForSession(INITIAL_COOKIE);
    await expect(coordinator.recoverFrom5003(INITIAL_COOKIE)).resolves.toBe(recovered);
    await expect(coordinator.recoverFrom5003(INITIAL_COOKIE)).resolves.toBe(recovered);

    expect(raw.recoverFrom5003).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing startup ensure into a sanitized terminal failure', async () => {
    const raw = createRawDeviceFp({
      ensure: async () => {
        throw new Error('secret upstream response');
      }
    });
    const coordinator = new MiyousheDetailGateDeviceFpCoordinator(raw);

    const ensured = await coordinator.ensureForSession(INITIAL_COOKIE);
    const recovered = await coordinator.recoverFrom5003(INITIAL_COOKIE);

    expect(ensured).toEqual({ ok: false, cookie: INITIAL_COOKIE, reason: 'network' });
    expect(recovered).toBe(ensured);
    expect(JSON.stringify(recovered)).not.toContain('secret upstream response');
    expect(raw.recoverFrom5003).not.toHaveBeenCalled();
  });

  it('lets recover-first own the atomic budget and reuses its result for later ensure', async () => {
    let rawGetFpCalls = 0;
    const recovered = {
      ok: true as const,
      cookie: FINAL_COOKIE,
      deviceHash: 'device-hash',
      refreshed: true
    };
    const raw = createRawDeviceFp({
      ensure: async () => {
        rawGetFpCalls += 1;
        return recovered;
      },
      recover: async () => {
        rawGetFpCalls += 1;
        return recovered;
      }
    });
    const coordinator = new MiyousheDetailGateDeviceFpCoordinator(raw);

    await expect(coordinator.recoverFrom5003(INITIAL_COOKIE)).resolves.toBe(recovered);
    await expect(coordinator.ensureForSession(INITIAL_COOKIE)).resolves.toBe(recovered);

    expect(rawGetFpCalls).toBe(1);
    expect(raw.recoverFrom5003).toHaveBeenCalledTimes(1);
    expect(raw.ensureForSession).not.toHaveBeenCalled();
  });

  it('singleflights concurrent recover-first and ensure starts', async () => {
    let resolveRecovery!: (result: {
      ok: true;
      cookie: string;
      deviceHash: string;
      refreshed: true;
    }) => void;
    const deferred = new Promise<{
      ok: true;
      cookie: string;
      deviceHash: string;
      refreshed: true;
    }>((resolve) => {
      resolveRecovery = resolve;
    });
    let rawGetFpCalls = 0;
    const raw = createRawDeviceFp({
      ensure: async () => {
        rawGetFpCalls += 1;
        return {
          ok: true as const,
          cookie: 'wrong-second-cookie',
          deviceHash: 'wrong-second-hash',
          refreshed: true
        };
      },
      recover: async () => {
        rawGetFpCalls += 1;
        return deferred;
      }
    });
    const coordinator = new MiyousheDetailGateDeviceFpCoordinator(raw);

    const recovery = coordinator.recoverFrom5003(INITIAL_COOKIE);
    const ensure = coordinator.ensureForSession(INITIAL_COOKIE);
    await vi.waitFor(() => expect(raw.recoverFrom5003).toHaveBeenCalledTimes(1));
    const recovered = {
      ok: true as const,
      cookie: FINAL_COOKIE,
      deviceHash: 'device-hash',
      refreshed: true as const
    };
    resolveRecovery(recovered);

    await expect(recovery).resolves.toBe(recovered);
    await expect(ensure).resolves.toBe(recovered);
    expect(rawGetFpCalls).toBe(1);
    expect(raw.ensureForSession).not.toHaveBeenCalled();
  });

  it('joins concurrent recovery to an unchanged ensure before resolving either caller', async () => {
    let resolveEnsure!: (result: {
      ok: true;
      cookie: string;
      deviceHash: string;
      refreshed: false;
    }) => void;
    const deferredEnsure = new Promise<{
      ok: true;
      cookie: string;
      deviceHash: string;
      refreshed: false;
    }>((resolve) => {
      resolveEnsure = resolve;
    });
    let rawGetFpCalls = 0;
    const recovered = {
      ok: true as const,
      cookie: FINAL_COOKIE,
      deviceHash: 'device-hash',
      refreshed: true
    };
    const raw = createRawDeviceFp({
      ensure: async () => deferredEnsure,
      recover: async () => {
        rawGetFpCalls += 1;
        return recovered;
      }
    });
    const coordinator = new MiyousheDetailGateDeviceFpCoordinator(raw);

    const ensure = coordinator.ensureForSession(INITIAL_COOKIE);
    const recovery = coordinator.recoverFrom5003(INITIAL_COOKIE);
    await vi.waitFor(() => expect(raw.ensureForSession).toHaveBeenCalledTimes(1));
    resolveEnsure({
      ok: true,
      cookie: INITIAL_COOKIE,
      deviceHash: 'device-hash',
      refreshed: false
    });

    await expect(ensure).resolves.toBe(recovered);
    await expect(recovery).resolves.toBe(recovered);
    expect(rawGetFpCalls).toBe(1);
    expect(raw.recoverFrom5003).toHaveBeenCalledTimes(1);
  });
});
