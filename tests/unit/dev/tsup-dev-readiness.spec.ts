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
      'advisor-saved-gate': 'src/main/gates/advisor-saved-gate.ts'
    });
  });

  it('runs both saved-state gates only through their exact built Electron entries', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['gate:agent-saved']).toBe(
      'npm run build:main && electron dist/main/agent-saved-gate.mjs'
    );
    expect(packageJson.scripts['gate:advisor-saved']).toBe(
      'npm run build:main && electron dist/main/advisor-saved-gate.mjs'
    );
  });
});

async function invokeOnSuccess(onSuccess: unknown): Promise<void> {
  expect(onSuccess).toBeTypeOf('function');
  await (onSuccess as () => Promise<void>)();
}
