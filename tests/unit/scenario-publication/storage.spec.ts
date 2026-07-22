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
      open: fs.open.bind(fs),
      rename: async () => {
        throw new Error('simulated rename failure');
      },
      unlink: fs.unlink.bind(fs)
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
});
