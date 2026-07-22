# Dev Electron Fresh-Build Restart Design

**Date:** 2026-07-22

## Problem

`npm run dev` currently starts Vite, `tsup --watch`, and Electron concurrently. The Electron command waits only for the Vite port and for `dist/main/index.mjs` to exist. A stale bundle from an earlier build already satisfies that file check, so Electron can import the stale main process before tsup finishes the current build. Later tsup output replaces the file on disk but does not restart the running Electron process.

The observed result was a current renderer talking to an old main process. The old profile refresh path fell back to the enhancement calculator, yielding all 112 owned characters but detailed stats/artifacts only for the 12 Enka showcase characters.

## Requirements

- Never launch Electron from a bundle produced before the current `npm run dev` invocation.
- Restart Electron after a successful main or preload rebuild.
- Keep Vite renderer HMR without restarting Electron for renderer-only edits.
- Do not clear or replace the developer's Electron userData, cookies, profiles, or caches.
- A failed main/preload rebuild must not launch a broken or partially deleted bundle.
- SIGINT/SIGTERM must still terminate Vite, tsup, electronmon, and Electron together.

## Design

### Startup barrier

Add a small dev-preparation script that removes only `dist/main/.dev-ready`. The main and preload tsup configurations each receive a dev-only `onSuccess` callback. A shared in-process coordinator writes `.dev-ready` only after both configurations have completed at least one successful build during the current watch process.

`dev:electron` waits for both the Vite port and `.dev-ready`. A stale `index.mjs` can therefore no longer start Electron.

### Restart behavior

Use `electronmon` as the Electron process supervisor. It starts Electron only after the startup barrier and watches generated main/preload artifacts. Successful output changes restart the Electron process; renderer source and renderer build output are excluded so Vite remains responsible for renderer HMR.

In dev-watch mode, tsup does not clean `dist/main` before a rebuild. This prevents a failed rebuild from deleting the last known-good main/preload files and avoids electronmon reacting to an intermediate deletion. Production `npm run build:main` retains the existing clean build behavior and never writes the dev-ready marker.

### Process topology

```text
npm run dev
  -> remove dist/main/.dev-ready
  -> concurrently
       -> vite
       -> GTA_DEV_WATCH=1 tsup --watch
            -> main success ----+
            -> preload success -+-> write .dev-ready
       -> wait for Vite + .dev-ready -> electronmon .
```

`concurrently -k` remains the owner of group shutdown.

## Testing

- A unit test proves the ready marker is not written after only one tsup target succeeds and is written after both succeed.
- A configuration test proves dev watch disables `clean`, while production builds keep `clean: true` and no dev callback.
- A package-script test proves Electron waits on `.dev-ready` and is launched through electronmon rather than the old stale-file `wait-on` command.
- Manual smoke verification starts with stale dist output, confirms the new build succeeds before Electron launches, then touches a main source and confirms Electron restarts.

## Scope

This change affects development orchestration only. Production packaging, runtime data acquisition, persisted credentials, and renderer behavior are unchanged.
