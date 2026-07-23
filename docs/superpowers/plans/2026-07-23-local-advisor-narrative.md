# Deterministic Local Advisor Narrative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact bilingual narrative sections to every validated local-rule and AI-fallback plan.

**Architecture:** A single main-process pure builder maps a validated `RecommendationPlan` to the
existing typed `AdvisorNarrative` contract. Each local optimizer calls it only after mode validation;
services and history then receive the same complete local result without a second narrative path.

**Tech Stack:** TypeScript, Zod, Vitest, Playwright, Electron/React existing contracts.

---

### Task 1: Central deterministic narrative contract

**Files:**
- Create: `src/main/services/local-advisor-narrative.ts`
- Create: `tests/unit/services/local-advisor-narrative.spec.ts`

- [ ] **Step 1: Write failing exact-coverage tests**

Add tests that call `renderLocalPlanNarrative(plan, locale)` for valid Abyss, Stygian, and Theater
plans. Assert exact target-key arrays, `origin: "local-rules"`, both locale strings, and the expected
typed reason/fact pairs. Assert serialized output contains neither arbitrary plan prose nor the UI's
unavailable placeholder.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/unit/services/local-advisor-narrative.spec.ts
```

Expected: FAIL because `local-advisor-narrative.ts` does not exist.

- [ ] **Step 3: Implement the pure validated-plan mapper**

Implement:

```ts
export function renderLocalPlanNarrative(
  plan: RecommendationPlan,
  locale: AdvisorLocale
): AdvisorNarrative
```

Switch on `plan.mode`, derive only the exact keys listed in the design, construct bilingual
target-derived templates, and parse the result with `advisorNarrativeSchema`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all central builder tests PASS.

### Task 2: Wire the three validated local planners

**Files:**
- Modify: `src/main/services/abyss-local-optimizer.ts`
- Modify: `src/main/services/stygian-local-optimizer.ts`
- Modify: `src/main/services/theater-local-planner.ts`
- Modify: `tests/unit/services/abyss-local-optimizer.spec.ts`
- Modify: `tests/unit/services/stygian-local-optimizer.spec.ts`
- Modify: `tests/unit/services/theater-local-planner.spec.ts`

- [ ] **Step 1: Add failing planner assertions**

For each planned local result, assert narrative keys equal the targets derived from its validated
plan and that English bodies contain no Han characters. Keep blocked-result tests unchanged.

- [ ] **Step 2: Run planner tests and verify RED**

```bash
npx vitest run tests/unit/services/abyss-local-optimizer.spec.ts \
  tests/unit/services/stygian-local-optimizer.spec.ts \
  tests/unit/services/theater-local-planner.spec.ts
```

Expected: FAIL because planned local narratives still have empty sections.

- [ ] **Step 3: Add narrative after successful validation**

In each planner's successful `schema.parse` payload, add:

```ts
narrative: renderLocalPlanNarrative(validation.plan, input.locale)
```

Apply the same rule to the Abyss partial-recompute success path.

- [ ] **Step 4: Run planner tests and verify GREEN**

Run the command from Step 2. Expected: all three planner suites PASS.

### Task 3: Prove service fallback and history coverage

**Files:**
- Modify: `tests/unit/services/abyss-advisor-service.spec.ts`
- Modify: `tests/unit/services/stygian-advisor-service.spec.ts`
- Modify: `tests/unit/services/theater-advisor-service.spec.ts`

- [ ] **Step 1: Add failing service assertions**

For no-key and agent-failure planned results, assert the exact target-key set and assert the history
append payload carries the same narrative. Assert the local narrative has `origin: "local-rules"`.

- [ ] **Step 2: Run service tests**

```bash
npx vitest run tests/unit/services/abyss-advisor-service.spec.ts \
  tests/unit/services/stygian-advisor-service.spec.ts \
  tests/unit/services/theater-advisor-service.spec.ts
```

Expected after Task 2: PASS without service production changes, proving the existing fallback and
history data flow preserves the planner narrative. If a test fails, repair only the service
passthrough that dropped or replaced the local narrative.

### Task 4: Replace successful-flow placeholder E2E assertions

**Files:**
- Modify after the i18n task lands: `tests/e2e/app.spec.ts`

- [ ] **Step 1: Inspect the i18n task's committed E2E state**

Confirm no uncommitted work remains in `tests/e2e/app.spec.ts` before editing.

- [ ] **Step 2: Add local rationale assertions**

For Abyss, Stygian, and Theater local-rule journeys, assert one exact target's bilingual rationale
is visible and assert `Guidance unavailable`, `No localized guidance was saved for this target`,
`指引不可用`, and `这个目标没有保存可验证的本地化指引` are absent.

- [ ] **Step 3: Run the relevant E2E tests**

```bash
npm run test:e2e -- --grep "local|Abyss|Stygian|Theater"
```

Expected: all matching journeys PASS.

### Task 5: Full verification and review

**Files:**
- Verify every file changed by Tasks 1-4.

- [ ] **Step 1: Run all release gates**

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
git diff --check
```

Expected: every command exits 0 with no warnings promoted to errors.

- [ ] **Step 2: Commit the implementation**

Stage only the local narrative, tests, and approved E2E changes. Commit with:

```bash
git commit -m "fix: add deterministic local advisor rationale"
```

- [ ] **Step 3: Request the same read-only pipeline reviewer**

Ask the existing pipeline reviewer to inspect exact target coverage, typed fact support, no arbitrary
plan prose, no-key/fallback/history behavior, E2E placeholder rejection, and fresh release gates.
The required verdict is Ready with no Critical or Important.
