import type { MiyousheDeviceFpRecovery } from '../services/miyoushe-game-record.js';
import type { DeviceFpResult } from '../services/miyoushe/device-fp.js';

const DEFAULT_REPLAY_5003_COOLDOWN_MS = 72 * 60 * 60 * 1000;

export interface MiyousheDetailGateRawDeviceFp extends MiyousheDeviceFpRecovery {
  ensureForSession(cookie: string): Promise<DeviceFpResult>;
}

/**
 * Gives one opt-in gate process a strict one-refresh budget. Startup ensure is
 * part of that budget: a refreshed or failed ensure result is reused verbatim
 * for every later 5003, independent of elapsed time or wall-clock changes.
 */
export class MiyousheDetailGateDeviceFpCoordinator implements MiyousheDeviceFpRecovery {
  private readonly raw: MiyousheDetailGateRawDeviceFp;
  private readonly now: () => number;
  private readonly replay5003CooldownMs: number;
  private startupEnsureInFlight: Promise<DeviceFpResult> | undefined;
  private recoveryInFlight: Promise<DeviceFpResult> | undefined;
  private preparedEnsure: DeviceFpResult | undefined;
  private settledRecovery: DeviceFpResult | undefined;
  private recoveryRequestedDuringEnsure = false;

  constructor(
    raw: MiyousheDetailGateRawDeviceFp,
    options: { now?: () => number; replay5003CooldownMs?: number } = {}
  ) {
    this.raw = raw;
    this.now = options.now ?? Date.now;
    this.replay5003CooldownMs = options.replay5003CooldownMs ?? DEFAULT_REPLAY_5003_COOLDOWN_MS;
  }

  ensureForSession(cookie: string): Promise<DeviceFpResult> {
    if (this.settledRecovery) return Promise.resolve(this.settledRecovery);
    if (this.recoveryInFlight) return this.recoveryInFlight;
    if (this.startupEnsureInFlight) return this.startupEnsureInFlight;
    if (this.preparedEnsure) return Promise.resolve(this.preparedEnsure);

    let pending!: Promise<DeviceFpResult>;
    pending = Promise.resolve()
      .then(() => this.raw.ensureForSession(cookie))
      .catch(() => ({ ok: false as const, cookie, reason: 'network' as const }))
      .then((result) => this.finishStartupEnsure(result))
      .finally(() => {
        if (this.startupEnsureInFlight === pending) this.startupEnsureInFlight = undefined;
      });
    this.startupEnsureInFlight = pending;
    return pending;
  }

  applyKnownFingerprint(cookie: string): string {
    return this.raw.applyKnownFingerprint(cookie);
  }

  recoverFrom5003(cookie: string): Promise<DeviceFpResult> {
    if (this.settledRecovery) return Promise.resolve(this.settledRecovery);
    if (this.recoveryInFlight) return this.recoveryInFlight;
    if (this.startupEnsureInFlight) {
      this.recoveryRequestedDuringEnsure = true;
      return this.startupEnsureInFlight;
    }
    return this.startRawRecovery(this.preparedEnsure?.cookie ?? cookie);
  }

  finishReplay(cookie: string, outcome: 'success' | '5003' | 'other-error'): void {
    try {
      this.raw.finishReplay(cookie, outcome);
    } finally {
      if (outcome === '5003') {
        this.preparedEnsure = undefined;
        this.settledRecovery = {
          ok: false,
          cookie,
          reason: 'cooldown',
          retryAt: this.now() + this.replay5003CooldownMs
        };
      }
    }
  }

  private finishStartupEnsure(result: DeviceFpResult): DeviceFpResult | Promise<DeviceFpResult> {
    if (!result.ok || result.refreshed) {
      this.settledRecovery = result;
      return result;
    }
    this.preparedEnsure = result;
    if (this.recoveryRequestedDuringEnsure) {
      return this.startRawRecovery(result.cookie);
    }
    return result;
  }

  private startRawRecovery(cookie: string): Promise<DeviceFpResult> {
    if (this.settledRecovery) return Promise.resolve(this.settledRecovery);
    if (this.recoveryInFlight) return this.recoveryInFlight;

    let pending!: Promise<DeviceFpResult>;
    pending = Promise.resolve()
      .then(() => this.raw.recoverFrom5003(cookie))
      .catch(() => ({ ok: false as const, cookie, reason: 'network' as const }))
      .then((result) => {
        this.settledRecovery = result;
        return result;
      })
      .finally(() => {
        if (this.recoveryInFlight === pending) this.recoveryInFlight = undefined;
      });
    this.recoveryInFlight = pending;
    return pending;
  }
}
