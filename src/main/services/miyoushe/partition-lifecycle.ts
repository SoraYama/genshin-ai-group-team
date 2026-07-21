import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiyousheClient } from '../miyoushe-client.js';
import type { MiyousheDeviceFpRecovery } from '../miyoushe-game-record.js';
import type { MiyousheLoginWindow } from '../miyoushe-login-window.js';
import type { RosterSessionStore } from '../login-session-store.js';
import {
  MiyousheDeviceFpRecoveryStore,
  type DeviceFpRecoveryState
} from './device-fp-recovery-store.js';
import type { DeviceFpCookieWriter, DeviceFpResult, MiyousheDeviceFpService } from './device-fp.js';

const EMPTY_RECOVERY_STATE = (): DeviceFpRecoveryState => ({
  schemaVersion: 1,
  failuresByDevice: {}
});

export function createMiyousheDeviceFpCooldown(
  options: {
    createPersistent?: () => MiyousheDeviceFpRecoveryStore;
  } = {}
): MiyousheDeviceFpRecoveryStore {
  try {
    return (options.createPersistent ?? (() => new MiyousheDeviceFpRecoveryStore()))();
  } catch {
    let state = EMPTY_RECOVERY_STATE();
    return new MiyousheDeviceFpRecoveryStore({
      backend: {
        read: () => state,
        write: (nextState) => {
          state = nextState;
        }
      }
    });
  }
}

/**
 * Coordinates every mutation of the persistent miyoushe partition. Device-FP
 * operations run inside a captured generation; a newer login/logout makes an
 * older operation stale before it can persist cookies or commit sessions.
 */
export class MiyoushePartitionLifecycle {
  private generation = 0;
  private readonly operationGeneration = new AsyncLocalStorage<number>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly activeWrites = new Set<Promise<void>>();
  private transitionTail: Promise<void> = Promise.resolve();
  private writeGate: Promise<void> = Promise.resolve();
  private transitioning = false;

  capture(): number {
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  runAt<T>(generation: number, operation: () => Promise<T>): Promise<T | undefined> {
    if (this.transitioning || !this.isCurrent(generation)) return Promise.resolve(undefined);
    return this.trackOperation(this.operationGeneration.run(generation, operation));
  }

  async runCurrent<T>(operation: () => Promise<T>): Promise<T> {
    await this.transitionTail;
    const generation = this.operationGeneration.getStore() ?? this.capture();
    return this.trackOperation(this.operationGeneration.run(generation, operation));
  }

  transition<T = undefined>(
    mutation?: () => Promise<T>
  ): Promise<{ generation: number; value: T | undefined }> {
    const transition = this.transitionTail.then(() => this.performTransition(mutation));
    this.transitionTail = transition.then(
      () => undefined,
      () => undefined
    );
    return transition;
  }

  guardCookieWriter(writer: DeviceFpCookieWriter): DeviceFpCookieWriter {
    return {
      writeDeviceCookies: async (values) => {
        const generation = this.operationGeneration.getStore() ?? this.capture();
        if (!this.isCurrent(generation)) return;
        const gate = this.writeGate;
        await gate;
        if (!this.isCurrent(generation)) return;

        const write = writer.writeDeviceCookies(values);
        this.activeWrites.add(write);
        try {
          await write;
        } finally {
          this.activeWrites.delete(write);
        }
      }
    };
  }

  private async performTransition<T>(
    mutation?: () => Promise<T>
  ): Promise<{ generation: number; value: T | undefined }> {
    this.transitioning = true;
    this.generation += 1;
    let releaseWrites!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    this.writeGate = gate;

    let value: T | undefined;
    try {
      while (this.activeOperations.size > 0) {
        await Promise.allSettled([...this.activeOperations]);
      }
      while (this.activeWrites.size > 0) {
        await Promise.allSettled([...this.activeWrites]);
      }
      value = await mutation?.();
    } finally {
      this.generation += 1;
      this.transitioning = false;
      releaseWrites();
      if (this.writeGate === gate) this.writeGate = Promise.resolve();
    }

    return { generation: this.generation, value };
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    return operation.finally(() => {
      this.activeOperations.delete(operation);
    });
  }
}

export interface LifecycleMiyousheDeviceFp extends MiyousheDeviceFpRecovery {
  ensureForSession(cookie: string): Promise<DeviceFpResult>;
  ensureForSessionAt(generation: number, cookie: string): Promise<DeviceFpResult | undefined>;
}

export function bindDeviceFpToPartitionLifecycle(
  service: Pick<
    MiyousheDeviceFpService,
    'applyKnownFingerprint' | 'ensureForSession' | 'recoverFrom5003' | 'finishReplay'
  >,
  lifecycle: MiyoushePartitionLifecycle
): LifecycleMiyousheDeviceFp {
  return {
    applyKnownFingerprint: (cookie) => service.applyKnownFingerprint(cookie),
    ensureForSession: (cookie) => lifecycle.runCurrent(() => service.ensureForSession(cookie)),
    ensureForSessionAt: (generation, cookie) =>
      lifecycle.runAt(generation, () => service.ensureForSession(cookie)),
    recoverFrom5003: (cookie) => lifecycle.runCurrent(() => service.recoverFrom5003(cookie)),
    finishReplay: (cookie, outcome) => service.finishReplay(cookie, outcome)
  };
}

export async function seedRosterSessionsFromPersistedCookie(deps: {
  lifecycle: MiyoushePartitionLifecycle;
  loginWindow: Pick<MiyousheLoginWindow, 'readPersistedCookie'>;
  deviceFp: Pick<LifecycleMiyousheDeviceFp, 'ensureForSessionAt'>;
  miyoushe: Pick<MiyousheClient, 'fetchRoles'>;
  rosterSessions: Pick<RosterSessionStore, 'put'>;
}): Promise<void> {
  const generation = deps.lifecycle.capture();
  try {
    const cookie = await deps.loginWindow.readPersistedCookie();
    if (!cookie || !deps.lifecycle.isCurrent(generation)) return;

    let effectiveCookie = cookie;
    try {
      const deviceResult = await deps.deviceFp.ensureForSessionAt(generation, cookie);
      if (!deviceResult || !deps.lifecycle.isCurrent(generation)) return;
      effectiveCookie = deviceResult.cookie;
    } catch {
      if (!deps.lifecycle.isCurrent(generation)) return;
      // Device recovery is best-effort and may reject with sensitive context.
    }

    const bind = await deps.miyoushe.fetchRoles(effectiveCookie);
    if (!deps.lifecycle.isCurrent(generation)) return;
    if (!bind.ok || bind.roles.length === 0) {
      console.warn('[miyoushe] persisted cookie failed re-validation; skipping seed');
      return;
    }
    for (const role of bind.roles) {
      deps.rosterSessions.put(role.gameUid, effectiveCookie);
    }
    console.info(
      `[miyoushe] restored login session for ${bind.roles.length} UID(s) from persistent partition`
    );
  } catch {
    console.warn('[miyoushe] seed from persisted cookie failed');
  }
}
