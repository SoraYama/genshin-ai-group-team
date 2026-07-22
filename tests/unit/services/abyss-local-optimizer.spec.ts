import { describe, expect, it } from 'vitest';

import { buildLocalAbyssPlan } from '../../../src/main/services/abyss-local-optimizer.js';
import { validateAbyssPlan } from '../../../src/main/services/abyss-plan-validator.js';
import { CharacterKnowledgeStore } from '../../../src/main/services/character-knowledge-store.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario,
  validAbyssPlan
} from './abyss-test-fixtures.js';

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

  it('recomputes only the requested half and preserves the other half byte-for-byte', () => {
    const prior = validAbyssPlan();
    const input = abyssInput({
      priorPlan: prior,
      recomputeHalf: 'firstHalf',
      excludedCharacterIds: [prior.firstHalfTeam.characterIds[0]!]
    });
    const result = buildLocalAbyssPlan({
      input,
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS
    });

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.secondHalfTeam).toEqual(prior.secondHalfTeam);
    expect(result.plan.chambers.map(({ secondHalf }) => secondHalf)).toEqual(
      prior.chambers.map(({ secondHalf }) => secondHalf)
    );
    expect(result.plan.firstHalfTeam.characterIds).not.toContain(input.excludedCharacterIds[0]);
  });

  it('blocks partial recompute when an intervention conflicts with the preserved half', () => {
    const prior = validAbyssPlan();
    const input = abyssInput({
      priorPlan: prior,
      recomputeHalf: 'firstHalf',
      excludedCharacterIds: [prior.secondHalfTeam.characterIds[0]!]
    });

    expect(
      buildLocalAbyssPlan({ input, scenario: abyssScenario(), characters: ABYSS_CHARACTERS })
    ).toMatchObject({ status: 'blocked', issues: [{ code: 'PRESERVED_HALF_CONFLICT' }] });
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

  it('keeps large rosters within a bounded synchronous search budget', () => {
    const largeRoster = Array.from({ length: 80 }, (_, index) => ({
      ...ABYSS_CHARACTERS[index % ABYSS_CHARACTERS.length]!,
      id: 4001 + index,
      name: `大角色池${index + 1}`,
      level: index < 8 ? 1 : 90 - (index % 10)
    }));
    const startedAt = performance.now();
    const result = buildLocalAbyssPlan({
      input: abyssInput({
        lockedCharacterIds: largeRoster.slice(0, 8).map(({ id }) => String(id))
      }),
      scenario: abyssScenario(),
      characters: largeRoster
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.status).toBe('planned');
    expect(elapsedMs).toBeLessThan(500);
  });

  it('does not lose a feasible twin-counter plan when unrelated high-score characters are added', () => {
    const scenario = abyssScenario();
    const chamber = scenario.floors[0]!.chambers[0]!;
    const geoShieldEnemy = {
      ...chamber.firstHalf.waves[0]!.enemies[0]!,
      mechanics: {
        shields: [{ element: 'geo' as const }],
        resistances: [],
        immunities: [],
        tags: ['需要岩元素破盾']
      }
    };
    scenario.floors[0]!.chambers = [
      {
        ...chamber,
        firstHalf: { waves: [{ id: 'geo-first', enemies: [geoShieldEnemy] }] },
        secondHalf: { waves: [{ id: 'geo-second', enemies: [geoShieldEnemy] }] }
      }
    ];
    const lockedPyro = Array.from({ length: 6 }, (_, index) => ({
      ...ABYSS_CHARACTERS[0]!,
      id: 6001 + index,
      name: `锁定火角色${index + 1}`,
      element: 'Pyro',
      level: 90
    }));
    const geoCounters = Array.from({ length: 2 }, (_, index) => ({
      ...ABYSS_CHARACTERS[3]!,
      id: 6101 + index,
      name: `低分岩专才${index + 1}`,
      element: 'Geo',
      level: 1
    }));
    const unrelatedPyro = Array.from({ length: 24 }, (_, index) => ({
      ...ABYSS_CHARACTERS[0]!,
      id: 6201 + index,
      name: `高分候选火角色${index + 1}`,
      element: 'Pyro',
      level: 90
    }));
    const input = abyssInput({
      chamber: 1,
      lockedCharacterIds: lockedPyro.map(({ id }) => String(id))
    });
    const baseline = buildLocalAbyssPlan({
      input,
      scenario,
      characters: [...lockedPyro, ...geoCounters]
    });
    const expanded = buildLocalAbyssPlan({
      input,
      scenario,
      characters: [...lockedPyro, ...geoCounters, ...unrelatedPyro]
    });

    expect(baseline.status).toBe('planned');
    expect(expanded.status).toBe('planned');
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

  it('retains a low-score knowledge specialist required by a hard capability tag', () => {
    const scenario = abyssScenario();
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.tags.push(
      'requires-capability:healing'
    );
    const regular = Array.from({ length: 20 }, (_, index) => ({
      ...ABYSS_CHARACTERS[index % ABYSS_CHARACTERS.length]!,
      id: 7001 + index,
      name: `高分普通角色${index + 1}`,
      level: 90
    }));
    const healer = {
      ...ABYSS_CHARACTERS[0]!,
      id: 7999,
      name: '低分治疗专才',
      level: 1
    };
    const knowledge = CharacterKnowledgeStore.fromUnknown({
      schemaVersion: 1,
      knowledgeVersion: 'optimizer-capability-v1',
      updatedAt: '2026-07-23T00:00:00.000Z',
      coverage: { characterCount: 1, notes: '仅覆盖治疗专才。' },
      characters: [
        {
          id: '7999',
          name: '低分治疗专才',
          weaponType: 'sword',
          roles: ['sustain'],
          energyCost: 60,
          energyNeeds: 'medium',
          capabilities: ['healing'],
          applicationNotes: [],
          kitNotes: [],
          unknownFields: []
        }
      ]
    });

    const result = buildLocalAbyssPlan({
      input: abyssInput(),
      scenario,
      characters: [...regular, healer],
      knowledge
    });

    expect(result.status).toBe('planned');
    if (result.status === 'planned') {
      expect(result.plan.firstHalfTeam.characterIds).toContain('7999');
    }
  });

  it('does not lose a low-score multi-capability solution when high-score single specialists are added', () => {
    const scenario = abyssScenario();
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.tags.push(
      ...['healing', 'shield', 'grouping', 'off-field', 'on-field'].map(
        (capability) => `requires-capability:${capability}`
      )
    );
    const allRounder = {
      ...ABYSS_CHARACTERS[4]!,
      id: 8999,
      name: '低分多能力角色',
      level: 1
    };
    const singleCapabilities = ['healing', 'shield', 'grouping', 'off-field', 'on-field'] as const;
    const singleSpecialists = singleCapabilities.map((_, index) => ({
      ...ABYSS_CHARACTERS[index]!,
      id: 8101 + index,
      name: `高分单项角色${index + 1}`,
      level: 90
    }));
    const unrelated = Array.from({ length: 24 }, (_, index) => ({
      ...ABYSS_CHARACTERS[index % ABYSS_CHARACTERS.length]!,
      id: 8201 + index,
      name: `高分无关角色${index + 1}`,
      level: 90
    }));
    const knowledge = CharacterKnowledgeStore.fromUnknown({
      schemaVersion: 1,
      knowledgeVersion: 'optimizer-multi-capability-v1',
      updatedAt: '2026-07-23T00:00:00.000Z',
      coverage: { characterCount: 6, notes: '覆盖多能力角色与五名单项角色。' },
      characters: [
        knowledgeEntry('8999', '低分多能力角色', [...singleCapabilities]),
        ...singleSpecialists.map((character, index) =>
          knowledgeEntry(String(character.id), character.name, [singleCapabilities[index]!])
        )
      ]
    });
    const baseline = buildLocalAbyssPlan({
      input: abyssInput({ chamber: 1 }),
      scenario,
      characters: [...ABYSS_CHARACTERS.slice(0, 8), allRounder],
      knowledge
    });
    const expanded = buildLocalAbyssPlan({
      input: abyssInput({ chamber: 1 }),
      scenario,
      characters: [...ABYSS_CHARACTERS.slice(0, 8), allRounder, ...singleSpecialists, ...unrelated],
      knowledge
    });

    expect(baseline.status).toBe('planned');
    expect(expanded.status).toBe('planned');
    if (expanded.status === 'planned') {
      expect(expanded.plan.firstHalfTeam.characterIds).toContain('8999');
    }
  });

  it('does not lose a tail-element shield counter when a partial recompute roster expands', () => {
    const prior = validAbyssPlan();
    const input = abyssInput({
      chamber: 1,
      priorPlan: { ...prior, chambers: [prior.chambers[0]!] },
      recomputeHalf: 'firstHalf',
      excludedCharacterIds: ['1001']
    });
    const unrelated = Array.from({ length: 24 }, (_, index) => ({
      ...ABYSS_CHARACTERS[index % 4]!,
      id: 9001 + index,
      name: `高分前序元素角色${index + 1}`,
      element: ['Pyro', 'Hydro', 'Anemo', 'Geo'][index % 4]!,
      level: 90
    }));
    const baseline = buildLocalAbyssPlan({
      input,
      scenario: abyssScenario(),
      characters: ABYSS_CHARACTERS
    });
    const expanded = buildLocalAbyssPlan({
      input,
      scenario: abyssScenario(),
      characters: [...ABYSS_CHARACTERS, ...unrelated]
    });

    expect(baseline.status).toBe('planned');
    expect(expanded.status).toBe('planned');
  });

  it('blocks unknown requires-capability tags instead of treating them as preferences', () => {
    const scenario = abyssScenario();
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.tags.push(
      'requires-capability:teleport'
    );
    const result = buildLocalAbyssPlan({
      input: abyssInput(),
      scenario,
      characters: ABYSS_CHARACTERS
    });

    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'MECHANIC_COVERAGE_INVALID' }]
    });
  });
});

function knowledgeEntry(
  id: string,
  name: string,
  capabilities: Array<'healing' | 'shield' | 'grouping' | 'off-field' | 'on-field'>
) {
  return {
    id,
    name,
    weaponType: 'sword' as const,
    roles: ['support' as const],
    energyCost: 60,
    energyNeeds: 'medium' as const,
    capabilities,
    applicationNotes: [],
    kitNotes: [],
    unknownFields: []
  };
}
