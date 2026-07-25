# Roster Delete Mutation Generation Implementation Plan

> **For Codex:** Follow strict RED-GREEN-REFACTOR. Preserve the existing
> Miyoushe partition lifecycle guards while adding profile-local mutation
> guards.

**Goal:** Keep deleted profiles deleted when an older refresh or import
finishes, and keep the current roster usable when account activation fails.

**Architecture:** `ProfileStore` owns an in-memory revision for each UID.
Long-running IPC handlers capture the UID revision before awaiting external
work and commit through an atomic `upsertIfCurrent` check. Deletes and
unconditional writes advance the revision. Renderer account switches retain
the prior profile until activation and state reload both succeed.

**Tech Stack:** TypeScript, Electron IPC, React 19, Vitest, Playwright Electron

---

### Task 1: Specify store mutation semantics

**Files:**

- Modify: `tests/unit/services/profile-store.spec.ts`
- Modify: `src/main/services/profile-store.ts`

1. Add failing tests for stale guarded writes after delete.
2. Add a failing test proving a new post-delete capture can recreate the UID.
3. Implement capture, guarded upsert, and revision bumps for upsert/remove/clear.
4. Run the focused ProfileStore suite.

### Task 2: Guard refresh and import IPC commits

**Files:**

- Modify: `tests/unit/ipc/profile.ipc.spec.ts`
- Modify: `src/main/ipc/profile.ipc.ts`

1. Add deferred refresh and session-import tests.
2. Delete the target UID while each request is pending.
3. Assert a stable `IPC_SELECTION_CHANGED` rejection and no resurrection.
4. Prove a newly started import can recreate the deleted UID.
5. Replace every production long-write `upsert` with guarded commits.

### Task 3: Preserve renderer state on activation failure

**Files:**

- Modify: `tests/e2e/roster-lifecycle.spec.ts`
- Modify: `src/renderer/pages/Roster/RosterPage.tsx`
- Modify: `src/renderer/pages/Roster/AccountMaintenanceMenu.tsx`

1. Add an Electron lifecycle test where the first `profile:set-active` rejects.
2. Assert the old profile and tab remain usable, a localized alert appears,
   and retry succeeds without renderer unhandled errors.
3. Keep old profile state until activation and state reload succeed; best-effort
   rollback activation when state reload fails.
4. Disable delete while roster work is busy.
5. Route account-tab focus through the tracked animation-frame helper.

### Task 4: Lifecycle cleanup and verification

**Files:**

- Modify: `tests/e2e/roster-lifecycle.spec.ts`

1. Put renderer error assertions in a `try` and Electron/user-data cleanup in
   `finally`.
2. Run focused ProfileStore, profile IPC, lifecycle, SSR, and Roster tests.
3. Run full Vitest with two workers, typecheck, lint, and build.
4. Commit as `fix: preserve roster deletes across in-flight writes`.
