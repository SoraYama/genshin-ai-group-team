import { promises as fs } from 'node:fs';
import path from 'node:path';
import { request } from 'undici';

import type { ScenarioPublicationReader } from './contracts.js';
import { ScenarioPublicationError } from './errors.js';

function assertSafeRelativeJsonPath(publicationPath: string): void {
  if (
    !/^[A-Za-z0-9._/-]+\.json$/.test(publicationPath) ||
    publicationPath.startsWith('/') ||
    publicationPath.includes('\\') ||
    publicationPath.split('/').some((segment) => segment === '..' || segment.length === 0)
  ) {
    throw new ScenarioPublicationError('not-found');
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ScenarioPublicationError('invalid-json', { cause: error });
  }
}

export class FileScenarioPublicationReader implements ScenarioPublicationReader {
  private readonly publicationRoot: string;

  constructor(publicationRoot: string) {
    this.publicationRoot = path.resolve(publicationRoot);
  }

  readManifest(): Promise<unknown> {
    return this.readJson('manifest.json');
  }

  async readJson(publicationPath: string): Promise<unknown> {
    assertSafeRelativeJsonPath(publicationPath);
    try {
      const rootStat = await fs.lstat(this.publicationRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new ScenarioPublicationError('unsafe-path');
      }
      const realRoot = await fs.realpath(this.publicationRoot);
      let targetPath = realRoot;
      const segments = publicationPath.split('/');
      for (const [index, segment] of segments.entries()) {
        targetPath = path.join(targetPath, segment);
        const stat = await fs.lstat(targetPath);
        if (stat.isSymbolicLink()) throw new ScenarioPublicationError('unsafe-path');
        if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
          throw new ScenarioPublicationError('unsafe-path');
        }
      }
      return parseJson(await fs.readFile(targetPath, 'utf8'));
    } catch (error) {
      if (error instanceof ScenarioPublicationError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ScenarioPublicationError('not-found');
      }
      throw new ScenarioPublicationError('network-unavailable', { cause: error });
    }
  }
}

export interface ScenarioHttpResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
}

export type ScenarioHttpRequest = (url: URL, signal: AbortSignal) => Promise<ScenarioHttpResponse>;

const defaultHttpRequest: ScenarioHttpRequest = async (url, signal) => {
  const response = await request(url, {
    method: 'GET',
    signal
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body
  };
};

export interface HttpScenarioPublicationReaderOptions {
  manifestUrl: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowInsecureLoopback?: boolean;
  requestJson?: ScenarioHttpRequest;
}

export class HttpScenarioPublicationReader implements ScenarioPublicationReader {
  private readonly manifestUrl: URL;
  private readonly publicationBaseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly requestJson: ScenarioHttpRequest;

  constructor(options: HttpScenarioPublicationReaderOptions) {
    this.manifestUrl = new URL(options.manifestUrl);
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.manifestUrl.hostname);
    if (
      this.manifestUrl.protocol !== 'https:' &&
      !(
        this.manifestUrl.protocol === 'http:' &&
        isLoopback &&
        options.allowInsecureLoopback === true
      )
    ) {
      throw new ScenarioPublicationError('manifest-invalid');
    }
    this.publicationBaseUrl = new URL('.', this.manifestUrl);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ScenarioPublicationError('manifest-invalid');
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new ScenarioPublicationError('manifest-invalid');
    }
    this.requestJson = options.requestJson ?? defaultHttpRequest;
  }

  readManifest(): Promise<unknown> {
    return this.readUrl(this.manifestUrl);
  }

  readJson(publicationPath: string): Promise<unknown> {
    assertSafeRelativeJsonPath(publicationPath);
    const target = new URL(publicationPath, this.publicationBaseUrl);
    if (
      target.origin !== this.publicationBaseUrl.origin ||
      !target.pathname.startsWith(this.publicationBaseUrl.pathname)
    ) {
      throw new ScenarioPublicationError('not-found');
    }
    return this.readUrl(target);
  }

  private async readUrl(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const deadline = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new ScenarioPublicationError('network-timeout')),
        { once: true }
      );
    });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await Promise.race([this.requestJson(url, controller.signal), deadline]);
      if (response.statusCode === 404 || response.statusCode === 410) {
        throw new ScenarioPublicationError('not-found');
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ScenarioPublicationError('network-unavailable');
      }

      const contentLengthHeader = Object.entries(response.headers).find(
        ([name]) => name.toLowerCase() === 'content-length'
      )?.[1];
      const contentLengthValue = Array.isArray(contentLengthHeader)
        ? contentLengthHeader[0]
        : contentLengthHeader;
      if (contentLengthValue !== undefined) {
        const contentLength = Number(contentLengthValue);
        if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
          throw new ScenarioPublicationError('response-too-large');
        }
      }

      const chunks: Buffer[] = [];
      let byteLength = 0;
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        byteLength += chunk.byteLength;
        if (byteLength > this.maxResponseBytes) {
          throw new ScenarioPublicationError('response-too-large');
        }
        chunks.push(chunk);
      }
      return parseJson(Buffer.concat(chunks, byteLength).toString('utf8'));
    } catch (error) {
      if (error instanceof ScenarioPublicationError) throw error;
      if (controller.signal.aborted) throw new ScenarioPublicationError('network-timeout');
      throw new ScenarioPublicationError('network-unavailable', { cause: error });
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
  }
}
