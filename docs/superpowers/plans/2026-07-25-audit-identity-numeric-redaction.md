# Audit Identity And Numeric Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve private, stable tool-audit correlation matching while preventing dynamic keys, UIDs, credentials, and timestamp-like numeric values from leaking through successful or partial audits.

**Architecture:** `agent-turn-audit.ts` will expose one domain-separated SHA-256 correlation normalizer used both when collecting tool calls and when Abyss validates the expected request identity. The existing recursive tool-input sanitizer will normalize keys before collection, merge collisions safely, and apply the same privacy policy to string and numeric values without changing tool-result pairing or truncation semantics.

**Tech Stack:** TypeScript, Node `crypto`, Vitest, Zod-backed agent pipeline.

---

### Task 1: Stable private audit correlation

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Modify: `src/main/services/abyss-plan-agent.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`
- Test: `tests/unit/services/abyss-plan-agent.spec.ts`
- Test: `tests/unit/services/abyss-advisor-service.spec.ts`

- [x] **Step 1: Write failing audit identity tests**

Add assertions that `auditCorrelationId('abyss-1784952000000-1')` is deterministic, fixed-format, different from another correlation, and never contains the original correlation.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/abyss-advisor-service.spec.ts
```

Expected: failure because the exported correlation normalizer does not exist or UI-format correlations are stored as `[REDACTED]` and fail Abyss validation.

- [x] **Step 3: Implement the minimal shared normalizer**

Export a domain-separated SHA-256 helper returning a fixed prefix plus digest slice. Use it for every collected audit correlation and normalize `context.input.correlationId` before Abyss filters tool evidence.

- [x] **Step 4: Verify GREEN and isolation**

Run the same focused command. Assert the real UI correlation reaches `smart-service`, while tool evidence from a different normalized correlation remains excluded.

### Task 2: Dynamic-key and numeric input privacy

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`

- [x] **Step 1: Write failing success and partial-turn tests**

Use inputs containing:

```ts
{
  '123456789': 'x',
  uid: 123456789,
  apiKey: 'secret',
  'dynamic-secret-key': 'dynamic-secret-value',
  timestamp: 1784952000000,
  ratio: 0.75,
  enabled: true,
  empty: null
}
```

Assert raw dynamic keys, UID/credential/timestamp values, and configured secrets never appear; ordinary numeric, boolean, and null values remain; output count and serialized size stay bounded for success and error partial turns.

- [x] **Step 2: Run the audit test and verify RED**

Run:

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts
```

Expected: raw numeric key and numeric UID/timestamp appear in the collected audit.

- [x] **Step 3: Implement key and numeric normalization**

Normalize keys through sensitive-key, configured-secret, and `privacySafePartialText` checks. Replace unsafe keys with a stable redacted-key token, merge collisions without retaining overwritten raw values, and pass numeric strings through the privacy policy before retaining the original number.

- [x] **Step 4: Verify focused behavior and types**

Run:

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/abyss-advisor-service.spec.ts
npm run typecheck
```

Expected: all focused tests and typecheck pass.

### Task 3: Full verification and commit

**Files:**
- Verify all modified source, tests, and this plan.

- [x] **Step 1: Run the fresh release gates**

```bash
npm run test:golden &&
npm test &&
npm run typecheck &&
npm run lint &&
npm run build &&
npm run test:renderer-budget &&
npm run pack:dir &&
npm run test:package-budget &&
git diff --check
```

Expected: every command exits zero.

- [x] **Step 2: Commit the verified scope**

```bash
git add docs/superpowers/plans/2026-07-25-audit-identity-numeric-redaction.md \
  src/main/services/agent-turn-audit.ts \
  src/main/services/abyss-plan-agent.ts \
  tests/unit/services/agent-turn-audit.spec.ts \
  tests/unit/services/abyss-plan-agent.spec.ts \
  tests/unit/services/abyss-advisor-service.spec.ts
git commit -m "fix: stabilize audit identity and redact numeric inputs"
```
