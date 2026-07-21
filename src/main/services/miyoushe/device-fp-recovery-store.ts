import { createHash } from 'node:crypto';
import Store from 'electron-store';

export type DeviceFpFailureKind =
  | 'profile-invalid'
  | 'network'
  | 'upstream'
  | 'schema-drift'
  | 'persist';

export interface DeviceFpRecoveryState {
  schemaVersion: 1;
  failuresByDevice: Record<string, { failedAt: number; reason: DeviceFpFailureKind }>;
}

export interface DeviceFpRecoveryBackend {
  read(): DeviceFpRecoveryState;
  write(state: DeviceFpRecoveryState): void;
}

export type DeviceFpCooldownInspection =
  | { active: false }
  | { active: true; retryAt: number; reason: DeviceFpFailureKind };

const DEFAULT_COOLDOWN_MS = 72 * 60 * 60 * 1000;
const DEVICE_HASH_PATTERN = /^[a-f0-9]{12}$/;
const FAILURE_KINDS = new Set<DeviceFpFailureKind>([
  'profile-invalid',
  'network',
  'upstream',
  'schema-drift',
  'persist'
]);

function emptyState(): DeviceFpRecoveryState {
  return { schemaVersion: 1, failuresByDevice: {} };
}

function deviceKey(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex').slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFailureKind(value: unknown): value is DeviceFpFailureKind {
  return typeof value === 'string' && FAILURE_KINDS.has(value as DeviceFpFailureKind);
}

function normalizeState(value: unknown): DeviceFpRecoveryState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.failuresByDevice)) {
    return emptyState();
  }

  const failuresByDevice: DeviceFpRecoveryState['failuresByDevice'] = {};
  for (const [key, entry] of Object.entries(value.failuresByDevice)) {
    if (!DEVICE_HASH_PATTERN.test(key) || !isRecord(entry)) continue;
    if (
      typeof entry.failedAt !== 'number' ||
      !Number.isFinite(entry.failedAt) ||
      !isFailureKind(entry.reason)
    ) {
      continue;
    }
    failuresByDevice[key] = { failedAt: entry.failedAt, reason: entry.reason };
  }
  return { schemaVersion: 1, failuresByDevice };
}

export class ElectronStoreDeviceFpRecoveryBackend implements DeviceFpRecoveryBackend {
  private readonly store: Store<DeviceFpRecoveryState>;

  constructor() {
    this.store = new Store<DeviceFpRecoveryState>({
      name: 'miyoushe-device-recovery',
      defaults: { schemaVersion: 1, failuresByDevice: {} }
    });
  }

  read(): DeviceFpRecoveryState {
    return this.store.store;
  }

  write(state: DeviceFpRecoveryState): void {
    this.store.store = state;
  }
}

export class MiyousheDeviceFpRecoveryStore {
  private readonly backend: DeviceFpRecoveryBackend;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(
    options: {
      backend?: DeviceFpRecoveryBackend;
      now?: () => number;
      cooldownMs?: number;
    } = {}
  ) {
    this.backend = options.backend ?? new ElectronStoreDeviceFpRecoveryBackend();
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  inspect(deviceId: string): DeviceFpCooldownInspection {
    const state = this.readState();
    const key = deviceKey(deviceId);
    const failure = state.failuresByDevice[key];
    if (!failure) return { active: false };

    const retryAt = failure.failedAt + this.cooldownMs;
    if (this.now() < retryAt) return { active: true, retryAt, reason: failure.reason };

    delete state.failuresByDevice[key];
    this.backend.write(state);
    return { active: false };
  }

  recordFailure(deviceId: string, reason: DeviceFpFailureKind): void {
    const state = this.readState();
    state.failuresByDevice[deviceKey(deviceId)] = { failedAt: this.now(), reason };
    this.backend.write(state);
  }

  clearFailure(deviceId: string): void {
    const state = this.readState();
    delete state.failuresByDevice[deviceKey(deviceId)];
    this.backend.write(state);
  }

  private readState(): DeviceFpRecoveryState {
    return normalizeState(this.backend.read());
  }
}
