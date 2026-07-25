# Fail-Closed Audit And Exact Identities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make malformed secret configuration fail closed across audit text and tool payloads while keeping protocol pairing and semantic key/tool identities exact to the raw SDK strings.

**Architecture:** Replace the canonical secret array with a policy containing canonical values plus a `failClosed` bit, and thread that policy through successful and partial audit sanitization. Use a separate raw-string SHA-256 protocol identity for all tool-use/result maps; display IDs, unsafe keys, and changed tool names use domain-separated raw hashes so canonical aliases never gain trusted semantics.

**Tech Stack:** TypeScript, Node `crypto`, Vitest, existing research privacy canonicalizer.

---

### Task 1: Fail-closed secret policy

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`

- [x] **Step 1: Write failing malformed-secret tests**

Add a nine-layer percent-encoded API key and an eight-layer candidate to successful and error-partial tool turns. Assert final audit text, raw previews, tool labels, keys, and values contain neither the candidate nor unrelated visible text; values become `[REDACTED]`, while identities remain bounded opaque hashes.

- [x] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts
```

Expected: the malformed configured secret is dropped, so the eight-layer candidate and other tool fields remain visible.

- [x] **Step 3: Introduce the policy**

Replace `string[]` with:

```ts
interface SensitiveAuditPolicy {
  canonicalValues: readonly string[];
  failClosed: boolean;
}
```

Build it by ignoring only truly empty raw secrets. A non-empty raw value whose canonical form is missing or empty sets `failClosed: true`; valid canonical values remain available for comparisons. Thread this policy through tool IDs, names, keys, values, search queries, and partial-turn construction.

- [x] **Step 4: Verify GREEN**

Run the focused audit suite and confirm the new malformed-secret tests pass without weakening existing bounds and redaction assertions.

### Task 2: Partial and fail-closed free text

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`

- [x] **Step 1: Write failing result-error and stream-error tests**

Configure an ordinary API key that is not caught by generic privacy patterns. Emit it in assistant text before an SDK result error and before a thrown stream error. Assert `text`, `finalRawText`, and the assistant `rawMessagesSummary.textPreview` are `[REDACTED]`, while result-error bodies stay redacted and summary length flags remain correct.

- [x] **Step 2: Verify RED**

Run the focused audit suite. Expected: the assistant echo survives because `privacySafePartialTurn` currently has no access to configured secrets.

- [x] **Step 3: Sanitize partial text with the same policy**

Pass `SensitiveAuditPolicy` into `privacySafePartialTurn` and use one helper that canonicalizes before comparison. Return `[REDACTED]` on invalid canonicalization, configured-secret match, or `failClosed`; otherwise apply the existing research privacy policy. Sanitize successful raw-message previews with the same helper, but preserve the established verbatim successful-final contract up to its independent 100 KiB limit unless the entire policy is fail-closed.

- [x] **Step 4: Verify GREEN**

Run the focused audit suite and confirm safe verbatim final output remains unchanged while secret echoes are absent from partial turns.

### Task 3: Exact raw protocol and semantic identities

**Files:**
- Modify: `src/main/services/agent-turn-audit.ts`
- Test: `tests/unit/services/agent-turn-audit.spec.ts`
- Test: `tests/unit/services/abyss-plan-agent.spec.ts`

- [x] **Step 1: Write failing exact-pairing tests**

Emit tool uses `call%2D1` and `call-1`, but only a `call-1` result. Assert their display IDs differ, the encoded call remains unsuccessful, and only the literal call succeeds.

- [x] **Step 2: Write failing alias tests**

Assert `%75id`, full-width `ｕｉｄ`, and canonical `uid` produce distinct opaque input-key identities. Feed Abyss profile evidence through encoded UID keys and through an encoded `mcp__genshin__read_profile_cache` name; assert both fail required-tool validation.

- [x] **Step 3: Verify RED**

Run:

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts tests/unit/services/abyss-plan-agent.spec.ts
```

Expected: canonical-equivalent IDs pair incorrectly, encoded UID keys equal canonical UID, and the encoded tool name becomes an allowlisted MCP name.

- [x] **Step 4: Separate protocol identity from display identity**

Create an internal `toolProtocolIdentity(raw)` that hashes the exact raw string with its own domain and use only that digest in `toolsById`, result, duplicate, pending, and WebSearch pairing state. Keep map/set cardinality under existing tool limits. Make unsafe or canonicalization-changed display IDs, keys, and names hash the exact raw string with separate domains; retain a label only when the raw string equals its safe canonical form.

- [x] **Step 5: Verify GREEN across modes**

Run:

```bash
npx vitest run tests/unit/services/agent-turn-audit.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/theater-plan-agent.spec.ts tests/unit/services/stygian-plan-agent.spec.ts
npm run typecheck
```

Expected: only exact raw protocol IDs pair, semantic aliases remain opaque and distinct, and true canonical UID evidence still succeeds.

### Task 4: Release verification and commit

**Files:**
- Verify every modified source, test, and plan file.

- [x] **Step 1: Run fresh release gates**

Run each command in order:

```bash
npm run test:golden
npm test
npm run typecheck
npm run lint
npm run build
npm run test:renderer-budget
npm run pack:dir
npm run test:package-budget
git diff --check
```

- [ ] **Step 2: Commit exact scope**

Stage only this plan, `agent-turn-audit.ts`, and the two affected unit test files, then commit:

```bash
git commit -m "fix: fail closed audit canonicalization and exact ids"
```
