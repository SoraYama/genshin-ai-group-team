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

  it('rejects symlinked publication files and directories that escape its root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-reader-'));
    roots.push(root);
    const publicationRoot = path.join(root, 'publication-root');
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(publicationRoot, 'publications'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.json'), '{"secret":true}', 'utf8');
    await fs.symlink(
      path.join(outside, 'secret.json'),
      path.join(publicationRoot, 'publications', 'linked-file.json')
    );
    await fs.symlink(outside, path.join(publicationRoot, 'linked-directory'));
    const reader = new FileScenarioPublicationReader(publicationRoot);

    await expect(reader.readJson('publications/linked-file.json')).rejects.toMatchObject({
      code: 'unsafe-path'
    });
    await expect(reader.readJson('linked-directory/secret.json')).rejects.toMatchObject({
      code: 'unsafe-path'
    });
  });
});

describe('HttpScenarioPublicationReader', () => {
  function response(text: string, statusCode = 200, headers: Record<string, string> = {}) {
    return {
      statusCode,
      headers,
      body: (async function* () {
        yield Buffer.from(text);
      })()
    };
  }

  it('resolves relative publication paths under the manifest origin', async () => {
    const requestJson = vi.fn(async (url: URL) => response(JSON.stringify({ url: url.href })));
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
      requestJson: async () => response('provider secret details', statusCode)
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
      requestJson: async () => response('{broken')
    });

    await expect(networkReader.readManifest()).rejects.toMatchObject({
      code: 'network-unavailable'
    });
    const malformed = await malformedReader.readManifest().catch((caught: unknown) => caught);
    expect(malformed).toMatchObject({ code: 'invalid-json' });
    expect((malformed as Error).message).not.toContain('{broken');
  });

  it('requires HTTPS unless insecure loopback access is explicitly enabled', async () => {
    expect(
      () =>
        new HttpScenarioPublicationReader({ manifestUrl: 'http://data.example.test/manifest.json' })
    ).toThrowError(expect.objectContaining({ code: 'manifest-invalid' }));
    expect(
      () => new HttpScenarioPublicationReader({ manifestUrl: 'http://127.0.0.1/manifest.json' })
    ).toThrowError(expect.objectContaining({ code: 'manifest-invalid' }));

    const loopback = new HttpScenarioPublicationReader({
      manifestUrl: 'http://127.0.0.1/manifest.json',
      allowInsecureLoopback: true,
      requestJson: async () => response('{"ok":true}')
    });
    await expect(loopback.readManifest()).resolves.toEqual({ ok: true });
  });

  it('rejects an oversized Content-Length before consuming the response body', async () => {
    let consumed = false;
    const reader = new HttpScenarioPublicationReader({
      manifestUrl: 'https://data.example.test/manifest.json',
      maxResponseBytes: 8,
      requestJson: async () => ({
        statusCode: 200,
        headers: { 'content-length': '9' },
        body: (async function* () {
          consumed = true;
          yield Buffer.from('{"ok":1}');
        })()
      })
    });

    await expect(reader.readManifest()).rejects.toMatchObject({ code: 'response-too-large' });
    expect(consumed).toBe(false);
  });

  it('caps chunked bodies while streaming', async () => {
    const reader = new HttpScenarioPublicationReader({
      manifestUrl: 'https://data.example.test/manifest.json',
      maxResponseBytes: 8,
      requestJson: async () => ({
        statusCode: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from('{"ok":');
          yield Buffer.from('true}');
        })()
      })
    });

    await expect(reader.readManifest()).rejects.toMatchObject({ code: 'response-too-large' });
  });

  it('applies one total abort deadline across request and body streaming', async () => {
    const requestHang = new HttpScenarioPublicationReader({
      manifestUrl: 'https://data.example.test/manifest.json',
      timeoutMs: 10,
      requestJson: async (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    });
    const streamHang = new HttpScenarioPublicationReader({
      manifestUrl: 'https://data.example.test/manifest.json',
      timeoutMs: 10,
      requestJson: async () => ({
        statusCode: 200,
        headers: {},
        body: {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) };
          }
        }
      })
    });

    await expect(requestHang.readManifest()).rejects.toMatchObject({ code: 'network-timeout' });
    await expect(streamHang.readManifest()).rejects.toMatchObject({ code: 'network-timeout' });
  });
});
