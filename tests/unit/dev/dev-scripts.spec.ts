import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface NodemonConfig {
  watch?: string[];
  ext?: string;
  delay?: string;
  exec?: string;
}

const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as PackageJson;

describe('development process scripts', () => {
  it('pre-bundles renderer dependencies for the same Electron Chromium target as production', async () => {
    const config = await resolveConfig({}, 'serve');

    expect(config.build.target).toBe('chrome142');
    expect(config.optimizeDeps.esbuildOptions?.target).toEqual(config.build.target);
  });

  it('waits for a current-run marker and launches through nodemon', () => {
    expect(packageJson.scripts.dev).toContain('npm run dev:prepare');
    expect(packageJson.scripts['dev:main']).toContain('GTA_DEV_WATCH=1');
    expect(packageJson.scripts['dev:electron']).toContain('dist/main/.dev-ready');
    expect(packageJson.scripts['dev:electron']).toContain(
      'nodemon --config nodemon.electron.json'
    );
    expect(packageJson.scripts['dev:electron']).not.toContain('dist/main/index.mjs');
    expect(packageJson.devDependencies.nodemon).toBe('3.1.14');
    expect(packageJson.devDependencies.electronmon).toBeUndefined();
  });

  it('restarts only for completed main and preload bundles', () => {
    const config = JSON.parse(
      readFileSync(path.resolve('nodemon.electron.json'), 'utf8')
    ) as NodemonConfig;

    expect(config.watch).toEqual(['dist/main/index.mjs', 'dist/main/preload.cjs']);
    expect(config.ext).toBe('mjs,cjs');
    expect(config.delay).toBe('200ms');
    expect(config.exec).toBe('electron .');
  });

  it('removes only the readiness marker', async () => {
    const modulePath = path.resolve('scripts/prepare-dev.mjs');
    expect(existsSync(modulePath)).toBe(true);

    const { removeDevReadyMarker } = (await import(pathToFileURL(modulePath).href)) as {
      removeDevReadyMarker: (markerPath: string) => void;
    };
    const directory = path.join(tmpdir(), `gta-dev-prepare-${process.pid}-${Date.now()}`);
    const marker = path.join(directory, '.dev-ready');
    const mainBundle = path.join(directory, 'index.mjs');
    const preloadBundle = path.join(directory, 'preload.cjs');
    mkdirSync(directory, { recursive: true });
    writeFileSync(marker, 'old marker');
    writeFileSync(mainBundle, 'main bundle');
    writeFileSync(preloadBundle, 'preload bundle');

    removeDevReadyMarker(marker);

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(mainBundle)).toBe(true);
    expect(existsSync(preloadBundle)).toBe(true);
  });
});
