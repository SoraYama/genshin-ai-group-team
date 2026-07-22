import { describe, expect, it, vi } from 'vitest';

import { durableDirectorySync } from '../../../src/main/scenario-publication/durable-directory-sync.js';

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('durableDirectorySync', () => {
  it('opens, syncs, and closes directories on POSIX', async () => {
    const sync = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const openDirectory = vi.fn(async () => ({ sync, close }));

    await durableDirectorySync('/publication', { platform: 'darwin', openDirectory });

    expect(openDirectory).toHaveBeenCalledWith('/publication');
    expect(sync).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'])(
    'degrades safely for Windows directory sync limitation %s',
    async (code) => {
      await expect(
        durableDirectorySync('C:\\publication', {
          platform: 'win32',
          openDirectory: async () => {
            throw nodeError(code);
          }
        })
      ).resolves.toBeUndefined();
    }
  );

  it('closes a Windows directory handle when sync itself reports an unsupported operation', async () => {
    const close = vi.fn(async () => undefined);
    await expect(
      durableDirectorySync('C:\\publication', {
        platform: 'win32',
        openDirectory: async () => ({
          sync: async () => {
            throw nodeError('EPERM');
          },
          close
        })
      })
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ['win32', 'EIO'],
    ['linux', 'EPERM']
  ] as const)('fails closed for %s error %s', async (platform, code) => {
    await expect(
      durableDirectorySync('/publication', {
        platform,
        openDirectory: async () => {
          throw nodeError(code);
        }
      })
    ).rejects.toMatchObject({ code });
  });
});
