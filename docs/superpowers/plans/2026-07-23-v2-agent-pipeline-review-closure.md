# V2 Agent Pipeline Review Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining V2 advisor review findings across UID-scoped repairs, exact stage coverage, 112-character access, bounded contexts, usage accounting, grounded bilingual narratives, correlated cancellation, history snapshots, and custom headers.

**Architecture:** Keep deterministic local planners and validators authoritative. Replace the oversized prompt context with a bounded reference/index/detail model and compact feasible baseline; let compose/repair query any eligible character detail by UID. Make post-plan agents return only structured target/reason/fact references, validate exact target coverage, and render both locales deterministically from an evidence catalog before results or history are persisted.

**Tech Stack:** TypeScript, Zod, Electron IPC, Anthropic Agent SDK MCP tools, Vitest.

---

### Task 1: Bounded UID-scoped context and 112-character profile access

**Files:**

- Modify: `src/main/agents/contracts.ts`
- Modify: `src/main/services/v2-agent-context.ts`
- Modify: `src/main/services/advisor-profile-serializer.ts`
- Modify: `src/main/services/*-business-tools.ts`
- Test: `tests/unit/services/v2-agent-context.spec.ts`
- Test: `tests/unit/services/*-business-tools.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
expect(context.profileRef.uid).toBe('123456789');
expect(context.profile.minimalIndex).toHaveLength(112);
expect(context.profile.detailedProfiles.map(({ id }) => id)).toContain(criticalLastId);
expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(48 * 1024);
```

Add tool tests that request `{ uid, characterIds }`, page through all 112 index rows, and retrieve the final stored character without depending on storage order.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/unit/services/v2-agent-context.spec.ts tests/unit/services/abyss-business-tools.spec.ts tests/unit/services/stygian-business-tools.spec.ts tests/unit/services/theater-business-tools.spec.ts`

Expected: FAIL because `profileRef`, `minimalIndex`, bounded detail selection, and profile query selectors do not exist.

- [ ] **Step 3: Implement the bounded contract**

```ts
const context = {
  profileRef: { uid },
  profile: { minimalIndex, detailedProfiles, coverage },
  candidate: { feasibleBaseline: compactBaseline, eligibleCharacterIds },
  evidenceCatalog,
  interventions,
  knowledge
};
if (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_V2_CONTEXT_BYTES) {
  throw new V2ContextBudgetError();
}
```

Use canonical-ID ordering, with baseline and locked IDs first for detailed profiles. Add `characterIds` and cursor/page-size selectors to `read_profile_cache`; selected characters must be explicitly detail-read in every accepted compose/repair turn.

- [ ] **Step 4: Run GREEN**

Run the Task 1 test command and confirm all files pass.

### Task 2: UID repair audit, exact stage coverage, and failure-safe usage

**Files:**

- Modify: `src/main/services/agent-turn-audit.ts`
- Modify: `src/main/services/v2-agent-pipeline.ts`
- Modify: `src/main/services/*-plan-agent.ts`
- Modify: `src/main/services/*-advisor-service.ts`
- Test: `tests/unit/services/v2-agent-pipeline.spec.ts`
- Test: `tests/unit/services/*-plan-agent.spec.ts`
- Test: `tests/unit/services/*-advisor-service.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
const prompt = JSON.parse(receivedPrompt);
const uid = prompt.context.profileRef.uid;
yield * toolAuditFor(uid, selectedIds);
expect(stageTargets(rotation)).toEqual(expectedRotationTargets(plan));
expect(stageTargets(explain)).toEqual(expectedExplainTargets(plan));
expect(recordUsage).toHaveBeenCalledWith(11, 7, 0.01);
```

Cover missing, duplicate, and extra targets for every mode. Simulate successful compose followed by critique/rotation rejection, timeout, and cancellation.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/unit/services/v2-agent-pipeline.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/stygian-plan-agent.spec.ts tests/unit/services/theater-plan-agent.spec.ts tests/unit/services/abyss-advisor-service.spec.ts tests/unit/services/stygian-advisor-service.spec.ts tests/unit/services/theater-advisor-service.spec.ts`

Expected: FAIL because prompts/tests hard-code UID, coverage is only membership-based, and usage is recorded only after pipeline return.

- [ ] **Step 3: Implement exact coverage and deltas**

```ts
const expected = expectedTargetsForPlan(plan, stage);
assertExactTargetCoverage(actual, expected);
await runAuditedAgentTurn({ ...options, onUsageDelta: options.onUsageDelta });
```

Pass `profileRef.uid` explicitly in each compose/repair payload. Invoke `recordUsage` per successful turn result and remove the final aggregate service write.

- [ ] **Step 4: Run GREEN**

Run the Task 2 test command and confirm all files pass.

### Task 3: Structured grounded bilingual narrative and team critique

**Files:**

- Create: `src/shared/advisor-narrative.ts`
- Create: `src/main/services/advisor-narrative.ts`
- Modify: `src/main/agents/contracts.ts`
- Modify: `src/main/services/v2-agent-pipeline.ts`
- Modify: `src/main/services/*-plan-agent.ts`
- Modify: `src/main/services/*-local-optimizer.ts`
- Modify: `src/shared/*-advisor.ts`
- Test: `tests/unit/shared/advisor-narrative.spec.ts`
- Test: `tests/unit/services/v2-agent-pipeline.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
expect(explainSchema.safeParse({ text: 'invented fact' }).success).toBe(false);
expect(
  narrative.entries.every(
    ({ localeText, factRefs }) =>
      localeText.zhCN && localeText.enUS && factRefs.every((id) => evidence.has(id))
  )
).toBe(true);
expect(result.teamRisks.firstHalf).toHaveLength(1);
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/unit/shared/advisor-narrative.spec.ts tests/unit/services/v2-agent-pipeline.spec.ts`

Expected: FAIL because stage outputs still accept arbitrary factual prose and no bilingual result contract exists.

- [ ] **Step 3: Implement structured decisions and deterministic rendering**

```ts
const stageDecision = {
  target,
  reasonCodes: ['mechanic-match'],
  tone: 'cautious',
  factRefs: ['mechanic:abyss:12:1:first:0']
};
const localeText = renderNarrative(stageDecision, evidenceById);
```

Reject unknown fact refs and render both locales from verified evidence plus stable templates. Add strict `localizedNarrative` to all planned results and history entries. Map Abyss team critique into strict `teamRisks`; keep chamber risks half-scoped. Generate meaningful fallback narrative from deterministic plans and scenario evidence.

- [ ] **Step 4: Run GREEN**

Run the Task 3 test command and confirm all files pass.

### Task 4: Locale/history contracts, correlated Abyss cancel, and strict headers

**Files:**

- Modify: `src/shared/abyss-advisor.ts`
- Modify: `src/shared/stygian-advisor.ts`
- Modify: `src/shared/theater-advisor.ts`
- Modify: `src/shared/domain.ts`
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/abyss-advisor.ipc.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/main/services/history-store.ts`
- Modify: `src/main/ipc/config.ipc.ts`
- Modify: `src/main/services/agent-sdk-adapter.ts`
- Modify: `src/renderer/pages/Advisor/*Workspace.tsx`
- Test: `tests/unit/ipc/abyss-advisor.ipc.spec.ts`
- Test: `tests/unit/ipc/config-headers.spec.ts`
- Test: `tests/unit/services/history-store.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
expect(cancel({ correlationId: 'stale' })).toEqual({ ok: false });
expect(input.locale).toBe('en-US');
expect(history.difficultyNames).toEqual({ zhCN: '...', enUS: '...' });
expect(() => saveHeader('X-Test', 'ok\u0000bad')).toThrow();
expect(() => saveHeader('X-Test', 'é')).toThrow();
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/unit/ipc/abyss-advisor.ipc.spec.ts tests/unit/ipc/config-headers.spec.ts tests/unit/services/history-store.spec.ts`

Expected: FAIL because Abyss cancel is uncorrelated, locale snapshots are absent, and header values accept unsupported characters.

- [ ] **Step 3: Implement shared locale and validation**

Use `locale?: 'zh-CN' | 'en-US'` on advisor input for legacy compatibility while all three workspaces always send it. Save bilingual Stygian difficulty names and bilingual/stable Theater cast, Arcana, and enemy references; migrate legacy entries with missing locale values represented as `null`. Share one header validator that accepts RFC `tchar` names and only visible ASCII/tab values, rejecting CR/LF, NUL, DEL, other controls, and Unicode in save, test, and generation paths.

- [ ] **Step 4: Run GREEN**

Run the Task 4 test command and confirm all files pass.

### Task 5: Full verification, commit, and independent review

- [ ] **Step 1: Run full verification**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

- [ ] **Step 2: Review diff and commit**

```bash
git diff --check
git status --short
git add <reviewed-files>
git commit -m "fix: close v2 advisor pipeline review gaps"
```

- [ ] **Step 3: Start a read-only reviewer**

Ask the reviewer to check C1, I1–I7, Header, locale/history, tests, and default-deny permissions against the committed diff. Apply any findings through new RED/GREEN cycles and amend with a new commit.
