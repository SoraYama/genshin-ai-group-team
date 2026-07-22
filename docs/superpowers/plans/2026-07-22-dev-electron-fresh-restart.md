# Dev Electron Fresh-Build Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run dev` wait for a fresh main/preload build and automatically restart Electron after every successful main-process rebuild.

**Architecture:** A shared tsup readiness coordinator writes a dev-only marker after both main and preload targets succeed. Electron waits for that marker and the Vite port, then runs under nodemon; nodemon explicitly watches the generated main and preload entry bundles while Vite continues to own renderer HMR.

**Tech Stack:** TypeScript, tsup watch hooks, Vitest, npm scripts, nodemon 3.1.14, concurrently, wait-on.

---

### Task 1: Fresh-build readiness coordinator

**Files:**

- Modify: `tsup.config.ts`
- Create: `tests/unit/dev/tsup-dev-readiness.spec.ts`

- [ ] **Step 1: Write failing coordinator/config tests**

Add tests that import `createTsupOptions` from `tsup.config.ts` with an injected marker writer:

```ts
it('publishes readiness only after both dev targets succeed', async () => {
  const writeReady = vi.fn(async () => undefined);
  const [main, preload] = createTsupOptions({ devWatch: true, writeReady });

  await main.onSuccess?.();
  expect(writeReady).not.toHaveBeenCalled();
  await preload.onSuccess?.();
  expect(writeReady).toHaveBeenCalledTimes(1);
});

it('keeps production clean builds free of dev hooks', () => {
  const [main, preload] = createTsupOptions({ devWatch: false });
  expect(main.clean).toBe(true);
  expect(main.onSuccess).toBeUndefined();
  expect(preload.onSuccess).toBeUndefined();
});

it('publishes the marker once across repeated success callbacks', async () => {
  const writeReady = vi.fn(async () => undefined);
  const [main, preload] = createTsupOptions({ devWatch: true, writeReady });

  expect(main.clean).toBe(false);
  await main.onSuccess?.();
  await main.onSuccess?.();
  await preload.onSuccess?.();
  await preload.onSuccess?.();
  expect(writeReady).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run tests/unit/dev/tsup-dev-readiness.spec.ts
```

Expected: FAIL because `createTsupOptions` is not exported and no readiness coordinator exists.

- [ ] **Step 3: Implement the minimal readiness coordinator**

Refactor `tsup.config.ts` to export:

```ts
import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { defineConfig, type Options } from 'tsup';

type DevTarget = 'main' | 'preload';

export function createTsupOptions(options: {
  devWatch: boolean;
  writeReady?: () => Promise<void>;
}): Options[] {
  const successfulTargets = new Set<DevTarget>();
  let publishPromise: Promise<void> | undefined;
  const onSuccess = (target: DevTarget) => async () => {
    successfulTargets.add(target);
    if (successfulTargets.size === 2 && options.writeReady) {
      publishPromise ??= options.writeReady().catch((error: unknown) => {
        publishPromise = undefined;
        throw error;
      });
      await publishPromise;
    }
  };

  return [
    {
      entry: {
        index: 'src/main/index.ts',
        'miyoushe-detail-gate': 'src/main/gates/miyoushe-detail-gate.ts',
        'provider-saved-gate': 'src/main/gates/provider-saved-gate.ts'
      },
      outDir: 'dist/main',
      format: ['esm'],
      target: 'node20',
      platform: 'node',
      sourcemap: true,
      clean: !options.devWatch,
      splitting: false,
      bundle: true,
      outExtension: () => ({ js: '.mjs' }),
      external: ['electron', '@anthropic-ai/claude-agent-sdk', 'electron-store'],
      onSuccess: options.devWatch ? onSuccess('main') : undefined
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
      external: ['electron'],
      onSuccess: options.devWatch ? onSuccess('preload') : undefined
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
```

The default export passes `{ devWatch, writeReady: devWatch ? writeDevReadyMarker : undefined }` to `createTsupOptions`, then passes the returned array to `defineConfig`. The real writer creates `dist/main` and atomically writes `dist/main/.dev-ready`. It is enabled only when `GTA_DEV_WATCH=1`; normal builds retain `clean: true` and never create a marker.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/unit/dev/tsup-dev-readiness.spec.ts
npm run typecheck
```

Expected: all tests PASS and TypeScript exits 0.

### Task 2: Dev process scripts and supervisor

**Files:**

- Create: `scripts/prepare-dev.mjs`
- Create: `tests/unit/dev/dev-scripts.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing dev-script contract tests**

The test reads the actual `package.json` and imports `removeDevReadyMarker` from the preparation script. Assert:

```ts
expect(scripts.dev).toContain('npm run dev:prepare');
expect(scripts['dev:main']).toContain('GTA_DEV_WATCH=1');
expect(scripts['dev:electron']).toContain('dist/main/.dev-ready');
expect(scripts['dev:electron']).toContain('nodemon --config nodemon.electron.json');
expect(scripts['dev:electron']).not.toContain('dist/main/index.mjs');
expect(packageJson.devDependencies.nodemon).toBe('3.1.14');
```

Use a temporary directory to prove `removeDevReadyMarker(path)` removes only the marker and preserves sibling `index.mjs` and `preload.cjs` files.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx vitest run tests/unit/dev/dev-scripts.spec.ts
```

Expected: FAIL because the preparation script and nodemon dependency do not exist and the old script waits on `dist/main/index.mjs`.

- [ ] **Step 3: Install nodemon and implement scripts**

Run:

```bash
npm install --save-dev --save-exact nodemon@3.1.14
```

Create `scripts/prepare-dev.mjs` with an exported function that calls `rmSync(markerPath, { force: true })`, then calls it for `dist/main/.dev-ready` when run as the entry point.

Update scripts to this exact topology:

```json
{
  "dev": "npm run dev:prepare && concurrently -k -n vite,tsup,electron -c blue,magenta,yellow \"npm:dev:renderer\" \"npm:dev:main\" \"npm:dev:electron\"",
  "dev:prepare": "node scripts/prepare-dev.mjs",
  "dev:main": "cross-env GTA_DEV_WATCH=1 tsup --watch",
  "dev:electron": "wait-on tcp:5294 dist/main/.dev-ready && cross-env NODE_ENV=development nodemon --config nodemon.electron.json"
}
```

The three long-running processes do not start until the top-level preparation command has removed the marker. Add `nodemon.electron.json`:

```json
{
  "watch": ["dist/main/index.mjs", "dist/main/preload.cjs"],
  "ext": "mjs,cjs",
  "delay": "200ms",
  "exec": "electron ."
}
```

The explicit watch set avoids nodemon's default broad source watching and makes only completed main/preload entry writes restart Electron.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/unit/dev/tsup-dev-readiness.spec.ts tests/unit/dev/dev-scripts.spec.ts
npm run typecheck
npm run lint
```

Expected: all commands exit 0.

### Task 3: Integration smoke and final verification

**Files:**

- Verify only; fix failures in Task 1 or Task 2 files.

- [ ] **Step 1: Prove a stale bundle cannot launch**

Start from an existing `dist/main/index.mjs`, run `npm run dev`, and inspect ordered output. Expected ordering:

```text
dev:prepare removes .dev-ready
tsup main build success
tsup preload build success
.dev-ready created
nodemon launches Electron
```

There must be no Electron launch between preparation and both successful builds.

- [ ] **Step 2: Prove main/preload changes restart Electron**

Record the Electron child PID, touch or temporarily modify a main service file, wait for tsup success, and verify the Electron PID changes exactly once after the successful output update. Repeat for `src/main/preload.ts`. Restore any temporary edit.

- [ ] **Step 3: Prove renderer changes stay on Vite HMR**

Touch a renderer source file and verify Vite handles the update without changing the Electron PID.

- [ ] **Step 4: Run project verification**

Run:

```bash
npm run gate:local
npm run test:e2e:run
```

Expected: lint, typecheck, all Vitest tests, both builds, and both Electron E2E tests PASS.

- [ ] **Step 5: Commit implementation**

```bash
git add package.json package-lock.json tsup.config.ts scripts/prepare-dev.mjs tests/unit/dev
git commit -m "fix: restart Electron from fresh dev builds"
```
