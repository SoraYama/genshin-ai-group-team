import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdaterLike } from '../../../src/main/services/update-service.js';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false }
}));

vi.mock('electron-updater', () => {
  const autoUpdater = new EventEmitter();
  return { default: { autoUpdater }, autoUpdater };
});

class MockUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
}

let updater: MockUpdater;

beforeEach(() => {
  updater = new MockUpdater();
});

describe('UpdateService', () => {
  it('keeps downloads user-controlled and maps the complete update lifecycle', async () => {
    const { UpdateService } = await import('../../../src/main/services/update-service.js');
    const statuses: string[] = [];
    const service = new UpdateService({
      updater,
      currentVersion: '1.0.0',
      enabled: true,
      onStatus: (status) => statuses.push(status.state)
    });

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);

    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.1.0' });
    await service.download();
    updater.emit('download-progress', { percent: 37.5, transferred: 375, total: 1000 });
    updater.emit('update-downloaded', { version: '1.1.0' });
    service.install();

    expect(statuses).toEqual(['checking', 'available', 'downloading', 'downloaded']);
    expect(service.getState()).toEqual({
      state: 'downloaded',
      currentVersion: '1.0.0',
      version: '1.1.0'
    });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('rejects updater actions in development builds', async () => {
    const { UpdateService } = await import('../../../src/main/services/update-service.js');
    const service = new UpdateService({ updater, currentVersion: '1.0.0', enabled: false });

    expect(service.getState()).toMatchObject({ state: 'disabled', reason: 'development' });
    await expect(service.check()).rejects.toThrow('packaged builds');
  });

  it('redacts update server URLs and tokens from renderer-visible errors', async () => {
    const { UpdateService } = await import('../../../src/main/services/update-service.js');
    const service = new UpdateService({ updater, currentVersion: '1.0.0', enabled: true });

    updater.emit(
      'error',
      new Error('GET https://updates.example/latest.yml?token=secret-token failed')
    );

    expect(service.getState()).toEqual({
      state: 'error',
      currentVersion: '1.0.0',
      message: 'GET <update-server> failed'
    });
  });
});
