import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ScenarioEnvelope, SpiralAbyssScenario } from '../../../src/shared/domain.js';

async function makeTempDirs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-scenario-'));
  const bundled = path.join(root, 'bundled');
  const cache = path.join(root, 'cache');
  await fs.mkdir(bundled, { recursive: true });
  await fs.mkdir(cache, { recursive: true });
  return { root, bundled, cache };
}

function abyssEnvelope(version: string): ScenarioEnvelope<SpiralAbyssScenario> {
  return {
    mode: 'spiral-abyss',
    meta: {
      fetchedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      sourceVersion: version,
      expiresAt: new Date('2026-12-31T00:00:00Z').toISOString(),
      source: 'bundled'
    },
    scenario: {
      cycleId: 'test-cycle',
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-01-14T00:00:00Z',
      blessingOfAbyssalMoon: { name: 'Test', description: 'Test buff' },
      floors: []
    }
  };
}

async function writeBundled(dir: string) {
  for (const mode of ['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater']) {
    await fs.writeFile(
      path.join(dir, `${mode}.json`),
      JSON.stringify(abyssEnvelope(`bundled-${mode}`))
    );
  }
}

let tempRoot: string | undefined;

beforeEach(async () => {
  tempRoot = undefined;
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('ScenarioStore', () => {
  it('loads bundled JSON on first init and exposes meta via list()', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');

    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache });
    await store.init();

    const list = store.list();
    expect(list).toHaveLength(3);
    const abyss = list.find((s) => s.mode === 'spiral-abyss');
    expect(abyss?.meta.sourceVersion).toBe('bundled-spiral-abyss');
    const env = store.getScenario('spiral-abyss');
    expect(env.mode).toBe('spiral-abyss');
  });

  it('prefers cached JSON over bundled when present', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);
    await fs.writeFile(
      path.join(cache, 'spiral-abyss.json'),
      JSON.stringify(abyssEnvelope('cached-newer'))
    );
    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');

    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache });
    await store.init();
    expect(store.getScenario('spiral-abyss').meta.sourceVersion).toBe('cached-newer');
  });

  it('rejects scenario downloads whose sha256 does not match the manifest', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);

    const envelope = abyssEnvelope('remote-v2');
    const remoteText = JSON.stringify(envelope);
    const actualSha = createHash('sha256').update(remoteText).digest('hex');

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) {
        return {
          statusCode: 200,
          body: {
            text: async () =>
              JSON.stringify({
                updatedAt: 'manifest-v2',
                scenarios: {
                  'spiral-abyss': { url: 'https://example.com/abyss.json', sha256: 'definitely-wrong-' + actualSha }
                }
              })
          }
        };
      }
      return {
        statusCode: 200,
        body: {
          text: async () => remoteText,
          arrayBuffer: async () => new TextEncoder().encode(remoteText).buffer
        }
      };
    }) as unknown as typeof import('undici').request;

    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache, fetchImpl });
    await store.init();

    const refreshed = await store.refresh();
    expect(refreshed).toEqual([]);
    // Bundled value still wins.
    expect(store.getScenario('spiral-abyss').meta.sourceVersion).toBe('bundled-spiral-abyss');
  });

  it('writes remote refreshes through to cache and bumps source to remote', async () => {
    const { root, bundled, cache } = await makeTempDirs();
    tempRoot = root;
    await writeBundled(bundled);

    const envelope = abyssEnvelope('remote-v3');
    const remoteText = JSON.stringify(envelope);
    const sha = createHash('sha256').update(remoteText).digest('hex');

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) {
        return {
          statusCode: 200,
          body: {
            text: async () =>
              JSON.stringify({
                updatedAt: 'manifest-v3',
                scenarios: {
                  'spiral-abyss': { url: 'https://example.com/abyss.json', sha256: sha }
                }
              })
          }
        };
      }
      return {
        statusCode: 200,
        body: {
          text: async () => remoteText,
          arrayBuffer: async () => new TextEncoder().encode(remoteText).buffer
        }
      };
    }) as unknown as typeof import('undici').request;

    const { ScenarioStore } = await import('../../../src/main/services/scenario-store.js');
    const store = new ScenarioStore({ bundledDir: bundled, cacheDir: cache, fetchImpl });
    await store.init();
    const refreshed = await store.refresh();
    expect(refreshed).toContain('spiral-abyss');
    expect(store.getScenario('spiral-abyss').meta.source).toBe('remote');
    const cached = JSON.parse(await fs.readFile(path.join(cache, 'spiral-abyss.json'), 'utf8'));
    expect(cached.meta.source).toBe('remote');
  });
});
