# Grounded Advisor Audit Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Abyss knowledge scoping, structured assignment, explanation evidence, research audit, progress timing, and safe provider-diagnostic gaps without changing Task9 UI/IPC or writing searched data into trusted knowledge.

**Architecture:** Build one immutable per-run knowledge bundle containing a shared character packet plus target-scoped mechanic/scenario slices keyed by `floor:chamber:half`. Composer emits validated member assignments; Explain evidence is deterministically derived from those assignments and the packet rather than trusted from model prose. Guide research returns a sanitized audited turn to the single recommendation trace owner, while shared v2 behavior remains unchanged outside Abyss.

**Tech Stack:** TypeScript, Zod, Vitest, Anthropic agent SDK adapter, Electron main process.

---

### Task 1: Target-scoped knowledge and research

**Files:**
- Modify: `src/main/services/abyss-advisor-service.ts`
- Modify: `src/main/services/abyss-business-tools.ts`
- Modify: `src/main/services/knowledge-coverage-gate.ts`
- Modify: `src/main/services/advisor-knowledge-service.ts`
- Modify: `src/shared/advisor-knowledge.ts`
- Test: `tests/unit/services/abyss-advisor-service.spec.ts`
- Test: `tests/unit/services/abyss-business-tools.spec.ts`
- Test: `tests/unit/services/knowledge-coverage-gate.spec.ts`

- [ ] **Step 1: Write failing target-scope tests**

Add fixtures where the first half matches a mechanic and the second half carries its avoid tag, plus target-bound ephemeral and unknown entries. Assert that each `query_team_knowledge` result exposes only its own target entries/citations, an unbound entry is invisible, and a failed mechanic/scenario search forces low confidence with a target-key assumption.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/unit/services/abyss-advisor-service.spec.ts tests/unit/services/abyss-business-tools.spec.ts tests/unit/services/knowledge-coverage-gate.spec.ts
```

Expected: failures showing cross-half aggregation and missing target bindings.

- [ ] **Step 3: Implement the immutable scope map**

Represent target keys as canonical `floor:chamber:first|second` strings. Build mechanic analysis independently from each half’s enemies; store trusted mechanic match IDs and unknown subject IDs per target. Extend coverage bindings and ephemeral merge records with target keys, and filter tool output by the exact requested target. Do not add any trusted knowledge writer.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command and expect all tests to pass.

### Task 2: Smart member assignments and deterministic five-section evidence

**Files:**
- Modify: `src/shared/abyss-advisor.ts`
- Modify: `src/main/agents/abyss-composer/prompt.ts`
- Modify: `src/main/services/abyss-plan-validator.ts`
- Modify: `src/main/services/abyss-plan-agent.ts`
- Modify: `src/main/services/abyss-local-optimizer.ts`
- Modify: `src/main/services/abyss-advisor-service.ts`
- Modify: `src/main/services/v2-narrative.ts`
- Test: `tests/unit/shared/abyss-advisor.spec.ts`
- Test: `tests/unit/services/abyss-plan-validator.spec.ts`
- Test: `tests/unit/services/abyss-plan-agent.spec.ts`
- Test: `tests/unit/services/v2-narrative-contract.spec.ts`
- Test: `tests/unit/services/abyss-advisor-service.spec.ts`

- [ ] **Step 1: Write failing assignment and evidence tests**

Assert smart output requires exactly eight assignments covering both teams and rejects missing members, wrong halves, wrong archetypes, wrong trusted roles, cross-character citations, and omitted required adjustments. Assert local and legacy plans parse with `memberAssignments: []`. Assert smart results expose deterministic five-section evidence using validated citation metadata and no model-authored URL.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/unit/shared/abyss-advisor.spec.ts tests/unit/services/abyss-plan-validator.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/v2-narrative-contract.spec.ts tests/unit/services/abyss-advisor-service.spec.ts
```

Expected: schema and validator failures for missing contracts.

- [ ] **Step 3: Implement compatible contracts and validation**

Add `memberAssignments` with defaults for legacy/local data and a strict smart validator against build interpretations, trusted role/archetype data, citation policy, unknowns, and `noBuildChange`. Add a structured evidence contract containing the five required sections and safe citation metadata; derive it only after assignment validation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command and expect all tests to pass.

### Task 3: Research audit and safe provider diagnostics

**Files:**
- Modify: `src/main/services/guide-research-contract.ts`
- Modify: `src/main/services/guide-research-agent.ts`
- Modify: `src/main/services/abyss-advisor-service.ts`
- Modify: `src/main/services/agent-turn-audit.ts`
- Modify: `src/shared/agent-run-trace.ts`
- Test: `tests/unit/services/guide-research-agent.spec.ts`
- Test: `tests/unit/services/abyss-advisor-service.spec.ts`
- Test: `tests/unit/services/agent-run-trace-store.spec.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`

- [ ] **Step 1: Write failing audit tests**

Assert a live successful search returns a sanitized audited turn with raw output/messages, WebSearch tools/evidence and usage; cache-only returns usage zero and `searched: false`; invalid output still retains the successful turn; provider failures retain stable SDK code and HTTP status but no response body, secret, or unsafe query.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/unit/services/guide-research-agent.spec.ts tests/unit/services/abyss-advisor-service.spec.ts tests/unit/services/agent-run-trace-store.spec.ts tests/unit/services/agent-turn-audit.spec.ts
```

Expected: missing audit fields and missing research trace usage/tools.

- [ ] **Step 3: Implement sanitized research audit propagation**

Return an optional audited turn and stable failure from research, record real research raw/tool/usage/citations in the existing recommendation trace lease, aggregate its usage, and distinguish cache-only resolution from a live search. Sanitize provider diagnostics to stable code/status only.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command and expect all tests to pass.

### Task 4: Real stage progress timing and release gates

**Files:**
- Modify: `src/main/services/v2-agent-pipeline.ts`
- Modify: `src/main/services/abyss-plan-agent.ts`
- Modify: `src/main/services/abyss-advisor-service.ts`
- Test: `tests/unit/services/v2-agent-pipeline.spec.ts`
- Test: `tests/unit/services/abyss-advisor-service.spec.ts`

- [ ] **Step 1: Write failing progress-order tests**

Use hanging Critique, Rotation, and Explain runners. Assert `checking-conflicts` is emitted when Critique starts and `writing-tactics` when Rotation/Explain starts, with neither emitted only after the pipeline completes.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/unit/services/v2-agent-pipeline.spec.ts tests/unit/services/abyss-advisor-service.spec.ts
```

Expected: missing stage-start callback and late progress.

- [ ] **Step 3: Implement the stage-start callback**

Add an optional pipeline stage-start callback, forward it through `AbyssPlanAgent`, and map Critique to `checking-conflicts` and Rotation/Explain to `writing-tactics`. Remove the trailing synthetic progress emissions.

- [ ] **Step 4: Run all gates and commit**

Run:

```bash
npm run test:golden
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: all commands pass. Commit with:

```bash
git commit -m "fix: close grounded advisor audit gaps"
```
