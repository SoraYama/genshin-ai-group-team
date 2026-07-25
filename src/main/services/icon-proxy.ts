import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { protocol, net, app } from 'electron';

export const ICON_SCHEME = 'gtai-img';
const ENKA_BASE = 'https://enka.network/ui/';
const FILENAME_RE = /^[A-Za-z0-9_]+\.png$/;
const REMOTE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const TRUSTED_REMOTE_PATHS: Readonly<Record<string, RegExp>> = {
  'act-webstatic.mihoyo.com': /^\/hk4e\/e20200928calculate\/.+\.png$/,
  'uploadstatic.mihoyo.com': /^\/hk4e\/e20200928calculate\/.+\.png$/,
  'fastcdn.mihoyo.com': /^\/static-resource-v2\/.+\.png$/
};

export function registerIconProxyScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ICON_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: false
      }
    }
  ]);
}

export class IconProxyService {
  private readonly cacheDir: string;
  private readonly inflight = new Map<string, Promise<Buffer>>();

  constructor() {
    this.cacheDir = path.join(app.getPath('userData'), 'cache', 'icons');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    protocol.handle(ICON_SCHEME, async (request) => {
      try {
        return await this.serve(request.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'icon proxy error';
        return new Response(null, { status: 502, statusText: message });
      }
    });
  }

  private async serve(url: string): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.host === 'remote') {
      const upstream = resolveProxyUpstreamUrl(url);
      if (!upstream) return new Response(null, { status: 400 });
      const cacheName = `remote-${createHash('sha256').update(upstream).digest('hex')}.png`;
      return this.imageResponse(await this.getOrFetch(cacheName, upstream));
    }
    if (parsed.host !== 'avatar') return new Response(null, { status: 404 });
    const fileName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (!FILENAME_RE.test(fileName)) {
      return new Response(null, { status: 400 });
    }

    return this.imageResponse(await this.getOrFetch(fileName, `${ENKA_BASE}${fileName}`));
  }

  private imageResponse(buf: Buffer): Response {
    return new Response(buf, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400'
      }
    });
  }

  private async getOrFetch(cacheName: string, upstream: string): Promise<Buffer> {
    const cachePath = path.join(this.cacheDir, cacheName);
    try {
      return await fs.readFile(cachePath);
    } catch {
      // miss
    }

    const pending = this.inflight.get(cacheName);
    if (pending) {
      return pending;
    }

    const task = (async () => {
      const response = await net.fetch(upstream);
      if (!response.ok) {
        throw new Error(`Upstream icon failed: HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fs.writeFile(cachePath, buffer);
      return buffer;
    })().finally(() => {
      this.inflight.delete(cacheName);
    });

    this.inflight.set(cacheName, task);
    return task;
  }
}

export function buildIconUrl(iconFileName: string): string {
  if (!FILENAME_RE.test(iconFileName)) {
    throw new Error(`Invalid icon filename: ${iconFileName}`);
  }
  return `${ICON_SCHEME}://avatar/${iconFileName}`;
}

export function rewriteEnkaToProxyUrl(url: string): string {
  const ENKA_HTTPS_PREFIX = 'https://enka.network/ui/';
  if (!url.startsWith(ENKA_HTTPS_PREFIX)) {
    return url;
  }
  const fileName = url.slice(ENKA_HTTPS_PREFIX.length);
  if (!FILENAME_RE.test(fileName)) {
    return url;
  }
  return buildIconUrl(fileName);
}

export function rewriteIconToProxyUrl(url: string): string {
  const enka = rewriteEnkaToProxyUrl(url);
  if (enka !== url || url.startsWith(`${ICON_SCHEME}://`)) return enka;
  if (!isTrustedRemoteIconUrl(url)) return url;
  const token = Buffer.from(url, 'utf8').toString('base64url');
  return `${ICON_SCHEME}://remote/${token}`;
}

export function resolveProxyUpstreamUrl(proxyUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${ICON_SCHEME}:` || parsed.host !== 'remote') return undefined;
  const token = parsed.pathname.replace(/^\//, '');
  if (!REMOTE_TOKEN_RE.test(token)) return undefined;
  try {
    const upstream = Buffer.from(token, 'base64url').toString('utf8');
    return isTrustedRemoteIconUrl(upstream) ? upstream : undefined;
  } catch {
    return undefined;
  }
}

function isTrustedRemoteIconUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  return TRUSTED_REMOTE_PATHS[url.hostname]?.test(url.pathname) === true;
}
