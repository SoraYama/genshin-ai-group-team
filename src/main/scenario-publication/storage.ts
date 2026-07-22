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

type WritableFileHandle = Pick<FileHandle, 'writeFile' | 'sync' | 'close'>;

export interface AtomicFileSystem {
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  open(filePath: string, flags: 'wx', mode: number): Promise<WritableFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

const nodeFileSystem: AtomicFileSystem = {
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  unlink: (filePath) => fs.unlink(filePath)
};

export class FileScenarioPublicationStorage implements ScenarioPublicationStorage {
  constructor(
    private readonly cacheDirectory: string,
    private readonly fileSystem: AtomicFileSystem = nodeFileSystem
  ) {}

  async load(
    mode: ScenarioModeV2,
    use: ScenarioPublicationUse
  ): Promise<StoredScenarioPublication | undefined> {
    try {
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

  async save(
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
    const temporaryPath = path.join(scopedDirectory, `.${mode}.${randomUUID()}.tmp`);
    let handle: WritableFileHandle | undefined;
    try {
      await this.fileSystem.mkdir(scopedDirectory, { recursive: true });
      handle = await this.fileSystem.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fileSystem.rename(temporaryPath, finalPath);
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
}
