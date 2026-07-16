import { app } from 'electron';
import updaterModule from 'electron-updater';
import type { UpdateStatus } from '../../shared/domain.js';

const { autoUpdater } = updaterModule;

interface UpdateInfoLike {
  version: string;
}

interface ProgressInfoLike {
  percent: number;
  transferred: number;
  total: number;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): this;
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): this;
  on(event: 'update-not-available', listener: () => void): this;
  on(event: 'download-progress', listener: (progress: ProgressInfoLike) => void): this;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceOptions {
  updater?: UpdaterLike;
  currentVersion?: string;
  enabled?: boolean;
  onStatus?: (status: UpdateStatus) => void;
}

function sanitizeUpdateError(error: Error): string {
  return error.message
    .replace(/https?:\/\/\S+/gi, '<update-server>')
    .replace(/([?&](?:token|key|signature|authorization)=)[^&\s]+/gi, '$1<redacted>')
    .slice(0, 300);
}

export class UpdateService {
  private readonly updater: UpdaterLike;
  private readonly currentVersion: string;
  private readonly enabled: boolean;
  private readonly onStatus?: (status: UpdateStatus) => void;
  private status: UpdateStatus;
  private availableVersion?: string;

  constructor(options: UpdateServiceOptions = {}) {
    this.updater = options.updater ?? autoUpdater;
    this.currentVersion = options.currentVersion ?? app.getVersion();
    this.enabled = options.enabled ?? app.isPackaged;
    this.onStatus = options.onStatus;
    this.status = this.enabled
      ? { state: 'idle', currentVersion: this.currentVersion }
      : { state: 'disabled', currentVersion: this.currentVersion, reason: 'development' };

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
    this.bindEvents();
  }

  getState(): UpdateStatus {
    return this.status;
  }

  async check(): Promise<void> {
    this.assertEnabled();
    await this.updater.checkForUpdates();
  }

  async download(): Promise<void> {
    this.assertEnabled();
    if (
      !this.availableVersion ||
      (this.status.state !== 'available' && this.status.state !== 'error')
    ) {
      throw new Error('No update is ready to download.');
    }
    await this.updater.downloadUpdate();
  }

  install(): void {
    this.assertEnabled();
    if (this.status.state !== 'downloaded') {
      throw new Error('The update has not finished downloading.');
    }
    this.updater.quitAndInstall(false, true);
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error('Updates are only available in packaged builds.');
    }
  }

  private emit(status: UpdateStatus): void {
    this.status = status;
    this.onStatus?.(status);
  }

  private bindEvents(): void {
    this.updater.on('checking-for-update', () => {
      this.emit({ state: 'checking', currentVersion: this.currentVersion });
    });
    this.updater.on('update-available', (info) => {
      this.availableVersion = info.version;
      this.emit({ state: 'available', currentVersion: this.currentVersion, version: info.version });
    });
    this.updater.on('update-not-available', () => {
      this.availableVersion = undefined;
      this.emit({ state: 'not-available', currentVersion: this.currentVersion });
    });
    this.updater.on('download-progress', (progress) => {
      this.emit({
        state: 'downloading',
        currentVersion: this.currentVersion,
        version: this.availableVersion,
        percent: Math.max(0, Math.min(100, progress.percent)),
        transferred: progress.transferred,
        total: progress.total
      });
    });
    this.updater.on('update-downloaded', (info) => {
      this.emit({ state: 'downloaded', currentVersion: this.currentVersion, version: info.version });
    });
    this.updater.on('error', (error) => {
      this.emit({
        state: 'error',
        currentVersion: this.currentVersion,
        message: sanitizeUpdateError(error)
      });
    });
  }
}
