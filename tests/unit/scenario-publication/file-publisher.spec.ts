import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { publishScenarioInputDirectory } from '../../../src/main/scenario-publication/file-publisher.js';
import { FileScenarioPublicationReader } from '../../../src/main/scenario-publication/readers.js';
import { scenarioPublicationManifestSchema } from '../../../src/main/scenario-publication/contracts.js';
import { makeScenario } from './fixtures.js';

const roots: string[] = [];

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
});
