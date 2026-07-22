import { describe, expect, it } from 'vitest';

import { validateAbyssPlan } from '../../../src/main/services/abyss-plan-validator.js';
import { CharacterKnowledgeStore } from '../../../src/main/services/character-knowledge-store.js';
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

  it('requires a partial recompute to preserve the other team and its per-chamber tactics exactly', () => {
    const priorPlan = validAbyssPlan();
    const input = abyssInput({ priorPlan, recomputeHalf: 'firstHalf' });
    const changed = validAbyssPlan({
      secondHalfTeam: { ...priorPlan.secondHalfTeam, purpose: '被智能服务擅自改写' }
    });
    changed.chambers[0] = {
      ...changed.chambers[0]!,
      secondHalf: { ...changed.chambers[0]!.secondHalf, tactics: ['被擅自改写'] }
    };

    const result = validateAbyssPlan({
      input,
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS,
      plan: changed
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PRESERVED_HALF_CHANGED' })])
    );
  });

  it('rejects teams that cannot satisfy a hard enemy shield mechanic', () => {
    const characters = ABYSS_CHARACTERS.map((character) => ({ ...character, element: 'Pyro' }));
    const result = validateAbyssPlan({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters,
      plan: validAbyssPlan()
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toContain('MECHANIC_COVERAGE_INVALID');
  });

  it('rejects a half whose known elements are all immune', () => {
    const scenario = abyssScenario();
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.immunities = [
      'pyro',
      'geo',
      'cryo',
      'electro'
    ];
    const result = validateAbyssPlan({
      input: abyssInput(),
      scenario,
      characters: ABYSS_CHARACTERS,
      plan: validAbyssPlan()
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MECHANIC_COVERAGE_INVALID',
          details: expect.objectContaining({ mechanic: 'immunity' })
        })
      ])
    );
  });

  it.each([
    ['requires-capability:healing', { capabilities: ['healing'], weaponType: 'sword' }],
    ['requires-capability:bow', { capabilities: [], weaponType: 'bow' }],
    ['requires-capability:onslaught', { capabilities: ['onslaught'], weaponType: 'sword' }]
  ] as const)(
    'enforces the documented hard mechanic %s using character knowledge',
    (tag, known) => {
      const scenario = abyssScenario();
      scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.tags.push(tag);
      const knowledge = knowledgeFor1001(known);

      expect(
        validateAbyssPlan({
          input: abyssInput(),
          scenario,
          characters: ABYSS_CHARACTERS,
          knowledge,
          plan: validAbyssPlan()
        })
      ).toMatchObject({ ok: true, issues: [] });
    }
  );

  it('fails closed for unmet or unknown hard requirements and preferences cannot override them', () => {
    const scenario = abyssScenario();
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.tags.push(
      'requires-capability:healing',
      'requires-capability:teleport'
    );
    const result = validateAbyssPlan({
      input: abyssInput({
        preferences: {
          comfort: 'high',
          survival: 'high',
          lowInvestment: 'high',
          noBuildChange: true
        }
      }),
      scenario,
      characters: ABYSS_CHARACTERS,
      knowledge: knowledgeFor1001({ capabilities: [], weaponType: 'sword' }),
      plan: validAbyssPlan()
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MECHANIC_COVERAGE_INVALID',
          details: expect.objectContaining({ requirement: 'healing' })
        }),
        expect.objectContaining({
          code: 'MECHANIC_COVERAGE_INVALID',
          details: expect.objectContaining({ requirement: 'teleport', unknownRequirement: true })
        })
      ])
    );
  });

  it('does not harden ordinary descriptive tags', () => {
    const scenario = abyssScenario();
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.tags.push(
      '建议携带治疗角色'
    );

    expect(
      validateAbyssPlan({
        input: abyssInput(),
        scenario,
        characters: ABYSS_CHARACTERS,
        plan: validAbyssPlan()
      })
    ).toMatchObject({ ok: true, issues: [] });
  });
});

function knowledgeFor1001(input: { capabilities: readonly string[]; weaponType: string }) {
  return CharacterKnowledgeStore.fromUnknown({
    schemaVersion: 1,
    knowledgeVersion: 'mechanic-test-v1',
    updatedAt: '2026-07-23T00:00:00.000Z',
    coverage: { characterCount: 1, notes: '仅覆盖测试角色。' },
    characters: [
      {
        id: '1001',
        name: '测试角色1',
        weaponType: input.weaponType,
        roles: ['support'],
        energyCost: 60,
        energyNeeds: 'medium',
        capabilities: input.capabilities,
        applicationNotes: [],
        kitNotes: [],
        unknownFields: []
      }
    ]
  });
}
