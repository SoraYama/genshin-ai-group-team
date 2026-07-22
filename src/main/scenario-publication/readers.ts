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
    const targetPath = path.resolve(this.publicationRoot, publicationPath);
    if (
      targetPath !== this.publicationRoot &&
      !targetPath.startsWith(`${this.publicationRoot}${path.sep}`)
    ) {
      throw new ScenarioPublicationError('not-found');
    }
    try {
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
  text: string;
}

export type ScenarioHttpRequest = (url: URL, timeoutMs: number) => Promise<ScenarioHttpResponse>;

const defaultHttpRequest: ScenarioHttpRequest = async (url, timeoutMs) => {
  const response = await request(url, {
    method: 'GET',
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });
  return { statusCode: response.statusCode, text: await response.body.text() };
};

export interface HttpScenarioPublicationReaderOptions {
  manifestUrl: string;
  timeoutMs?: number;
  requestJson?: ScenarioHttpRequest;
}

export class HttpScenarioPublicationReader implements ScenarioPublicationReader {
  private readonly manifestUrl: URL;
  private readonly publicationBaseUrl: URL;
  private readonly timeoutMs: number;
  private readonly requestJson: ScenarioHttpRequest;

  constructor(options: HttpScenarioPublicationReaderOptions) {
    this.manifestUrl = new URL(options.manifestUrl);
    if (!['https:', 'http:'].includes(this.manifestUrl.protocol)) {
      throw new ScenarioPublicationError('manifest-invalid');
    }
    this.publicationBaseUrl = new URL('.', this.manifestUrl);
    this.timeoutMs = options.timeoutMs ?? 5_000;
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
    let response: ScenarioHttpResponse;
    try {
      response = await this.requestJson(url, this.timeoutMs);
    } catch (error) {
      if (error instanceof ScenarioPublicationError) throw error;
      throw new ScenarioPublicationError('network-unavailable', { cause: error });
    }
    if (response.statusCode === 404 || response.statusCode === 410) {
      throw new ScenarioPublicationError('not-found');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ScenarioPublicationError('network-unavailable');
    }
    return parseJson(response.text);
  }
}
