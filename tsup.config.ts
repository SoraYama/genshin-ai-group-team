import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Options } from 'tsup';

type DevTarget = 'main' | 'preload';

interface CreateTsupOptionsInput {
  devWatch: boolean;
  writeReady?: () => Promise<void>;
}

export function createTsupOptions({ devWatch, writeReady }: CreateTsupOptionsInput): Options[] {
  const successfulTargets = new Set<DevTarget>();
  let publishPromise: Promise<void> | undefined;

  const onSuccess = (target: DevTarget) => async (): Promise<void> => {
    successfulTargets.add(target);
    if (successfulTargets.size !== 2 || !writeReady) return;

    publishPromise ??= writeReady().catch((error: unknown) => {
      publishPromise = undefined;
      throw error;
    });
    await publishPromise;
  };

  return [
    {
      entry: {
        index: 'src/main/index.ts',
        'knowledge-provenance-gate': 'src/main/gates/knowledge-provenance-gate.ts',
        'miyoushe-detail-gate': 'src/main/gates/miyoushe-detail-gate.ts',
        'provider-saved-gate': 'src/main/gates/provider-saved-gate.ts'
      },
      outDir: 'dist/main',
      format: ['esm'],
      target: 'node20',
      platform: 'node',
      sourcemap: devWatch,
      clean: !devWatch,
      splitting: false,
      bundle: true,
      outExtension: () => ({ js: '.mjs' }),
      external: ['electron', '@anthropic-ai/claude-agent-sdk', 'electron-store'],
      onSuccess: devWatch ? onSuccess('main') : undefined
    },
    {
      entry: { preload: 'src/main/preload.ts' },
      outDir: 'dist/main',
      format: ['cjs'],
      target: 'node20',
      platform: 'node',
      sourcemap: devWatch,
      clean: false,
      splitting: false,
      bundle: true,
      outExtension: () => ({ js: '.cjs' }),
      external: ['electron'],
      onSuccess: devWatch ? onSuccess('preload') : undefined
    }
  ];
}

async function writeDevReadyMarker(): Promise<void> {
  const marker = path.resolve('dist/main/.dev-ready');
  const temporary = `${marker}.tmp`;
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(temporary, `${process.pid}:${Date.now()}\n`, 'utf8');
  await rename(temporary, marker);
}

const devWatch = process.env.GTA_DEV_WATCH === '1';

export default defineConfig(
  createTsupOptions({
    devWatch,
    writeReady: devWatch ? writeDevReadyMarker : undefined
  })
);
