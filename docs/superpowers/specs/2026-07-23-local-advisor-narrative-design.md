# Deterministic Local Advisor Narrative Design

## Goal

Every successful local-rule plan, including an AI fallback that returns the validated local plan,
must carry complete bilingual narrative sections for the exact UI targets. Blocked results and
legacy history keep their explicit unavailable state.

## Boundary

Create one main-process builder that accepts a plan only after the corresponding mode validator
has succeeded. The builder consumes the validated plan structure, target identity, and locale. It
must not consume `purpose`, `rotationNotes`, tactics, warnings, assumptions, route notes, or any
other arbitrary prose stored in the plan.

The output uses the existing shared `AdvisorNarrative` contract:

- `origin` is `local-rules`.
- `requestedLocale` is the user's `zh-CN` or `en-US` locale.
- Both `zh-CN` and `en-US` summary, title, and body values are always saved.
- `reasonCodes` and `factRefs` use only existing typed enums and discriminated unions.
- Every section key is derived from the validated plan structure.

## Exact section coverage

### Spiral Abyss

- `abyss-team:first`
- `abyss-team:second`
- `abyss-chamber:<floor>:<chamber>:first` for every validated chamber
- `abyss-chamber:<floor>:<chamber>:second` for every validated chamber

Team sections cite `plan:selected-team` with `setup-order`. Chamber sections cite
`plan:validated-target` with `setup-order`. Text identifies only the validated half and chamber;
it does not claim an enemy mechanic or character capability.

### Stygian Onslaught

- `stygian-phase:<phase>` for every validated phase

Each section cites `plan:selected-team` and `plan:validated-target` with `setup-order`. Text states
that the saved phase team is the validated local allocation for that phase without claiming a
specific skill, role, or boss mechanic.

### Imaginarium Theater

- `theater-cast`
- `theater-act:<act>` for every validated act

The cast section cites `plan:cast-allocation` with `cast-flexibility`. Each act section cites
`plan:vigor-ledger` with `vigor-budget`. Text states only that the validated cast allocation and
Vigor ledger determine the saved route.

## Integration

The three local planners add the generated narrative only after their mode validator returns the
validated plan. Advisor services already use the successful local planner result as the no-key
result and as the AI-error fallback, so the same complete narrative reaches the UI and history
without a second repair path. Smart-service success continues to use `renderV2Narrative`.

## Failure behavior

The builder parses its output with `advisorNarrativeSchema`. It rejects unsupported modes or
malformed plan structures through the existing typed plan boundary; it does not synthesize missing
targets. Blocked results continue to use the schema default with no sections, because there is no
validated plan to describe. Legacy history continues to use `legacy-unavailable` and
`requestedLocale: null`.

## Verification

Unit tests prove exact target-key sets, bilingual non-placeholder text, typed reason/fact pairs, and
deterministic output for all three modes. Service tests prove both no-key and AI-fallback success
preserve exact sections into history. E2E tests assert real local rationale for each visible target
and reject the unavailable placeholder in successful local flows.
