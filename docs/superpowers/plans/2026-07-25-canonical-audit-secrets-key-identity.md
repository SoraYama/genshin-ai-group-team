# Canonical Audit Secrets And Key Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare audit secrets in one canonical privacy domain, preserve distinct irreversible identities for sensitive keys and tool IDs, and reject unsafe JavaScript numbers without weakening business-tool validation.

**Architecture:** `agent-turn-audit.ts` will canonicalize configured secrets and every candidate before comparison using the shared research privacy canonicalizer. Sensitive or unsafe input keys and tool IDs will receive domain-separated SHA-256 identities derived from canonical text, while PlanAgents will locate UID evidence only through the exact exported UID key identity. Numeric retention will require a finite safe integer plus a privacy-safe canonical representation.

**Tech Stack:** TypeScript, Node `crypto`, Vitest, existing research privacy canonicalization.

---

### Task 1: Canonical secret comparison and tool-ID pairing

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`

- [x] **Step 1: Write failing success and partial-turn tests**

Configure `s3nsitivev4lue` as a secret and audit values containing `%733nsitivev4lue`, `%25733nsitivev4lue`, full-width equivalents, and default-ignorable characters. Assert neither encoded nor canonical secret material survives in successful or failed partial audits.

- [x] **Step 2: Write a failing sensitive tool-ID pairing test**

Emit two distinct tool IDs containing canonically equivalent secret material and successful matching results. Assert the retained IDs are distinct irreversible labels and both audits succeed.

- [x] **Step 3: Verify RED**

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts
```

Expected: canonical secret text leaks after raw-only comparison and sensitive tool IDs collide as `[REDACTED]`.

- [x] **Step 4: Implement canonical comparison**

Import `canonicalizeResearchPrivacyText`, canonicalize configured values once, canonicalize candidate strings, keys, labels, and IDs before `contains`, redact every candidate whose canonicalization fails, and hash sensitive/unsafe tool IDs with a tool-ID domain prefix.

- [x] **Step 5: Verify GREEN**

Run the focused audit test and confirm all tool-use/result pairing tests remain green.

### Task 2: Distinct irreversible input-key identities

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Modify: `src/main/services/abyss-plan-agent.ts`
- Modify: `src/main/services/theater-plan-agent.ts`
- Modify: `src/main/services/stygian-plan-agent.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`
- Test: `tests/unit/services/abyss-plan-agent.spec.ts`

- [x] **Step 1: Write failing key-identity tests**

Assert `uid`, `authorization`, `token`, and a numeric dynamic key produce stable, pairwise-distinct `audit-key-<32 hex>` values; equivalent encoded UID keys produce the same identity; safe keys retain their bounded canonical labels.

- [x] **Step 2: Write failing UID-evidence isolation tests**

For otherwise successful `read_profile_cache` calls, replace the UID field with only `authorization`, `token`, or a numeric key. Assert none pass Abyss required-tool validation, while a real UID key still succeeds.

- [x] **Step 3: Verify RED**

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts tests/unit/services/abyss-plan-agent.spec.ts
```

Expected: all sensitive keys collapse to the generic placeholder, allowing unrelated credentials to impersonate UID evidence.

- [x] **Step 4: Implement exact key identities**

Export `auditToolInputKey(key, sensitiveValues?)`. Hash canonical sensitive/unsafe keys with a key-specific domain, retain canonical safe labels, use it during input collection, and make all PlanAgents read only `input[auditToolInputKey('uid')]`.

- [x] **Step 5: Verify GREEN across modes**

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/theater-plan-agent.spec.ts tests/unit/services/stygian-plan-agent.spec.ts
```

Expected: exact UID evidence succeeds; authorization/token/numeric substitutes fail.

### Task 3: Unsafe number boundary

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`

- [x] **Step 1: Write failing numeric tests**

Audit `Infinity`, `NaN`, `Number.MAX_SAFE_INTEGER + 1`, `1e21`, timestamp/credential-like integers, and ordinary `level`/`count` integers with boolean/null. Assert only finite safe, privacy-safe integers and boolean/null remain.

- [x] **Step 2: Verify RED**

Run the audit test and confirm at least `1e21` or another non-safe integer is retained by the current implementation.

- [x] **Step 3: Implement the number predicate**

Require `Number.isFinite(value)`, `Number.isSafeInteger(value)`, canonical decimal/scientific text, no canonical secret match, and a passing privacy-safe text policy before retaining the original number.

- [x] **Step 4: Verify focused tests and types**

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/theater-plan-agent.spec.ts tests/unit/services/stygian-plan-agent.spec.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

### Task 4: Full verification and commit

**Files:**
- Verify every modified source, test, and plan file.

- [x] **Step 1: Run fresh release gates**

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

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-07-25-canonical-audit-secrets-key-identity.md \
  src/main/services/agent-turn-audit.ts \
  src/main/services/abyss-plan-agent.ts \
  src/main/services/theater-plan-agent.ts \
  src/main/services/stygian-plan-agent.ts \
  tests/unit/services/agent-turn-audit.spec.ts \
  tests/unit/services/abyss-plan-agent.spec.ts
git commit -m "fix: canonicalize audit secrets and key identity"
```
