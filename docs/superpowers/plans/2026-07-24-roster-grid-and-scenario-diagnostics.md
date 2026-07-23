# Roster Grid and Scenario Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make roster cards fully visible in a responsive grid and replace the generic challenge-data empty state with actionable diagnostics.

**Architecture:** Keep roster presentation in `CharacterCard` and `roster.css`, using a content-sized CSS Grid rather than JavaScript viewport logic. Add one pure unavailable-scenario copy mapper shared by all three advisor workspaces, and let `EmptyState` accept an explicit copy override while retaining its artwork and accessibility structure.

**Tech Stack:** React 19, TypeScript, CSS Grid, Vitest, Playwright Electron E2E.

---

### Task 1: Remove Generic Energy Advice and Expand Every Card

**Files:**
- Modify: `tests/unit/renderer/character-card.spec.ts`
- Modify: `tests/e2e/app.spec.ts`
- Modify: `src/renderer/pages/Roster/CharacterCard.tsx`
- Modify: `src/renderer/i18n/index.tsx`

- [ ] **Step 1: Write the failing tests**

Add assertions that `CharacterCard.tsx` has no `expanded` state or expand button, renders `.gta-character-detail` unconditionally, and that both locale strings for `roster.energyPanel.known` contain only `{{value}}%`. Change E2E to expect full detail before any click and to reject the generic energy sentence.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- --run tests/unit/renderer/character-card.spec.ts
```

Expected: FAIL because the component still owns `expanded` state and the translation still contains advice.

- [ ] **Step 3: Implement the minimal behavior**

Remove the expand button and conditional wrapper:

```tsx
<div className="gta-character-detail">
  {/* existing detail content */}
</div>
```

Set both locales to:

```ts
'roster.energyPanel.known': '{{value}}%',
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
npm test -- --run tests/unit/renderer/character-card.spec.ts
```

Expected: PASS.

### Task 2: Make the Roster Grid Responsive and Spaced

**Files:**
- Modify: `tests/unit/renderer/character-card.spec.ts`
- Modify: `src/renderer/styles/pages/roster.css`

- [ ] **Step 1: Write the failing layout test**

Assert the stylesheet contains:

```css
grid-template-columns: repeat(auto-fit, minmax(min(100%, 540px), 1fr));
gap: 16px;
margin-top: 16px;
```

Also assert the `max-width: 1180px` block no longer forces `.gta-character-list` to one column.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- --run tests/unit/renderer/character-card.spec.ts
```

Expected: FAIL on the fixed two-column layout.

- [ ] **Step 3: Implement the CSS Grid**

Replace the fixed grid with:

```css
.gta-character-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 540px), 1fr));
  align-items: start;
  gap: 16px;
  margin-top: 16px;
}
```

Remove the `1180px` single-column override and change the card header columns to omit the removed button.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
npm test -- --run tests/unit/renderer/character-card.spec.ts
```

Expected: PASS.

### Task 3: Present Actionable Challenge-Data Diagnostics

**Files:**
- Create: `src/renderer/pages/Advisor/scenario-unavailable-presentation.ts`
- Create: `tests/unit/renderer/scenario-unavailable-presentation.spec.ts`
- Modify: `src/renderer/components/ui/EmptyState.tsx`
- Modify: `src/renderer/pages/Advisor/AbyssWorkspace.tsx`
- Modify: `src/renderer/pages/Advisor/StygianWorkspace.tsx`
- Modify: `src/renderer/pages/Advisor/TheaterWorkspace.tsx`

- [ ] **Step 1: Write the failing copy tests**

Test all four reasons in Chinese and the production-source case in English:

```ts
expect(scenarioUnavailableCopy('production-source-not-configured', 'zh')).toEqual({
  title: '正式挑战资料源尚未接入',
  body: '应用尚未配置经过签名验证的正式挑战资料源。',
  actionHint: '这不是账号或智能服务设置问题，需要维护者接入资料发布链。'
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- --run tests/unit/renderer/scenario-unavailable-presentation.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure mapper and copy override**

Export a strict reason union and `scenarioUnavailableCopy(reason, locale)`. Extend `EmptyState` with:

```tsx
copy?: { title: string; body: string; actionHint: string };
```

Use `copy ?? emptyStateCopy(kind, locale)`, then pass the mapped copy from all three unavailable workspace branches.

- [ ] **Step 4: Run focused renderer tests**

Run:

```bash
npm test -- --run tests/unit/renderer/scenario-unavailable-presentation.spec.ts tests/unit/renderer/empty-state.spec.ts
```

Expected: PASS.

### Task 4: Verify, Record Visuals, and Merge

**Files:**
- Modify: `tests/e2e/visual-signatures.json`

- [ ] **Step 1: Run local quality gate**

Run:

```bash
npm run gate:local
```

Expected: lint, typecheck, all unit tests, build, and renderer budget PASS.

- [ ] **Step 2: Record and inspect the visual matrix**

Run:

```bash
npm run test:e2e:visual:record
```

Inspect roster screenshots at `1024×768`, `1280×800`, `1440×900`, and `1600×1000`. Confirm full cards, natural column count, 16px separation, no horizontal overflow, and readable details.

- [ ] **Step 3: Update signatures and verify**

Copy the emitted roster hashes into `tests/e2e/visual-signatures.json`, then run:

```bash
npm run test:e2e:visual
```

Expected: 13 Electron E2E tests PASS across the visual matrix.

- [ ] **Step 4: Commit and integrate**

Run:

```bash
git add src tests docs/superpowers/plans/2026-07-24-roster-grid-and-scenario-diagnostics.md
git commit -m "feat: improve roster layout and scenario diagnostics"
```

Fast-forward `codex/v1-rc` to the feature branch after verification.
