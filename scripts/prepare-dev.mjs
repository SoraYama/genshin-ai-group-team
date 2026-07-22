import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_READY_MARKER = path.resolve('dist/main/.dev-ready');

export function removeDevReadyMarker(markerPath = DEV_READY_MARKER) {
  rmSync(markerPath, { force: true });
}

const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  removeDevReadyMarker();
  console.info('[dev] cleared main-process readiness marker');
}
