# History Integrity Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every raw history record during writes, add complete player-facing historical context, consume rerun intents once, and localize recoverable errors by stable codes.

**Architecture:** HistoryStore will separate display parsing from raw mutation. Mutations operate on raw arrays, preserve non-target values verbatim, and derive confirmation count/fingerprint from the exact raw records selected for deletion; ambiguous identity fails closed. New history entries persist a friendly immutable period snapshot and complete mode-specific result semantics. Renderer helpers own period/confidence/change-warning presentation, while App owns one-shot rerun lifecycle and stable error codes cross the IPC boundary.

**Tech Stack:** Electron Store, TypeScript, Zod, React 19, Vitest, Playwright.

---

### Task 1: Raw identity-preserving HistoryStore

**Files:**
- Modify: `src/main/services/history-store.ts`
- Modify: `src/shared/errors.ts`
- Modify: `src/main/ipc/history.ipc.ts`
- Test: `tests/unit/services/history-store.spec.ts`
- Test: `tests/unit/services/theater-history-store.spec.ts`
- Test: `tests/unit/ipc/history.ipc.spec.ts`

- [ ] **Step 1: Write failing raw-preservation tests**

Seed invalid and old raw objects in each collection and assert append, single delete, UID/group/all delete preserve every non-target raw object. Assert an affected record with unknown identity blocks preparation without writing.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/services/history-store.spec.ts tests/unit/services/theater-history-store.spec.ts tests/unit/ipc/history.ipc.spec.ts
```

Expected: failures show invalid records disappearing or ambiguous scopes being accepted.

- [ ] **Step 3: Implement raw mutation and exact selection**

Add raw collection accessors and a scope selector that:

```ts
type RawSelection = {
  count: number;
  fingerprint: string;
  selectedIndexes: Map<HistoryCollectionKey, Set<number>>;
};
```

The selector must include collection, raw ID, and raw content hash in the confirmation fingerprint. Append caps only parseable entries and always preserves opaque records. Single delete filters the raw array by an identifiable ID. Batch delete refuses ambiguous affected identities and writes only arrays filtered by the confirmed selected indexes.

- [ ] **Step 4: Verify GREEN and TOCTOU**

Add a same-ID content replacement between confirmation and delete; expect rejection and no writes. Re-run the focused command until all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/history-store.ts src/shared/errors.ts src/main/ipc/history.ipc.ts tests/unit/services/history-store.spec.ts tests/unit/services/theater-history-store.spec.ts tests/unit/ipc/history.ipc.spec.ts
git commit -m "fix: preserve raw history records"
```

### Task 2: Immutable player-facing history snapshots

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/main/services/abyss-advisor-service.ts`
- Modify: `src/main/services/stygian-advisor-service.ts`
- Modify: `src/main/services/theater-advisor-service.ts`
- Modify: `src/main/services/history-store.ts`
- Modify: `src/renderer/pages/History/history-presentation.ts`
- Modify: `src/renderer/pages/History/HistoryPage.tsx`
- Modify: `src/renderer/styles/pages/history.css`
- Test: `tests/unit/services/abyss-advisor-service.spec.ts`
- Test: `tests/unit/services/stygian-advisor-service.spec.ts`
- Test: `tests/unit/services/theater-advisor-service.spec.ts`
- Test: `tests/unit/renderer/history-presentation.spec.ts`

- [ ] **Step 1: Write failing snapshot tests**

Require new entries to persist `playerCycle` from scenario `effectiveFrom`/`effectiveTo`, Stygian `phaseGuidance` and `difficultyAssessment`, and render confidence as a player-facing “建议把握”. Assert opaque `scenarioId` never appears in titles or saved-version details and old records show “保存时未记录周期”.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/services/abyss-advisor-service.spec.ts tests/unit/services/stygian-advisor-service.spec.ts tests/unit/services/theater-advisor-service.spec.ts tests/unit/renderer/history-presentation.spec.ts
```

Expected: missing snapshot properties and raw scenario IDs in presentation.

- [ ] **Step 3: Implement immutable snapshot contracts**

Add:

```ts
interface PlayerCycleSnapshot {
  label: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}
```

New writes derive the label from the scenario’s effective range. Query normalization supplies an explicit unknown-period migration value only in memory. Stygian history stores the checked result’s guidance and assessment. History details and cards consume only these saved values.

- [ ] **Step 4: Verify GREEN and deep immutability**

Mutate result/scenario inputs after append and assert queried snapshots stay unchanged. Re-run the focused suite.

- [ ] **Step 5: Commit**

```bash
git add src/shared/domain.ts src/main/services/*advisor-service.ts src/main/services/history-store.ts src/renderer/pages/History src/renderer/styles/pages/history.css tests/unit
git commit -m "feat: preserve player-facing history context"
```

### Task 3: One-shot rerun intent and change warning

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/pages/Advisor/AdvisorPage.tsx`
- Modify: `src/renderer/pages/Advisor/history-rerun-prefill.ts`
- Modify: `src/renderer/pages/Advisor/AbyssWorkspace.tsx`
- Modify: `src/renderer/pages/Advisor/StygianWorkspace.tsx`
- Modify: `src/renderer/pages/Advisor/TheaterWorkspace.tsx`
- Test: `tests/unit/renderer/history-rerun-prefill.spec.ts`
- Test: `tests/e2e/app.spec.ts`

- [ ] **Step 1: Write failing lifecycle and comparison tests**

Assert comparison of previous/current scenario and data versions produces a player message without slugs. In E2E, apply a rerun once, navigate away/back and switch UID, then assert the prefill is absent and no recommendation was automatically invoked.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/renderer/history-rerun-prefill.spec.ts
npx playwright test tests/e2e/app.spec.ts
```

Expected: intent remains after workspace application and raw identity lacks a friendly warning.

- [ ] **Step 3: Implement consume callback**

Pass `onHistoryRerunConsumed` from App through AdvisorPage to the active workspace. Each workspace consumes after applying or rejecting its intent. App also clears on navigation away from Advisor and active UID changes. Presentation compares identities but emits only “挑战周期/资料版本已变化，将按当前资料重新计算”.

- [ ] **Step 4: Verify GREEN**

Run unit and E2E tests and confirm no smart-service request is issued by prefill alone.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/pages/Advisor tests/unit/renderer/history-rerun-prefill.spec.ts tests/e2e/app.spec.ts
git commit -m "fix: consume history reruns once"
```

### Task 4: Stable localized recoverable errors

**Files:**
- Modify: `src/shared/errors.ts`
- Modify: `src/main/ipc/history.ipc.ts`
- Modify: `src/main/ipc/data-management.ipc.ts`
- Modify: `src/main/services/data-management-service.ts`
- Modify: `src/main/services/scenario-store.ts`
- Modify: `src/renderer/i18n/index.tsx`
- Modify: `src/renderer/pages/History/HistoryPage.tsx`
- Modify: `src/renderer/pages/Settings/SettingsPage.tsx`
- Test: `tests/unit/renderer/error-localization.spec.ts`
- Test: `tests/unit/ipc/history.ipc.spec.ts`
- Test: `tests/unit/ipc/data-management.ipc.spec.ts`

- [ ] **Step 1: Write failing localization tests**

For Chinese and English, assert stable codes for expired confirmation, changed selection, unknown history identity, and failed file inspection map to player copy. Assert Chinese output never equals an injected English Main message.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/renderer/error-localization.spec.ts tests/unit/ipc/history.ipc.spec.ts tests/unit/ipc/data-management.ipc.spec.ts
```

Expected: Chinese returns the internal message and specific codes are absent.

- [ ] **Step 3: Implement stable codes and recovery actions**

Extend the IPC code union, translate service errors to stable IPC errors, and make `localizeError` code-first for both locales with fallback-only behavior for unknown messages. History retains reload/reconfirm actions; Settings reports retry/reconfirm without exposing Main text.

- [ ] **Step 4: Verify GREEN**

Re-run focused tests and inspect both locale outputs.

- [ ] **Step 5: Commit**

```bash
git add src/shared/errors.ts src/main/ipc src/main/services src/renderer/i18n src/renderer/pages/History src/renderer/pages/Settings tests/unit
git commit -m "fix: localize recoverable data errors"
```

### Task 5: Final verification and independent review

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run repository gates**

```bash
npm run gate:local
npm run test:e2e:run
git diff --check
git status --short
```

Expected: all commands exit 0 and worktree is clean.

- [ ] **Step 2: Inspect screenshots**

Review History and Settings at 1024×768 and 1600×1000 for overflow, raw identifiers, readable warnings, and recoverable error actions.

- [ ] **Step 3: Independent review**

Ask the existing independent reviewer to verify the Critical and four Important requirements at current HEAD. Iterate until the reviewer returns exactly `Ready`.
