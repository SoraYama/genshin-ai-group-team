import { describe, expect, it } from 'vitest';

import { validateAbyssPlan } from '../../../src/main/services/abyss-plan-validator.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario,
  validAbyssPlan
} from './abyss-test-fixtures.js';

function issueCodes(plan: unknown, input = abyssInput()): string[] {
  return validateAbyssPlan({
    input,
    scenario: abyssScenario(),
    characters: ABYSS_CHARACTERS,
    plan
  }).issues.map(({ code }) => code);
}

describe('validateAbyssPlan', () => {
  it('accepts a fixed, zero-overlap pair covering every selected chamber', () => {
    expect(
      validateAbyssPlan({
        input: abyssInput(),
        scenario: abyssScenario(),
        characters: ABYSS_CHARACTERS,
        plan: validAbyssPlan()
      })
    ).toEqual({ ok: true, issues: [], plan: validAbyssPlan() });
  });

  it.each([
    ['SCENARIO_MISMATCH', { scenarioId: 'wrong' }],
    ['DATA_VERSION_MISMATCH', { dataVersion: 'wrong' }]
  ])('reports %s with a stable path', (expected, overrides) => {
    expect(issueCodes(validAbyssPlan(overrides))).toContain(expected);
  });

  it('reports a missing target floor or chamber', () => {
    expect(issueCodes(validAbyssPlan(), abyssInput({ floor: 13 }))).toContain('TARGET_NOT_FOUND');
    expect(issueCodes(validAbyssPlan(), abyssInput({ chamber: 3 }))).toContain('TARGET_NOT_FOUND');
  });

  it('reports team size, team duplicates, and cross-team overlap separately', () => {
    const plan = validAbyssPlan() as unknown as {
      firstHalfTeam: { characterIds: string[] };
      secondHalfTeam: { characterIds: string[] };
    };
    plan.firstHalfTeam.characterIds = ['1001', '1001', '1002'];
    plan.secondHalfTeam.characterIds = ['1002', '1005', '1006', '1007'];
    const codes = issueCodes(plan);
    expect(codes).toEqual(
      expect.arrayContaining(['TEAM_SIZE_INVALID', 'TEAM_DUPLICATE', 'CROSS_TEAM_DUPLICATE'])
    );
  });

  it('rejects unknown, excluded, and omitted locked characters', () => {
    const plan = validAbyssPlan({
      secondHalfTeam: {
        ...validAbyssPlan().secondHalfTeam,
        characterIds: ['1005', '1006', '1007', '9999']
      }
    });
    const codes = issueCodes(
      plan,
      abyssInput({ lockedCharacterIds: ['1008'], excludedCharacterIds: ['1007'] })
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'CHARACTER_NOT_OWNED',
        'CHARACTER_EXCLUDED',
        'LOCKED_CHARACTER_MISSING'
      ])
    );
  });

  it('reports lock overflow and lock/exclusion conflict even before generation', () => {
    const locked = ABYSS_CHARACTERS.slice(0, 9).map(({ id }) => String(id));
    const codes = issueCodes(
      validAbyssPlan(),
      abyssInput({ lockedCharacterIds: locked, excludedCharacterIds: [locked[0]!] })
    );
    expect(codes).toEqual(expect.arrayContaining(['LOCK_LIMIT_EXCEEDED', 'LOCK_EXCLUDE_CONFLICT']));
  });

  it('requires exactly the selected chamber set and non-empty tactics', () => {
    const plan = validAbyssPlan() as unknown as { chambers: unknown[] };
    const first = plan.chambers[0] as {
      firstHalf: { tactics: string[] };
    };
    first.firstHalf.tactics = [];
    plan.chambers.push({
      ...(plan.chambers[1] as Record<string, unknown>),
      chamber: 3
    });
    const codes = issueCodes(plan);
    expect(codes).toEqual(expect.arrayContaining(['CHAMBER_COVERAGE_INVALID', 'TACTICS_MISSING']));
  });

  it('limits a chamber-specific request to that chamber only', () => {
    const plan = validAbyssPlan({ chambers: [validAbyssPlan().chambers[0]!] });
    expect(
      validateAbyssPlan({
        input: abyssInput({ chamber: 1 }),
        scenario: abyssScenario(),
        characters: ABYSS_CHARACTERS,
        plan
      })
    ).toMatchObject({ ok: true, issues: [] });
  });
});
