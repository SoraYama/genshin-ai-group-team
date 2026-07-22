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
  });
});

async function invokeOnSuccess(onSuccess: unknown): Promise<void> {
  expect(onSuccess).toBeTypeOf('function');
  await (onSuccess as () => Promise<void>)();
}
