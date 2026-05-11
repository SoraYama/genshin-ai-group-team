import path from 'node:path';
import { promises as fs } from 'node:fs';
import { protocol, net, app } from 'electron';

export const ICON_SCHEME = 'gtai-img';
const ENKA_BASE = 'https://enka.network/ui/';
const FILENAME_RE = /^[A-Za-z0-9_]+\.png$/;

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
    if (parsed.host !== 'avatar') {
      return new Response(null, { status: 404 });
    }
    const fileName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (!FILENAME_RE.test(fileName)) {
      return new Response(null, { status: 400 });
    }

    const buf = await this.getOrFetch(fileName);
    return new Response(buf, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400'
      }
    });
  }

  private async getOrFetch(fileName: string): Promise<Buffer> {
    const cachePath = path.join(this.cacheDir, fileName);
    try {
      return await fs.readFile(cachePath);
    } catch {
      // miss
    }

    const pending = this.inflight.get(fileName);
    if (pending) {
      return pending;
    }

    const task = (async () => {
      const upstream = `${ENKA_BASE}${fileName}`;
      const response = await net.fetch(upstream);
      if (!response.ok) {
        throw new Error(`Upstream icon ${fileName} failed: HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fs.writeFile(cachePath, buffer);
      return buffer;
    })().finally(() => {
      this.inflight.delete(fileName);
    });

    this.inflight.set(fileName, task);
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
