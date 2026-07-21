import type { MiyousheDeviceFpRecovery } from '../services/miyoushe-game-record.js';
import type { DeviceFpResult } from '../services/miyoushe/device-fp.js';

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
  private startupEnsureInFlight: Promise<DeviceFpResult> | undefined;
  private recoveryInFlight: Promise<DeviceFpResult> | undefined;

  constructor(raw: MiyousheDetailGateRawDeviceFp) {
    this.raw = raw;
  }

  ensureForSession(cookie: string): Promise<DeviceFpResult> {
    this.startupEnsureInFlight ??= Promise.resolve()
      .then(() => this.raw.ensureForSession(cookie))
      .catch(() => ({ ok: false as const, cookie, reason: 'network' as const }));
    return this.startupEnsureInFlight;
  }

  applyKnownFingerprint(cookie: string): string {
    return this.raw.applyKnownFingerprint(cookie);
  }

  recoverFrom5003(cookie: string): Promise<DeviceFpResult> {
    this.recoveryInFlight ??= this.resolveRecovery(cookie);
    return this.recoveryInFlight;
  }

  finishReplay(cookie: string, outcome: 'success' | '5003' | 'other-error'): void {
    this.raw.finishReplay(cookie, outcome);
  }

  private async resolveRecovery(cookie: string): Promise<DeviceFpResult> {
    const startupResult = this.startupEnsureInFlight ? await this.startupEnsureInFlight : undefined;
    if (startupResult && (!startupResult.ok || startupResult.refreshed)) {
      return startupResult;
    }
    try {
      return await this.raw.recoverFrom5003(cookie);
    } catch {
      return { ok: false, cookie, reason: 'network' };
    }
  }
}
