import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronStoreOptions = vi.hoisted(() => [] as Array<{ name?: string; defaults?: unknown }>);

vi.mock('electron-store', () => ({
  default: class MockElectronStore {
    private value: unknown;

    constructor(options: { name?: string; defaults?: unknown }) {
      electronStoreOptions.push(options);
      this.value = options.defaults;
    }

    get store(): unknown {
      return this.value;
    }

    set store(value: unknown) {
      this.value = value;
    }
  }
}));

import {
  MiyousheDeviceFpRecoveryStore,
  type DeviceFpRecoveryBackend,
  type DeviceFpRecoveryState
} from '../../../src/main/services/miyoushe/device-fp-recovery-store.js';

const HOUR_MS = 60 * 60 * 1000;
const COOLDOWN_MS = 72 * HOUR_MS;

class MemoryBackend implements DeviceFpRecoveryBackend {
  value: DeviceFpRecoveryState = {
    schemaVersion: 1,
    failuresByDevice: {}
  };

  read(): DeviceFpRecoveryState {
    return this.value;
  }

  write(state: DeviceFpRecoveryState): void {
    this.value = state;
  }
}

function deviceHash(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex').slice(0, 12);
}

function createStore(backend: MemoryBackend, now: number): MiyousheDeviceFpRecoveryStore {
  return new MiyousheDeviceFpRecoveryStore({
    backend,
    now: () => now,
    cooldownMs: COOLDOWN_MS
  });
}

beforeEach(() => {
  electronStoreOptions.length = 0;
  vi.restoreAllMocks();
});

describe('MiyousheDeviceFpRecoveryStore', () => {
  it('uses Date.now and a 72-hour cooldown by default', () => {
    const failedAt = 1_720_000_000_000;
    const backend = new MemoryBackend();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(failedAt)
      .mockReturnValueOnce(failedAt + COOLDOWN_MS - 1)
      .mockReturnValueOnce(failedAt + COOLDOWN_MS);
    const store = new MiyousheDeviceFpRecoveryStore({ backend });

    store.recordFailure('plain-device-id', 'upstream');
    expect(store.inspect('plain-device-id')).toEqual({
      active: true,
      reason: 'upstream',
      retryAt: failedAt + COOLDOWN_MS
    });
    expect(store.inspect('plain-device-id')).toEqual({ active: false });
    expect(backend.value.failuresByDevice).not.toHaveProperty(deviceHash('plain-device-id'));
  });

  it('configures the default electron-store backend without opening userData', () => {
    new MiyousheDeviceFpRecoveryStore();

    expect(electronStoreOptions).toEqual([
      {
        name: 'miyoushe-device-recovery',
        defaults: { schemaVersion: 1, failuresByDevice: {} }
      }
    ]);
  });

  it('activates the cooldown after an upstream failure', () => {
    const now = 1_720_000_000_000;
    const backend = new MemoryBackend();
    const store = createStore(backend, now);

    store.recordFailure('plain-device-id', 'upstream');

    expect(store.inspect('plain-device-id')).toEqual({
      active: true,
      reason: 'upstream',
      retryAt: now + COOLDOWN_MS
    });
  });

  it('persists only a short device hash with recovery metadata', () => {
    const backend = new MemoryBackend();
    const store = createStore(backend, 1_720_000_000_000);

    store.recordFailure('plain-device-id', 'upstream');

    const serialized = JSON.stringify(backend.value);
    expect(serialized).not.toContain('plain-device-id');
    expect(backend.value).toEqual({
      schemaVersion: 1,
      failuresByDevice: {
        [deviceHash('plain-device-id')]: {
          failedAt: 1_720_000_000_000,
          reason: 'upstream'
        }
      }
    });
    expect(Object.keys(backend.value.failuresByDevice)[0]).toMatch(/^[a-f0-9]{12}$/);
  });

  it('keeps a cooldown active until its boundary then removes the expired record', () => {
    const failedAt = 1_720_000_000_000;
    const backend = new MemoryBackend();
    const store = createStore(backend, failedAt);
    store.recordFailure('plain-device-id', 'network');

    const beforeBoundary = createStore(backend, failedAt + COOLDOWN_MS - 1);
    expect(beforeBoundary.inspect('plain-device-id')).toEqual({
      active: true,
      reason: 'network',
      retryAt: failedAt + COOLDOWN_MS
    });

    const atBoundary = createStore(backend, failedAt + COOLDOWN_MS);
    expect(atBoundary.inspect('plain-device-id')).toEqual({ active: false });
    expect(backend.value.failuresByDevice).not.toHaveProperty(deviceHash('plain-device-id'));
  });

  it('clears only the requested device failure', () => {
    const backend = new MemoryBackend();
    const store = createStore(backend, 1_720_000_000_000);
    store.recordFailure('device-a', 'profile-invalid');
    store.recordFailure('device-b', 'persist');

    store.clearFailure('device-a');
    store.clearFailure('unknown-device');

    expect(backend.value.failuresByDevice).not.toHaveProperty(deviceHash('device-a'));
    expect(backend.value.failuresByDevice).toHaveProperty(deviceHash('device-b'));
  });

  it('keeps failures isolated and updates only the matching device hash', () => {
    const backend = new MemoryBackend();
    const first = createStore(backend, 1_720_000_000_000);
    first.recordFailure('device-a', 'network');
    first.recordFailure('device-b', 'schema-drift');

    const updatedAt = 1_720_000_001_000;
    createStore(backend, updatedAt).recordFailure('device-a', 'upstream');

    expect(backend.value.failuresByDevice).toEqual({
      [deviceHash('device-a')]: { failedAt: updatedAt, reason: 'upstream' },
      [deviceHash('device-b')]: { failedAt: 1_720_000_000_000, reason: 'schema-drift' }
    });
  });

  it('ignores malformed persisted entries without exposing them', () => {
    const backend = new MemoryBackend();
    backend.value = {
      schemaVersion: 1,
      failuresByDevice: {
        'not-a-hash': { failedAt: 1, reason: 'upstream' },
        '0123456789ab': { failedAt: 'not-a-number', reason: 'network' },
        abcdefabcdef: { failedAt: 1_720_000_000_000, reason: 'unknown-reason' }
      }
    } as unknown as DeviceFpRecoveryState;
    const store = createStore(backend, 1_720_000_000_001);

    expect(store.inspect('plain-device-id')).toEqual({ active: false });
    expect(() => store.clearFailure('plain-device-id')).not.toThrow();
    expect(backend.value).toEqual({ schemaVersion: 1, failuresByDevice: {} });
  });
});
