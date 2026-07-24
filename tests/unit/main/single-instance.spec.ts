import { describe, expect, it, vi } from 'vitest';

import { configureSingleInstance } from '../../../src/main/single-instance.js';

function appDouble(lockAcquired: boolean) {
  let secondInstanceListener: (() => void) | undefined;
  return {
    app: {
      requestSingleInstanceLock: vi.fn(() => lockAcquired),
      quit: vi.fn(),
      on: vi.fn((event: 'second-instance', listener: () => void) => {
        if (event === 'second-instance') secondInstanceListener = listener;
      })
    },
    emitSecondInstance: () => secondInstanceListener?.()
  };
}

describe('configureSingleInstance', () => {
  it('enforces one normal development or production instance and focuses the primary window', () => {
    for (const nodeEnv of ['development', 'production']) {
      const testApp = appDouble(true);
      const focusPrimaryWindow = vi.fn();

      expect(
        configureSingleInstance({
          app: testApp.app,
          env: { NODE_ENV: nodeEnv },
          focusPrimaryWindow
        })
      ).toBe(true);
      expect(testApp.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
      expect(testApp.app.quit).not.toHaveBeenCalled();
      testApp.emitSecondInstance();
      expect(focusPrimaryWindow).toHaveBeenCalledOnce();
    }
  });

  it('quits before bootstrap when another normal instance owns the lock', () => {
    const testApp = appDouble(false);

    expect(
      configureSingleInstance({
        app: testApp.app,
        env: { NODE_ENV: 'production' },
        focusPrimaryWindow: vi.fn()
      })
    ).toBe(false);
    expect(testApp.app.quit).toHaveBeenCalledOnce();
    expect(testApp.app.on).not.toHaveBeenCalled();
  });

  it.each([
    ['unit test', { NODE_ENV: 'test' }],
    ['renderer E2E', { NODE_ENV: 'production', GTA_E2E_USER_DATA_DIR: '/tmp/e2e' }],
    [
      'packaged SDK smoke',
      { NODE_ENV: 'production', GTA_PACKAGED_SDK_SMOKE_URL: 'http://127.0.0.1:4123' }
    ]
  ])('does not let the %s harness interfere with another process', (_name, env) => {
    const testApp = appDouble(false);

    expect(
      configureSingleInstance({
        app: testApp.app,
        env,
        focusPrimaryWindow: vi.fn()
      })
    ).toBe(true);
    expect(testApp.app.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(testApp.app.quit).not.toHaveBeenCalled();
    expect(testApp.app.on).not.toHaveBeenCalled();
  });

  it.each([
    ['empty E2E path', { NODE_ENV: 'production', GTA_E2E_USER_DATA_DIR: '' }],
    ['blank E2E path', { NODE_ENV: 'production', GTA_E2E_USER_DATA_DIR: '   ' }],
    ['empty smoke URL', { NODE_ENV: 'production', GTA_PACKAGED_SDK_SMOKE_URL: '' }],
    ['blank smoke URL', { NODE_ENV: 'production', GTA_PACKAGED_SDK_SMOKE_URL: ' \t ' }]
  ])('still enforces the instance lock for an %s', (_name, env) => {
    const testApp = appDouble(false);

    expect(
      configureSingleInstance({
        app: testApp.app,
        env,
        focusPrimaryWindow: vi.fn()
      })
    ).toBe(false);
    expect(testApp.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(testApp.app.quit).toHaveBeenCalledOnce();
    expect(testApp.app.on).not.toHaveBeenCalled();
  });
});
