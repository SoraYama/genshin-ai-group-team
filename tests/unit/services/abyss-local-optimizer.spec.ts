import { describe, expect, it } from 'vitest';

import { buildLocalAbyssPlan } from '../../../src/main/services/abyss-local-optimizer.js';
import { validateAbyssPlan } from '../../../src/main/services/abyss-plan-validator.js';
import { ABYSS_CHARACTERS, abyssInput, abyssScenario } from './abyss-test-fixtures.js';

describe('buildLocalAbyssPlan', () => {
  it('jointly returns two deterministic, zero-overlap teams for all target chambers', () => {
    const input = abyssInput();
    const scenario = abyssScenario();
    const first = buildLocalAbyssPlan({ input, scenario, characters: ABYSS_CHARACTERS });
    const second = buildLocalAbyssPlan({ input, scenario, characters: ABYSS_CHARACTERS });

    expect(second).toEqual(first);
    expect(first.status).toBe('planned');
    if (first.status !== 'planned') throw new Error('Expected a plan');
    const firstIds = first.plan.firstHalfTeam.characterIds;
    const secondIds = first.plan.secondHalfTeam.characterIds;
    expect(firstIds).toHaveLength(4);
    expect(secondIds).toHaveLength(4);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect(first.plan.chambers.map(({ chamber }) => chamber)).toEqual([1, 2]);
    expect(
      validateAbyssPlan({ input, scenario, characters: ABYSS_CHARACTERS, plan: first.plan })
    ).toMatchObject({ ok: true, issues: [] });
  });

  it('keeps every lock and omits exclusions across the joint eight-character assignment', () => {
    const input = abyssInput({
      lockedCharacterIds: ['1001', '1009'],
      excludedCharacterIds: ['1002', '1010']
    });
    const result = buildLocalAbyssPlan({
      input,
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS
    });

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const ids = [
      ...result.plan.firstHalfTeam.characterIds,
      ...result.plan.secondHalfTeam.characterIds
    ];
    expect(ids).toEqual(expect.arrayContaining(['1001', '1009']));
    expect(ids).not.toEqual(expect.arrayContaining(['1002', '1010']));
  });

  it('uses known mechanics and stats without claiming unknown character roles', () => {
    const result = buildLocalAbyssPlan({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const chamber = result.plan.chambers[0]!;
    expect(chamber.firstHalf.tactics.join(' ')).toContain('训练水兽×2');
    expect(chamber.firstHalf.tactics.join(' ')).toContain('水元素护盾');
    expect(chamber.secondHalf.tactics.join(' ')).toContain('冻结');
    expect(result.assumptions.join(' ')).toContain('未知角色职责');
    expect(result.warnings.join(' ')).not.toMatch(/治疗|护盾角色|主C|副C/);
  });

  it('never exposes internal development tags in player-facing tactics', () => {
    const scenario = abyssScenario();
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.tags = [
      'development-sample',
      '多目标'
    ];
    const result = buildLocalAbyssPlan({
      input: abyssInput(),
      scenario,
      characters: ABYSS_CHARACTERS
    });

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const tactics = result.plan.chambers.flatMap(({ firstHalf }) => firstHalf.tactics).join(' ');
    expect(tactics).toContain('多目标');
    expect(tactics).not.toMatch(/development|sample/i);
  });

  it('generates only the requested chamber when the player narrows the target', () => {
    const result = buildLocalAbyssPlan({
      input: abyssInput({ chamber: 2 }),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.chambers.map(({ chamber }) => chamber)).toEqual([2]);
  });

  it('returns a structured blocked result when fewer than eight usable characters remain', () => {
    const result = buildLocalAbyssPlan({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS.slice(0, 7)
    });

    expect(result).toMatchObject({
      status: 'blocked',
      source: 'local-rules',
      issues: [
        {
          code: 'ROSTER_INSUFFICIENT',
          details: { required: 8, available: 7, missing: 1 }
        }
      ]
    });
  });

  it('blocks a roster that cannot satisfy a required elemental shield counter', () => {
    const characters = ABYSS_CHARACTERS.slice(0, 8).map((character) => ({
      ...character,
      element: 'Pyro'
    }));
    const result = buildLocalAbyssPlan({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters
    });

    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'MECHANIC_COVERAGE_INVALID' }]
    });
  });

  it('keeps a low-score half-specific shield specialist in the joint candidate pool', () => {
    const pyroCharacters = Array.from({ length: 20 }, (_, index) => ({
      ...ABYSS_CHARACTERS[index % ABYSS_CHARACTERS.length]!,
      id: 2001 + index,
      name: `高分火角色${index + 1}`,
      element: 'Pyro',
      level: 90
    }));
    const cryoSpecialist = {
      ...ABYSS_CHARACTERS[0]!,
      id: 2999,
      name: '低分破盾专才',
      element: 'Cryo',
      level: 1
    };
    const result = buildLocalAbyssPlan({
      input: abyssInput(),
      scenario: abyssScenario(),
      characters: [...pyroCharacters, cryoSpecialist]
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.firstHalfTeam.characterIds).toContain('2999');
  });

  it('blocks contradictory, excessive, or unowned locks instead of emitting an invalid plan', () => {
    const result = buildLocalAbyssPlan({
      input: abyssInput({
        lockedCharacterIds: [...ABYSS_CHARACTERS.slice(0, 9).map(({ id }) => String(id)), '9999'],
        excludedCharacterIds: ['1001']
      }),
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS
    });
    expect(result.status).toBe('blocked');
    expect(result.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'LOCK_LIMIT_EXCEEDED',
        'LOCK_EXCLUDE_CONFLICT',
        'CHARACTER_NOT_OWNED'
      ])
    );
  });
});
