import { promises as fs } from 'node:fs';

export interface DirectorySyncHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableDirectorySyncOptions {
  platform?: NodeJS.Platform;
  openDirectory?: (directoryPath: string) => Promise<DirectorySyncHandle>;
}

const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EISDIR',
  'EPERM',
  'EACCES',
  'EINVAL',
  'ENOTSUP'
]);

function isSupportedWindowsFallback(error: unknown, platform: NodeJS.Platform): boolean {
  return (
    platform === 'win32' &&
    WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has((error as NodeJS.ErrnoException).code ?? '')
  );
}

export async function durableDirectorySync(
  directoryPath: string,
  options: DurableDirectorySyncOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const openDirectory =
    options.openDirectory ??
    (async (target: string) => {
      const handle = await fs.open(target, 'r');
      return {
        sync: () => handle.sync(),
        close: () => handle.close()
      };
    });
  let handle: DirectorySyncHandle | undefined;
  try {
    handle = await openDirectory(directoryPath);
    await handle.sync();
  } catch (error) {
    if (!isSupportedWindowsFallback(error, platform)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}
