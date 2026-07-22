import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FileScenarioPublicationReader,
  HttpScenarioPublicationReader
} from '../../../src/main/scenario-publication/readers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('FileScenarioPublicationReader', () => {
  it('reads only JSON documents below its configured publication root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-reader-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'publications'), { recursive: true });
    await fs.writeFile(path.join(root, 'manifest.json'), '{"manifestVersion":1}', 'utf8');
    await fs.writeFile(path.join(root, 'publications', 'payload.json'), '{"ok":true}', 'utf8');
    const reader = new FileScenarioPublicationReader(root);

    await expect(reader.readManifest()).resolves.toEqual({ manifestVersion: 1 });
    await expect(reader.readJson('publications/payload.json')).resolves.toEqual({ ok: true });
    await expect(reader.readJson('../outside.json')).rejects.toMatchObject({
      code: 'not-found'
    });
  });
});

describe('HttpScenarioPublicationReader', () => {
  it('resolves relative publication paths under the manifest origin', async () => {
    const requestJson = vi.fn(async (url: URL) => ({
      statusCode: 200,
      text: JSON.stringify({ url: url.href })
    }));
    const reader = new HttpScenarioPublicationReader({
      manifestUrl: 'https://data.example.test/releases/manifest.json',
      requestJson
    });

    await expect(reader.readJson('publications/payload.json')).resolves.toEqual({
      url: 'https://data.example.test/releases/publications/payload.json'
    });
  });

  it.each([404, 410])('maps HTTP %s to a sanitized not-found error', async (statusCode) => {
    const reader = new HttpScenarioPublicationReader({
      manifestUrl: 'https://data.example.test/manifest.json',
      requestJson: async () => ({ statusCode, text: 'provider secret details' })
    });

    const error = await reader.readManifest().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'not-found' });
    expect((error as Error).message).not.toContain('provider secret details');
  });

  it('maps transport and malformed JSON failures to typed errors', async () => {
    const networkReader = new HttpScenarioPublicationReader({
      manifestUrl: 'https://data.example.test/manifest.json',
      requestJson: async () => {
        throw new Error('Authorization: top-secret');
      }
    });
    const malformedReader = new HttpScenarioPublicationReader({
      manifestUrl: 'https://data.example.test/manifest.json',
      requestJson: async () => ({ statusCode: 200, text: '{broken' })
    });

    await expect(networkReader.readManifest()).rejects.toMatchObject({
      code: 'network-unavailable'
    });
    const malformed = await malformedReader.readManifest().catch((caught: unknown) => caught);
    expect(malformed).toMatchObject({ code: 'invalid-json' });
    expect((malformed as Error).message).not.toContain('{broken');
  });
});
