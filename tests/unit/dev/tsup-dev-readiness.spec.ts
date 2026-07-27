import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { createTsupOptions } from '../../../tsup.config.js';

describe('tsup dev readiness', () => {
  it('publishes readiness only after both dev targets succeed', async () => {
    const writeReady = vi.fn(async () => undefined);
    const [main, preload] = createTsupOptions({ devWatch: true, writeReady });

    await invokeOnSuccess(main?.onSuccess);
    expect(writeReady).not.toHaveBeenCalled();

    await invokeOnSuccess(preload?.onSuccess);
    expect(writeReady).toHaveBeenCalledTimes(1);
  });

  it('publishes the marker once across repeated success callbacks', async () => {
    const writeReady = vi.fn(async () => undefined);
    const [main, preload] = createTsupOptions({ devWatch: true, writeReady });

    expect(main?.clean).toBe(false);
    await invokeOnSuccess(main?.onSuccess);
    await invokeOnSuccess(main?.onSuccess);
    await invokeOnSuccess(preload?.onSuccess);
    await invokeOnSuccess(preload?.onSuccess);

    expect(writeReady).toHaveBeenCalledTimes(1);
  });

  it('keeps production clean builds free of dev hooks', () => {
    const [main, preload] = createTsupOptions({ devWatch: false });

    expect(main?.clean).toBe(true);
    expect(main?.onSuccess).toBeUndefined();
    expect(preload?.onSuccess).toBeUndefined();
    expect(main?.sourcemap).toBe(false);
    expect(preload?.sourcemap).toBe(false);
  });

  it('keeps source maps available only during local watch development', () => {
    const [main, preload] = createTsupOptions({ devWatch: true });

    expect(main?.sourcemap).toBe(true);
    expect(preload?.sourcemap).toBe(true);
  });

  it('builds both saved-state verification gates without dropping existing main entries', () => {
    const [main] = createTsupOptions({ devWatch: false });

    expect(main?.entry).toEqual({
      index: 'src/main/index.ts',
      'knowledge-provenance-gate': 'src/main/gates/knowledge-provenance-gate.ts',
      'miyoushe-detail-gate': 'src/main/gates/miyoushe-detail-gate.ts',
      'provider-saved-gate': 'src/main/gates/provider-saved-gate.ts',
      'agent-saved-gate': 'src/main/gates/agent-saved-gate.ts',
      'advisor-saved-gate': 'src/main/gates/advisor-saved-gate.ts',
      'zhipu-search-saved-gate': 'src/main/gates/zhipu-search-saved-gate.ts'
    });
  });

  it('runs both saved-state gates only through their exact built Electron entries', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['gate:agent-saved']).toBe(
      'npm run --silent build:main -- --silent && electron dist/main/agent-saved-gate.mjs'
    );
    expect(packageJson.scripts['gate:advisor-saved']).toBe(
      'npm run --silent build:main -- --silent && electron dist/main/advisor-saved-gate.mjs'
    );
  });

  it('runs the empty-userData process probe directly after one build in local and CI gates', async () => {
    const [packageSource, probeSource, ciSource] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8'),
      readFile(
        path.resolve(import.meta.dirname, '../../../tests/external/saved-gate-empty-user-data.mjs'),
        'utf8'
      ),
      readFile(path.resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'), 'utf8')
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };
    const localGate = packageJson.scripts['gate:local'] ?? '';

    expect(packageJson.scripts['test:saved-gates-empty-user-data']).toBe(
      'node tests/external/saved-gate-empty-user-data.mjs'
    );
    expect(localGate).toContain(
      'npm run build && npm run test:saved-gates-empty-user-data && npm run test:renderer-budget'
    );
    expect(localGate.match(/\bnpm run build\b/gu)).toHaveLength(1);
    expect(probeSource).toContain("import electronPath from 'electron'");
    expect(probeSource).toContain("'dist/main/agent-saved-gate.mjs'");
    expect(probeSource).toContain("'dist/main/advisor-saved-gate.mjs'");
    expect(probeSource).toContain('GTA_E2E_USER_DATA_DIR: userDataDirectory');
    expect(probeSource).not.toMatch(/\bnpm(?:Command)?\b|gate:agent-saved|gate:advisor-saved/u);
    expect(ciSource).toContain('xvfb-run -a npm run gate:local');
  });
});

async function invokeOnSuccess(onSuccess: unknown): Promise<void> {
  expect(onSuccess).toBeTypeOf('function');
  await (onSuccess as () => Promise<void>)();
}
