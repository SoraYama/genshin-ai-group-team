interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

interface ConfigureSingleInstanceOptions {
  app: SingleInstanceApp;
  env: Readonly<Record<string, string | undefined>>;
  focusPrimaryWindow: () => void;
}

function isIsolatedProcessHarness(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    env.NODE_ENV === 'test' ||
    env.GTA_E2E_USER_DATA_DIR !== undefined ||
    env.GTA_PACKAGED_SDK_SMOKE_URL !== undefined
  );
}

export function configureSingleInstance(options: ConfigureSingleInstanceOptions): boolean {
  if (isIsolatedProcessHarness(options.env)) return true;
  if (!options.app.requestSingleInstanceLock()) {
    options.app.quit();
    return false;
  }
  options.app.on('second-instance', options.focusPrimaryWindow);
  return true;
}
