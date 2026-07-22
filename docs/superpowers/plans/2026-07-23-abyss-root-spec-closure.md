# Abyss Root Specification Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven remaining production, knowledge, mechanics, localization, freshness, partial-recompute, and audit gaps in the Spiral Abyss planner.

**Architecture:** Compose verified production scenario publication behind one fail-closed factory; add a strict bundled character-knowledge boundary used by MCP tools and hard-mechanic validation; extend the existing v2 request with a complete prior plan and one requested recompute half. Keep renderer state player-facing and correlate every request/tool audit event without logging UIDs, complete rosters, or secrets.

**Tech Stack:** Electron main process, TypeScript, Zod, React 19, Vitest, Playwright, existing M1 `ScenePublicationService`.

---

### Task 1: Production publication composition and LKG semantics

**Files:**

- Create: `src/main/scenario-publication/production-composition.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/services/abyss-scenario-service.ts`
- Modify: `src/shared/abyss-advisor.ts`
- Test: `tests/unit/scenario-publication/production-composition.spec.ts`
- Test: `tests/unit/services/abyss-scenario-service.spec.ts`

- [ ] Write failing composition tests proving configured production uses `HttpScenarioPublicationReader`, userData `FileScenarioPublicationStorage`, production public keys, signature verification, LKG fallback, and typed 404 unavailability.
- [ ] Run the tests and confirm failure because no production factory is wired.
- [ ] Implement a strict config loader accepting a read-only packaged JSON object or explicit environment values; reject absent/invalid URL or public keys without falling back to legacy scenario files.
- [ ] Inject `() => publication.refresh('spiral-abyss')` into `AbyssScenarioService` when configured.
- [ ] Add four-state LKG tests: fresh/expiring allowed with refresh warning; stale/unknown blocked.
- [ ] Implement `usableForRecommendation` and player-facing refresh-warning semantics; rerun focused tests.

### Task 2: Versioned character knowledge and hard capability mechanics

**Files:**

- Create: `src/shared/character-knowledge.ts`
- Create: `src/main/services/character-knowledge-store.ts`
- Create: `resources/knowledge/characters.v1.json`
- Create: `docs/character-knowledge.md`
- Modify: `src/main/services/abyss-business-tools.ts`
- Modify: `src/main/services/abyss-plan-validator.ts`
- Modify: `src/main/services/abyss-local-optimizer.ts`
- Modify: `src/main/services/abyss-plan-agent.ts`
- Modify: `src/main/services/abyss-advisor-service.ts`
- Modify: `src/shared/abyss-mechanics.ts`
- Test: `tests/unit/services/character-knowledge-store.spec.ts`
- Test: `tests/unit/services/abyss-business-tools.spec.ts`
- Test: `tests/unit/services/abyss-plan-validator.spec.ts`
- Test: `tests/unit/services/abyss-local-optimizer.spec.ts`

- [ ] Write failing schema/store tests for strict version, bounds, known lookup, unknown result, coverage, and `unknownFields`.
- [ ] Implement the strict v1 schema/store and a small legal bundled seed with explicit coverage/version.
- [ ] Write failing MCP tests proving `query_genshin_db` returns knowledge rather than profile echo and audit metadata includes `knowledgeVersion` without UID/roster data.
- [ ] Implement knowledge-backed MCP output and aggregate smart-path coverage assumptions/confidence degradation.
- [ ] Write failing capability-tag tests for `requires-capability:healing|shield|grouping|bow|claymore|onslaught`, unknown requirements, ordinary descriptive tags, and preference non-override.
- [ ] Implement the documented tag parser and enforce it in optimizer, validator, and Agent context.

### Task 3: Hide unsafe legacy custom-drill defaults

**Files:**

- Modify: `src/renderer/pages/Advisor/AdvisorPage.tsx`
- Modify: `src/renderer/i18n/index.tsx`
- Modify: `tests/e2e/app.spec.ts`

- [ ] Add an E2E assertion that normal and production UI never render `abyss-mage`, `ruin-guard`, or English enemy slugs even after expanding every available section.
- [ ] Confirm it fails on the prefilled legacy advanced area.
- [ ] Gate the legacy free-text drill behind `GTA_ENABLE_LEGACY_ADVISOR === '1'` exposed as a non-secret public capability; remove English defaults and use empty Chinese custom input when enabled.
- [ ] Rerun focused E2E.

### Task 4: True preserved-half recomputation

**Files:**

- Modify: `src/shared/abyss-advisor.ts`
- Modify: `src/main/services/abyss-advisor-service.ts`
- Modify: `src/main/services/abyss-local-optimizer.ts`
- Modify: `src/main/services/abyss-plan-validator.ts`
- Modify: `src/main/services/abyss-plan-agent.ts`
- Modify: `src/main/agents/abyss-composer/prompt.ts`
- Modify: `src/renderer/pages/Advisor/AbyssWorkspace.tsx`
- Modify: `src/renderer/styles/pages/advisor.css`
- Modify: `tests/unit/services/abyss-advisor-service.spec.ts`
- Modify: `tests/unit/services/abyss-local-optimizer.spec.ts`
- Modify: `tests/unit/services/abyss-plan-validator.spec.ts`
- Modify: `tests/e2e/app.spec.ts`

- [ ] Write failing strict-contract tests requiring `priorPlan` plus `recomputeHalf` together and rejecting mismatched scenario/version/target.
- [ ] Write failing optimizer/validator/service tests proving the preserved team remains byte-for-byte exact, overlap/lock/exclusion conflicts are blocked, and a new complete snapshot is persisted.
- [ ] Implement preserved-half constraints through local optimizer, validator, Agent prompt/context/audit, and service.
- [ ] Write failing E2E for retained stale result, “待更新” state, upper/lower recompute actions, and full-recompute conflict copy.
- [ ] Implement the UI state/action flow without clearing the prior plan on every intervention change.

### Task 5: Correlated redacted audit trail

**Files:**

- Modify: `src/main/services/abyss-business-tools.ts`
- Modify: `src/main/services/abyss-advisor-service.ts`
- Modify: `src/main/index.ts`
- Test: `tests/unit/services/abyss-business-tools.spec.ts`
- Test: `tests/unit/services/abyss-advisor-service.spec.ts`

- [ ] Write failing tests requiring every MCP event to include shared `correlationId`, `scenarioId`, `dataVersion`, safe parameter summaries, knowledge version, and issue codes while excluding UID, character lists, API keys, and authorization values.
- [ ] Implement one request-scoped audit context injected into every business tool and completion/fallback issue log.
- [ ] Verify serialized audit events against an explicit deny-list.

### Task 6: Verification, formatting, commit, and review

- [ ] Run all focused suites for composition, scenario, knowledge, tools, validator, optimizer, service, renderer presentation, IPC, and E2E.
- [ ] Run `npm run format`, inspect the diff, then run `npm run gate:local`.
- [ ] Run `npm run test:e2e:run` and inspect the Spiral Abyss input/result/history screenshots at 1024×768 and 1600×1000.
- [ ] Run `git diff --check`, commit the complete root-spec closure, and send the exact HEAD plus evidence to the existing M4 reviewer.
- [ ] Fix every Critical/Important through another red-green cycle and obtain an explicit Ready verdict.
