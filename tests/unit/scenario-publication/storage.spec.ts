import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import type { AtomicFileSystem } from '../../../src/main/scenario-publication/storage.js';
import { FileScenarioPublicationStorage } from '../../../src/main/scenario-publication/storage.js';
import { createScenarioPublication } from '../../../src/main/scenario-publication/publication.js';
import { makeScenario } from './fixtures.js';

const roots: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-publication-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function stored(suffix: string) {
  const pair = generateKeyPairSync('ed25519');
  return {
    publication: createScenarioPublication(makeScenario('spiral-abyss', suffix, `dev.${suffix}`), {
      keyId: 'storage-test',
      privateKey: pair.privateKey
    }),
    savedAt: '2026-01-15T00:00:00.000Z'
  };
}

describe('FileScenarioPublicationStorage', () => {
  it('round-trips a strict publication under cache/scenarios', async () => {
    const root = await temporaryRoot();
    const storage = new FileScenarioPublicationStorage(root);
    const value = stored('one');

    await storage.save('spiral-abyss', 'production', value);

    await expect(storage.load('spiral-abyss', 'production')).resolves.toEqual(value);
    await expect(
      fs.stat(path.join(root, 'production', 'spiral-abyss.json'))
    ).resolves.toBeDefined();
  });

  it('leaves the previous last-known-good intact when rename fails', async () => {
    const root = await temporaryRoot();
    const goodStorage = new FileScenarioPublicationStorage(root);
    const previous = stored('previous');
    await goodStorage.save('spiral-abyss', 'production', previous);

    const failingFileSystem: AtomicFileSystem = {
      mkdir: fs.mkdir.bind(fs),
      readFile: fs.readFile.bind(fs),
      readdir: fs.readdir.bind(fs),
      open: fs.open.bind(fs),
      rename: async () => {
        throw new Error('simulated rename failure');
      },
      unlink: fs.unlink.bind(fs),
      syncDirectory: async () => undefined
    };
    const failingStorage = new FileScenarioPublicationStorage(root, failingFileSystem);

    await expect(
      failingStorage.save('spiral-abyss', 'production', stored('replacement'))
    ).rejects.toMatchObject({
      code: 'storage-write-failed'
    });
    await expect(goodStorage.load('spiral-abyss', 'production')).resolves.toEqual(previous);
    expect(
      (await fs.readdir(path.join(root, 'production'))).filter((name) => name.endsWith('.tmp'))
    ).toEqual([]);
  });

  it('isolates production and development last-known-good namespaces', async () => {
    const root = await temporaryRoot();
    const storage = new FileScenarioPublicationStorage(root);
    const production = stored('production');
    const development = stored('development');

    await storage.save('spiral-abyss', 'production', production);
    await storage.save('spiral-abyss', 'development-sample', development);

    await expect(storage.load('spiral-abyss', 'production')).resolves.toEqual(production);
    await expect(storage.load('spiral-abyss', 'development-sample')).resolves.toEqual(development);
  });

  it('cleans only its controlled temporary files and fsyncs the parent after rename', async () => {
    const root = await temporaryRoot();
    const scopedDirectory = path.join(root, 'production');
    await fs.mkdir(scopedDirectory, { recursive: true });
    const owned = '.spiral-abyss.scenario-cache-00000000-0000-4000-8000-000000000000.tmp';
    const foreign = '.do-not-delete.tmp';
    await fs.writeFile(path.join(scopedDirectory, owned), 'owned');
    await fs.writeFile(path.join(scopedDirectory, foreign), 'foreign');
    const events: string[] = [];
    const fileSystem: AtomicFileSystem = {
      mkdir: fs.mkdir.bind(fs),
      readFile: fs.readFile.bind(fs),
      readdir: fs.readdir.bind(fs),
      open: fs.open.bind(fs),
      rename: async (oldPath, newPath) => {
        events.push(`rename:${path.basename(newPath)}`);
        await fs.rename(oldPath, newPath);
      },
      unlink: fs.unlink.bind(fs),
      syncDirectory: async (directoryPath) => {
        events.push(`sync:${directoryPath}`);
        const handle = await fs.open(directoryPath, 'r');
        await handle.sync();
        await handle.close();
      }
    };
    const storage = new FileScenarioPublicationStorage(root, fileSystem);

    await storage.save('spiral-abyss', 'production', stored('durable'));

    await expect(fs.stat(path.join(scopedDirectory, owned))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(fs.readFile(path.join(scopedDirectory, foreign), 'utf8')).resolves.toBe('foreign');
    expect(events).toEqual(['rename:spiral-abyss.json', `sync:${scopedDirectory}`]);
  });

  it('serializes concurrent saves so temp cleanup cannot delete an in-flight write', async () => {
    const root = await temporaryRoot();
    const scopedDirectory = path.join(root, 'production');
    await fs.mkdir(scopedDirectory, { recursive: true });
    const foreign = path.join(scopedDirectory, '.foreign.tmp');
    await fs.writeFile(foreign, 'foreign');
    const firstSyncStarted = deferred();
    const releaseFirstSync = deferred();
    let openCount = 0;
    const fileSystem: AtomicFileSystem = {
      mkdir: fs.mkdir.bind(fs),
      readFile: fs.readFile.bind(fs),
      readdir: fs.readdir.bind(fs),
      open: async (filePath, flags, mode) => {
        const handle = await fs.open(filePath, flags, mode);
        openCount += 1;
        const ordinal = openCount;
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            if (ordinal === 1) {
              firstSyncStarted.resolve();
              await releaseFirstSync.promise;
            }
            await handle.sync();
          },
          close: handle.close.bind(handle)
        };
      },
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
      syncDirectory: async () => undefined
    };
    const storage = new FileScenarioPublicationStorage(root, fileSystem);
    const secondStorage = new FileScenarioPublicationStorage(root, fileSystem);

    const firstSave = storage.save('spiral-abyss', 'production', stored('concurrent-first'));
    await firstSyncStarted.promise;
    const secondValue = stored('concurrent-second');
    const secondSave = secondStorage.save('spiral-abyss', 'production', secondValue);
    await Promise.resolve();
    await Promise.resolve();
    const observedOpenCount = openCount;
    releaseFirstSync.resolve();
    const results = await Promise.allSettled([firstSave, secondSave]);

    expect(observedOpenCount).toBe(1);
    expect(results.every(({ status }) => status === 'fulfilled')).toBe(true);
    await expect(storage.load('spiral-abyss', 'production')).resolves.toEqual(secondValue);
    await expect(fs.readFile(foreign, 'utf8')).resolves.toBe('foreign');
  });
});
