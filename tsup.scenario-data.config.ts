import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { publish: 'scripts/scenario-data/publish.ts' },
  outDir: 'dist/scripts/scenario-data',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  clean: false,
  sourcemap: true,
  outExtension: () => ({ js: '.mjs' })
});
