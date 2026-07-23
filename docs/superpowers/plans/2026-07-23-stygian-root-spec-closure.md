# Stygian Root Spec Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five M5 root-spec gaps with a bounded three-phase solver, enforceable reward policy, per-turn tool evidence, semantic history validation, and player-safe modifier localization.

**Architecture:** Preserve the existing M5 service boundaries. Add two shared pure-policy modules, replace only the optimizer's unbounded candidate construction with M4-style feasible-seed pooling, scope Agent evidence to one turn, and add semantic refinements at history ingestion. Every behavior change starts from a focused failing test.

**Tech Stack:** TypeScript, Zod, Vitest, React 19, Electron IPC, Playwright.

---

### Task 1: Bounded three-phase optimizer

**Files:**
- Modify: `tests/unit/services/stygian-local-optimizer.spec.ts`
- Modify: `src/main/services/stygian-local-optimizer.ts`
- Reference: `src/main/services/abyss-local-optimizer.ts`

- [ ] **Step 1: Write failing 14/38/80 roster tests**

Add parameterized tests which call `buildLocalStygianPlan` with forbidden reuse and assert `planned`, deterministic output, duration below 1,000 ms, and monotonic feasibility as irrelevant characters are appended. Add a case where high-scoring irrelevant characters cannot displace the only capability specialists.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/unit/services/stygian-local-optimizer.spec.ts`; expect the 38/80 cases to return `SEARCH_BUDGET_EXCEEDED` or exceed the threshold.

- [ ] **Step 3: Implement bounded feasible seed and pool**

Introduce:

```ts
const MAX_STYGIAN_POOL_SIZE = 20;
const MAX_PHASE_CANDIDATES = 1_200;
type FeasibilityResult<T> =
  | { status: 'feasible'; value: T }
  | { status: 'infeasible' }
  | { status: 'budget-exceeded' };
```

Construct a three-phase DP seed which accounts for locks, phase coverage and reuse appearances before optimization. Build the bounded pool in this order: feasible seed, capability specialists, phase-ranked round-robin additions. Assert all combination builders receive at most 20 characters and cap each phase candidate list.

- [ ] **Step 4: Verify GREEN and refactor**

Run the focused optimizer tests and M4 optimizer regression tests. Keep deterministic key tie-breaking and separate budget/infeasible issues.

### Task 2: Reward target and difficulty compatibility

**Files:**
- Create: `src/shared/stygian-reward-policy.ts`
- Modify: `src/shared/stygian-advisor.ts`
- Modify: `src/main/services/stygian-plan-validator.ts`
- Modify: `src/main/services/stygian-local-optimizer.ts`
- Modify: `src/renderer/pages/Advisor/StygianWorkspace.tsx`
- Create: `tests/unit/shared/stygian-reward-policy.spec.ts`
- Modify: `tests/unit/services/stygian-plan-validator.spec.ts`
- Modify: `tests/unit/services/stygian-local-optimizer.spec.ts`

- [ ] **Step 1: Write failing 3×6 policy matrix tests**

Test product minima `{ primogems: 1, high-reward: 5, dire-challenge: 6 }`, every target/order pair, UI normalization behavior, validator rejection, and weak-evidence recommendations. Assert suggestions are always below selected order and never below target minimum; at minimum assert no difficulty suggestion and an instruction to lower the reward target.

- [ ] **Step 2: Verify RED**

Run the three focused specs and confirm low-order dire/high-reward pairs are incorrectly accepted and order 1–3 can suggest order 4.

- [ ] **Step 3: Implement shared policy**

Export pure functions whose optional policy input can later be sourced from a versioned scenario reward-threshold field:

```ts
export const STYGIAN_TARGET_MINIMUM_ORDER = {
  primogems: 1,
  'high-reward': 5,
  'dire-challenge': 6
} as const;
export function isStygianTargetDifficultyCompatible(target, order): boolean;
export function clampDifficultyForStygianTarget(target, selectedId, difficulties): string;
export function lowerStygianDifficultyWithinTarget(target, selectedOrder, difficulties): string | undefined;
```

Add `TARGET_DIFFICULTY_CONFLICT` to issue codes. Wire validator and service preflight. Make high-reward require stronger evidence than primogems and return product-policy language, not official reward claims. Add visible UI copy: `应用内目标档位，不代表官方奖励解锁条件` and document that a future signed scenario threshold overrides the defaults through a schema/version migration.

- [ ] **Step 4: Verify GREEN**

Run focused tests and typecheck.

### Task 3: Independent repair-turn tool evidence

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Modify: `src/main/services/stygian-plan-agent.ts`
- Modify: `src/main/services/stygian-business-tools.ts`
- Modify: `src/main/services/stygian-advisor-service.ts`
- Modify: `tests/unit/services/stygian-plan-agent.spec.ts`
- Modify: `tests/unit/services/stygian-business-tools.spec.ts`
- Modify: `tests/unit/services/stygian-advisor-service.spec.ts`

- [ ] **Step 1: Write failing repair-isolation tests**

Build a runner whose compose turn records profile + three phase + knowledge calls and returns an invalid plan, while repair returns a valid plan with zero tools. Assert Agent result fails and service uses local fallback. Assert tool log records `round: 'compose' | 'repair'` with the same correlation ID.

- [ ] **Step 2: Verify RED**

Run focused Agent/service specs; expect the repair to incorrectly borrow first-turn tools and pass.

- [ ] **Step 3: Scope validation and audit by turn**

Pass only `repairTurn.tools` to repair validation. Extend business tool `auditContext` and log type with `round`. Create a fresh MCP server/context for each Agent turn so audit logs remain attributable.

- [ ] **Step 4: Verify GREEN**

Run focused Agent, tools and service specs; confirm repair with complete independent tools still succeeds.

### Task 4: Semantic Stygian history validation

**Files:**
- Modify: `src/main/services/history-store.ts`
- Modify: `tests/unit/services/history-store.spec.ts`
- Modify: `tests/unit/ipc/history.ipc.spec.ts`

- [ ] **Step 1: Write failing corruption tests**

Inject stored records with forbidden duplicate appearances, limited-policy overuse, missing locked roles, excluded-role use, three-character teams, and absent/duplicate character name snapshots. Assert `queryStygian()` returns none and IPC cannot expose them.

- [ ] **Step 2: Verify RED**

Run the focused history specs; expect corrupt entries to leak.

- [ ] **Step 3: Add entry-level semantic refinement**

Apply `superRefine` after strict structural parsing. Compute appearances from actual phase teams; validate reuse maximum, team size/uniqueness, snapshot coverage, locked/excluded membership, and plan/entry identity. Keep `appendStygian` immutable and reject invalid writes.

- [ ] **Step 4: Verify GREEN**

Run store and IPC tests and confirm valid history remains visible/deletable.

### Task 5: Player-safe modifier localization

**Files:**
- Create: `src/shared/stygian-modifier-localization.ts`
- Modify: `src/main/services/stygian-business-tools.ts`
- Modify: `src/main/services/stygian-local-optimizer.ts`
- Modify: `src/renderer/pages/Advisor/stygian-presentation.ts`
- Modify: `src/renderer/pages/Advisor/StygianWorkspace.tsx`
- Create: `tests/unit/shared/stygian-modifier-localization.spec.ts`
- Modify: `tests/unit/services/stygian-business-tools.spec.ts`
- Modify: `tests/unit/services/stygian-local-optimizer.spec.ts`
- Modify: `tests/unit/renderer/stygian-presentation.spec.ts`
- Modify: `tests/e2e/app.spec.ts`

- [ ] **Step 1: Write failing localization tests**

Cover known keys, natural Chinese, arbitrary English sentences, kebab/snake/internal keys, and all difficulty/phase/boss modifier paths. Assert raw signed scenario remains parseable while tool payload, local result and presentation contain only localized text or `挑战修正暂无中文说明`.

- [ ] **Step 2: Verify RED**

Run focused shared/tool/optimizer/presentation tests; expect raw English and slugs to leak or result parsing to fail.

- [ ] **Step 3: Implement one localization boundary**

Add `localizeStygianModifier(value: string): string`, a small known-key map, strict Chinese-safe detection, and fallback. Route tools, optimizer `mechanismBasis`/`risks`/rotation detection, and Renderer labels through it. Do not modify publication signature schemas.

- [ ] **Step 4: Verify GREEN**

Run focused tests and the Stygian E2E at 1024 and 1600 widths.

### Task 6: Review, full gates, and commit

**Files:**
- Verify all files above

- [ ] **Step 1: Request original reviewer and root-spec review**

Provide the five requirements, base SHA `08d790f`, current HEAD/diff, and focused evidence. Fix every Critical/Important finding with a new RED→GREEN cycle.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run gate:local
npm run test:e2e:run
git diff --check
```

Expected: 0 failures. Record the existing npm audit mirror limitation separately.

- [ ] **Step 3: Commit implementation**

Stage only the root-spec closure files and commit with `fix: close Stygian root spec gaps`. Confirm clean status and report the SHA plus review verdict.
