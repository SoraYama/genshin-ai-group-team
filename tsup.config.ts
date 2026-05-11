import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/main/index.ts' },
    outDir: 'dist/main',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
    clean: true,
    splitting: false,
    bundle: true,
    outExtension: () => ({ js: '.mjs' }),
    external: ['electron', '@anthropic-ai/claude-agent-sdk', 'electron-store']
  },
  {
    entry: { preload: 'src/main/preload.ts' },
    outDir: 'dist/main',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
    clean: false,
    splitting: false,
    bundle: true,
    outExtension: () => ({ js: '.cjs' }),
    external: ['electron']
  }
]);
