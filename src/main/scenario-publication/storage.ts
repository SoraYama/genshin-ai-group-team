import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  storedScenarioPublicationSchema,
  type ScenarioModeV2,
  type ScenarioPublicationUse,
  type ScenarioPublicationStorage,
  type StoredScenarioPublication
} from './contracts.js';
import { ScenarioPublicationError } from './errors.js';
import { durableDirectorySync } from './durable-directory-sync.js';

type WritableFileHandle = Pick<FileHandle, 'writeFile' | 'sync' | 'close'>;

export interface AtomicFileSystem {
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  readdir(directoryPath: string): Promise<string[]>;
  open(filePath: string, flags: 'wx', mode: number): Promise<WritableFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  syncDirectory(directoryPath: string): Promise<void>;
}

const nodeFileSystem: AtomicFileSystem = {
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  readdir: (directoryPath) => fs.readdir(directoryPath),
  open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  unlink: (filePath) => fs.unlink(filePath),
  syncDirectory: durableDirectorySync
};

const fileStorageOperationQueues = new Map<string, Promise<void>>();

export class FileScenarioPublicationStorage implements ScenarioPublicationStorage {
  constructor(
    private readonly cacheDirectory: string,
    private readonly fileSystem: AtomicFileSystem = nodeFileSystem
  ) {}

  load(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse
  ): Promise<StoredScenarioPublication | undefined> {
    return this.runExclusive(mode, use, () => this.loadOnce(mode, use));
  }

  private async loadOnce(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse
  ): Promise<StoredScenarioPublication | undefined> {
    try {
      await this.cleanupOwnedTemps(mode, use);
      const raw = await this.fileSystem.readFile(this.cachePath(mode, use), 'utf8');
      const result = storedScenarioPublicationSchema.safeParse(JSON.parse(raw));
      if (!result.success) throw new ScenarioPublicationError('storage-read-failed');
      return result.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof ScenarioPublicationError) throw error;
      throw new ScenarioPublicationError('storage-read-failed', { cause: error });
    }
  }

  save(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse,
    value: StoredScenarioPublication
  ): Promise<void> {
    return this.runExclusive(mode, use, () => this.saveOnce(mode, use, value));
  }

  private async saveOnce(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse,
    value: StoredScenarioPublication
  ): Promise<void> {
    const parsed = storedScenarioPublicationSchema.safeParse(value);
    if (!parsed.success) {
      throw new ScenarioPublicationError('storage-write-failed', { cause: parsed.error });
    }
    const scopedDirectory = path.join(this.cacheDirectory, use);
    const finalPath = this.cachePath(mode, use);
    const temporaryPath = path.join(scopedDirectory, `.${mode}.scenario-cache-${randomUUID()}.tmp`);
    let handle: WritableFileHandle | undefined;
    try {
      await this.fileSystem.mkdir(scopedDirectory, { recursive: true });
      await this.cleanupOwnedTemps(mode, use);
      handle = await this.fileSystem.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fileSystem.rename(temporaryPath, finalPath);
      await this.fileSystem.syncDirectory(scopedDirectory);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await this.fileSystem.unlink(temporaryPath).catch(() => undefined);
      throw new ScenarioPublicationError('storage-write-failed', { cause: error });
    }
  }

  private cachePath(mode: ScenarioModeV2, use: ScenarioPublicationUse): string {
    return path.join(this.cacheDirectory, use, `${mode}.json`);
  }

  private runExclusive<T>(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse,
    operation: () => Promise<T>
  ): Promise<T> {
    const queueKey = JSON.stringify([path.resolve(this.cacheDirectory), use, mode]);
    const previous = fileStorageOperationQueues.get(queueKey) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    fileStorageOperationQueues.set(queueKey, tail);
    void tail.then(() => {
      if (fileStorageOperationQueues.get(queueKey) === tail) {
        fileStorageOperationQueues.delete(queueKey);
      }
    });
    return run;
  }

  private async cleanupOwnedTemps(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse
  ): Promise<void> {
    const scopedDirectory = path.join(this.cacheDirectory, use);
    const pattern = new RegExp(
      `^\\.${mode}\\.scenario-cache-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`,
      'i'
    );
    let entries: string[];
    try {
      entries = await this.fileSystem.readdir(scopedDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      entries
        .filter((entry) => pattern.test(entry))
        .map((entry) =>
          this.fileSystem.unlink(path.join(scopedDirectory, entry)).catch(() => undefined)
        )
    );
  }
}
