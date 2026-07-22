import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  publishScenarioInputDirectory,
  type PublisherFileSystem
} from '../../../src/main/scenario-publication/file-publisher.js';
import { FileScenarioPublicationReader } from '../../../src/main/scenario-publication/readers.js';
import { scenarioPublicationManifestSchema } from '../../../src/main/scenario-publication/contracts.js';
import { makeScenario } from './fixtures.js';

const roots: string[] = [];

async function writeSingleInput(inputDirectory: string, payload = makeScenario('spiral-abyss')) {
  await fs.mkdir(inputDirectory, { recursive: true });
  await fs.writeFile(path.join(inputDirectory, 'abyss.json'), JSON.stringify(payload), 'utf8');
  await fs.writeFile(
    path.join(inputDirectory, 'index.json'),
    JSON.stringify({
      candidates: [{ inputFile: 'abyss.json', current: true, channel: 'production' }]
    }),
    'utf8'
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('offline directory publisher', () => {
  it('reads reviewed inputs and publishes documents before a strict manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-offline-publisher-'));
    roots.push(root);
    const inputDirectory = path.join(root, 'input');
    const outputDirectory = path.join(root, 'output');
    await fs.mkdir(inputDirectory, { recursive: true });
    const candidates = [
      ['abyss.json', makeScenario('spiral-abyss')],
      ['stygian.json', makeScenario('stygian-onslaught')],
      ['theater.json', makeScenario('imaginarium-theater')]
    ] as const;
    for (const [fileName, payload] of candidates) {
      await fs.writeFile(path.join(inputDirectory, fileName), JSON.stringify(payload), 'utf8');
    }
    await fs.writeFile(
      path.join(inputDirectory, 'index.json'),
      JSON.stringify({
        notice: 'Production publisher test input',
        candidates: candidates.map(([inputFile]) => ({
          inputFile,
          current: true,
          channel: 'production'
        }))
      }),
      'utf8'
    );
    const keys = generateKeyPairSync('ed25519');

    const manifest = await publishScenarioInputDirectory({
      inputDirectory,
      outputDirectory,
      keyId: 'local-test-key',
      privateKey: keys.privateKey,
      publishedAt: '2026-01-01T02:00:00.000Z'
    });

    expect(scenarioPublicationManifestSchema.parse(manifest)).toEqual(manifest);
    const reader = new FileScenarioPublicationReader(outputDirectory);
    await expect(reader.readManifest()).resolves.toEqual(manifest);
  });

  it('rejects input-index traversal before reading outside the source directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-offline-publisher-'));
    roots.push(root);
    await fs.writeFile(
      path.join(root, 'index.json'),
      JSON.stringify({
        candidates: [{ inputFile: '../outside.json', current: true, channel: 'development-sample' }]
      }),
      'utf8'
    );
    const keys = generateKeyPairSync('ed25519');

    await expect(
      publishScenarioInputDirectory({
        inputDirectory: root,
        outputDirectory: path.join(root, 'output'),
        keyId: 'local-test-key',
        privateKey: keys.privateKey,
        publishedAt: '2026-01-01T02:00:00.000Z'
      })
    ).rejects.toMatchObject({ code: 'manifest-invalid' });
  });

  it('republishes identical identities safely and rejects changed content with the same identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-offline-publisher-'));
    roots.push(root);
    const inputDirectory = path.join(root, 'input');
    const outputDirectory = path.join(root, 'output');
    const payload = makeScenario('spiral-abyss');
    if (payload.mode !== 'spiral-abyss') throw new Error('Unexpected fixture mode');
    await writeSingleInput(inputDirectory, payload);
    const keys = generateKeyPairSync('ed25519');
    const options = {
      inputDirectory,
      outputDirectory,
      keyId: 'local-test-key',
      privateKey: keys.privateKey,
      publishedAt: '2026-01-01T02:00:00.000Z'
    };

    const first = await publishScenarioInputDirectory(options);
    const ownedTemp = path.join(
      outputDirectory,
      '.manifest.json.scenario-publisher-00000000-0000-4000-8000-000000000000.tmp'
    );
    const foreignTemp = path.join(outputDirectory, '.foreign.tmp');
    await fs.writeFile(ownedTemp, 'controlled leftover');
    await fs.writeFile(foreignTemp, 'foreign file');
    await expect(publishScenarioInputDirectory(options)).resolves.toEqual(first);
    expect(first.modes['spiral-abyss'].history).toHaveLength(1);
    await expect(fs.stat(ownedTemp)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(foreignTemp, 'utf8')).resolves.toBe('foreign file');

    const immutablePayloadPath = path.join(
      outputDirectory,
      first.modes['spiral-abyss'].current!.payloadPath
    );
    await fs.writeFile(immutablePayloadPath, '{}\n', 'utf8');
    const committedBeforeConflict = await fs.readFile(
      path.join(outputDirectory, 'manifest.json'),
      'utf8'
    );
    await expect(publishScenarioInputDirectory(options)).rejects.toMatchObject({
      code: 'immutable-path-conflict'
    });
    await expect(fs.readFile(immutablePayloadPath, 'utf8')).resolves.toBe('{}\n');
    await expect(fs.readFile(path.join(outputDirectory, 'manifest.json'), 'utf8')).resolves.toBe(
      committedBeforeConflict
    );

    await writeSingleInput(inputDirectory, {
      ...payload,
      blessing: { id: payload.blessing.id, description: 'changed under the same identity' }
    });
    const committedManifest = await fs.readFile(
      path.join(outputDirectory, 'manifest.json'),
      'utf8'
    );
    await expect(publishScenarioInputDirectory(options)).rejects.toMatchObject({
      code: 'identity-mismatch'
    });
    await expect(fs.readFile(path.join(outputDirectory, 'manifest.json'), 'utf8')).resolves.toBe(
      committedManifest
    );
  });

  it('rejects symlinked inputs and output directories without writing outside either root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-offline-publisher-'));
    roots.push(root);
    const inputDirectory = path.join(root, 'input');
    const outputDirectory = path.join(root, 'output');
    const outside = path.join(root, 'outside');
    await fs.mkdir(inputDirectory, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(
      path.join(outside, 'abyss.json'),
      JSON.stringify(makeScenario('spiral-abyss'))
    );
    await fs.symlink(path.join(outside, 'abyss.json'), path.join(inputDirectory, 'abyss.json'));
    await fs.writeFile(
      path.join(inputDirectory, 'index.json'),
      JSON.stringify({
        candidates: [{ inputFile: 'abyss.json', current: true, channel: 'production' }]
      })
    );
    const keys = generateKeyPairSync('ed25519');
    const options = {
      inputDirectory,
      outputDirectory,
      keyId: 'local-test-key',
      privateKey: keys.privateKey,
      publishedAt: '2026-01-01T02:00:00.000Z'
    };

    await expect(publishScenarioInputDirectory(options)).rejects.toMatchObject({
      code: 'unsafe-path'
    });

    await fs.unlink(path.join(inputDirectory, 'abyss.json'));
    await fs.writeFile(
      path.join(inputDirectory, 'abyss.json'),
      JSON.stringify(makeScenario('spiral-abyss'))
    );
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.symlink(outside, path.join(outputDirectory, 'publications'));
    await expect(publishScenarioInputDirectory(options)).rejects.toMatchObject({
      code: 'unsafe-path'
    });
    await expect(fs.readdir(outside)).resolves.toEqual(['abyss.json']);
  });

  it('keeps the prior manifest when its final rename crashes after durable document writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-offline-publisher-'));
    roots.push(root);
    const inputDirectory = path.join(root, 'input');
    const outputDirectory = path.join(root, 'output');
    await writeSingleInput(inputDirectory);
    const keys = generateKeyPairSync('ed25519');
    const baseOptions = {
      inputDirectory,
      outputDirectory,
      keyId: 'local-test-key',
      privateKey: keys.privateKey,
      publishedAt: '2026-01-01T02:00:00.000Z'
    };
    await publishScenarioInputDirectory(baseOptions);
    const priorManifest = await fs.readFile(path.join(outputDirectory, 'manifest.json'), 'utf8');
    await writeSingleInput(inputDirectory, makeScenario('spiral-abyss', 'next-cycle', '2026.02'));
    const events: string[] = [];
    const crashingFileSystem: PublisherFileSystem = {
      lstat: fs.lstat.bind(fs),
      realpath: fs.realpath.bind(fs),
      mkdir: fs.mkdir.bind(fs),
      readFile: fs.readFile.bind(fs),
      readdir: fs.readdir.bind(fs),
      open: async (filePath, flags, mode) => {
        const handle = await fs.open(filePath, flags, mode);
        events.push(`open:${path.basename(filePath)}`);
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            events.push(`file-sync:${path.basename(filePath)}`);
            await handle.sync();
          },
          close: handle.close.bind(handle)
        };
      },
      link: async (existingPath, newPath) => {
        events.push(`link:${path.basename(newPath)}`);
        await fs.link(existingPath, newPath);
      },
      rename: async (oldPath, newPath) => {
        events.push(`rename:${path.basename(newPath)}`);
        if (path.basename(newPath) === 'manifest.json') throw new Error('simulated crash');
        await fs.rename(oldPath, newPath);
      },
      unlink: fs.unlink.bind(fs),
      syncDirectory: async (directoryPath) => {
        events.push(`dir-sync:${path.basename(directoryPath)}`);
        const handle = await fs.open(directoryPath, 'r');
        await handle.sync();
        await handle.close();
      }
    };

    await expect(
      publishScenarioInputDirectory({ ...baseOptions, fileSystem: crashingFileSystem })
    ).rejects.toMatchObject({ code: 'storage-write-failed' });
    const manifestOpen = events.findIndex((event) => event.startsWith('open:.manifest.json'));
    const lastDocumentDirectorySync = events
      .slice(0, manifestOpen)
      .reverse()
      .findIndex((event) => event.startsWith('dir-sync:'));
    expect(lastDocumentDirectorySync).toBeGreaterThanOrEqual(0);
    expect(events).toContain('rename:manifest.json');
    await expect(fs.readFile(path.join(outputDirectory, 'manifest.json'), 'utf8')).resolves.toBe(
      priorManifest
    );
  });
});
