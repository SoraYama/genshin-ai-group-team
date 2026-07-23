import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAbyssPlan } from '../../src/main/services/abyss-plan-validator.js';
import { validateStygianPlan } from '../../src/main/services/stygian-plan-validator.js';
import { validateTheaterPlan } from '../../src/main/services/theater-plan-validator.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario,
  validAbyssPlan
} from '../unit/services/abyss-test-fixtures.js';
import {
  STYGIAN_CHARACTERS,
  stygianInput,
  stygianScenario,
  validStygianPlan
} from '../unit/services/stygian-test-fixtures.js';
import {
  THEATER_CHARACTERS,
  THEATER_KNOWLEDGE,
  theaterInput,
  theaterScenario,
  validTheaterPlan
} from '../unit/services/theater-test-fixtures.js';

const fixturePath = path.resolve(
  import.meta.dirname,
  '../fixtures/verified-historical/advisor-rules.json'
);

describe('source-verified historical gameplay facts', () => {
  it('keeps provenance and the absence of a current production feed explicit', async () => {
    const fixture = await loadFixture();
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.scope).toBe('verified-historical-facts-only');
    expect(fixture.retrievedAt).toBe('2026-07-23');
    expect(fixture.license).toBe('CC BY-SA 3.0');
    expect(fixture.attribution).toContain('Genshin Impact Wiki');
    expect(fixture.currentProductionScenarioAvailable).toBe(false);
    for (const mode of [
      fixture.spiralAbyss,
      fixture.imaginariumTheater,
      fixture.stygianOnslaught
    ]) {
      expect(mode.sourceUrl).toMatch(/^https:\/\/genshin-impact\.fandom\.com\/wiki\//u);
      expect(mode.rulesSourceUrl).toMatch(/^https:\/\/genshin-impact\.fandom\.com\/wiki\//u);
      expect(mode.snapshot).toBeTruthy();
    }
  });

  it('anchors the three planners to sourced historical rule shapes', async () => {
    const fixture = await loadFixture();
    expect(fixture.spiralAbyss).toMatchObject({
      chambersPerFloor: 3,
      halvesPerChamber: 2,
      partySizePerHalf: 4,
      sameCharacterAcrossHalves: false
    });
    expect(fixture.imaginariumTheater).toMatchObject({
      acts: 10,
      partySizePerAct: 4,
      vigorPerCharacter: 2,
      vigorCostPerAct: 1,
      hardMinimumLevel: 70,
      eligibleElements: ['Pyro', 'Hydro', 'Cryo']
    });
    expect(fixture.imaginariumTheater.openingCharacters).toHaveLength(6);
    expect(fixture.imaginariumTheater.specialGuests).toHaveLength(4);
    expect(fixture.stygianOnslaught).toMatchObject({
      battlefields: 3,
      timedPhases: 3,
      battlefieldNames: ['Glacial Wolf', 'Hydro Tulpa', 'The Open-Eyed']
    });
    expect(fixture.stygianOnslaught.difficultyNames).toHaveLength(6);
  });

  it('drives planner validators with the sourced party, phase, level, and vigor limits', async () => {
    const fixture = await loadFixture();

    const abyss = abyssScenario();
    const abyssPlan = validAbyssPlan();
    expect(abyssPlan.firstHalfTeam.characterIds).toHaveLength(
      fixture.spiralAbyss.partySizePerHalf
    );
    expect(abyssPlan.secondHalfTeam.characterIds).toHaveLength(
      fixture.spiralAbyss.partySizePerHalf
    );
    expect(
      validateAbyssPlan({
        input: abyssInput(),
        scenario: abyss,
        characters: ABYSS_CHARACTERS,
        plan: abyssPlan
      })
    ).toMatchObject({ ok: true });
    expect(
      validateAbyssPlan({
        input: abyssInput(),
        scenario: abyss,
        characters: ABYSS_CHARACTERS,
        plan: {
          ...abyssPlan,
          firstHalfTeam: {
            ...abyssPlan.firstHalfTeam,
            characterIds: abyssPlan.firstHalfTeam.characterIds.slice(
              0,
              fixture.spiralAbyss.partySizePerHalf - 1
            )
          }
        }
      })
    ).toMatchObject({ ok: false });
    expect(
      validateAbyssPlan({
        input: abyssInput(),
        scenario: abyss,
        characters: ABYSS_CHARACTERS,
        plan: {
          ...abyssPlan,
          secondHalfTeam: {
            ...abyssPlan.secondHalfTeam,
            characterIds: [
              abyssPlan.firstHalfTeam.characterIds[0]!,
              ...abyssPlan.secondHalfTeam.characterIds.slice(1)
            ]
          }
        }
      })
    ).toMatchObject({
      ok: fixture.spiralAbyss.sameCharacterAcrossHalves,
      issues: fixture.spiralAbyss.sameCharacterAcrossHalves
        ? undefined
        : expect.arrayContaining([expect.objectContaining({ code: 'CROSS_TEAM_DUPLICATE' })])
    });

    const stygian = stygianScenario();
    const stygianPlan = validStygianPlan();
    expect(stygian.phases).toHaveLength(fixture.stygianOnslaught.timedPhases);
    expect(stygian.difficulties).toHaveLength(fixture.stygianOnslaught.difficultyNames.length);
    expect(
      validateStygianPlan({
        input: stygianInput(),
        scenario: stygian,
        characters: STYGIAN_CHARACTERS,
        plan: stygianPlan
      })
    ).toMatchObject({ ok: true });
    expect(
      validateStygianPlan({
        input: stygianInput(),
        scenario: stygian,
        characters: STYGIAN_CHARACTERS,
        plan: {
          ...stygianPlan,
          phases: stygianPlan.phases.slice(0, fixture.stygianOnslaught.timedPhases - 1)
        }
      })
    ).toMatchObject({ ok: false });

    const baseTheater = theaterScenario();
    const allowedElements = fixture.imaginariumTheater.eligibleElements.map((element) =>
      element.toLowerCase()
    ) as typeof baseTheater.eligibility.elements;
    const theater = {
      ...baseTheater,
      eligibility: {
        ...baseTheater.eligibility,
        elements: allowedElements,
        minimumLevel: fixture.imaginariumTheater.hardMinimumLevel
      },
      vigor: {
        ...baseTheater.vigor,
        initial: fixture.imaginariumTheater.vigorPerCharacter,
        actCosts: baseTheater.vigor.actCosts.map((item) => ({
          ...item,
          cost: fixture.imaginariumTheater.vigorCostPerAct
        }))
      }
    };
    const theaterCharacters = THEATER_CHARACTERS.map((character, index) =>
      index < 8
        ? { ...character, element: fixture.imaginariumTheater.eligibleElements[index % 3]! }
        : character
    );
    const theaterPlan = validTheaterPlan();
    expect(
      theaterPlan.acts.every(
        ({ candidateCharacterIds }) =>
          candidateCharacterIds.length === fixture.imaginariumTheater.partySizePerAct
      )
    ).toBe(true);
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: theater,
        characters: theaterCharacters,
        knowledge: THEATER_KNOWLEDGE,
        plan: theaterPlan
      })
    ).toMatchObject({ ok: true });
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: theater,
        characters: theaterCharacters,
        knowledge: THEATER_KNOWLEDGE,
        plan: {
          ...theaterPlan,
          acts: theaterPlan.acts.map((act, index) =>
            index === 0
              ? {
                  ...act,
                  candidateCharacterIds: act.candidateCharacterIds.slice(
                    0,
                    fixture.imaginariumTheater.partySizePerAct - 1
                  ),
                  plannedVigorSpend: act.plannedVigorSpend.slice(
                    0,
                    fixture.imaginariumTheater.partySizePerAct - 1
                  )
                }
              : act
          )
        }
      })
    ).toMatchObject({ ok: false });
    const underLevelCharacters = theaterCharacters.map((character, index) =>
      index === 0
        ? { ...character, level: fixture.imaginariumTheater.hardMinimumLevel - 1 }
        : character
    );
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: theater,
        characters: underLevelCharacters,
        knowledge: THEATER_KNOWLEDGE,
        plan: theaterPlan
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'CAST_ELIGIBILITY_INVALID' })
      ])
    });
    const wrongElementCharacters = theaterCharacters.map((character, index) =>
      index === 0 ? { ...character, element: 'Electro' } : character
    );
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: theater,
        characters: wrongElementCharacters,
        knowledge: THEATER_KNOWLEDGE,
        plan: theaterPlan
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'CAST_ELIGIBILITY_INVALID' })
      ])
    });

    const repeatedAct = {
      ...theaterPlan.acts[0]!,
      act: 3,
      plannedVigorSpend: theaterPlan.acts[0]!.plannedVigorSpend.map((spend) => ({
        ...spend,
        cost: fixture.imaginariumTheater.vigorCostPerAct
      }))
    };
    const exhaustedAct = { ...repeatedAct, act: 4 };
    const vigorScenario = {
      ...theater,
      acts: [
        ...theater.acts,
        { ...theater.acts[0]!, act: 3 },
        { ...theater.acts[0]!, act: 4 }
      ],
      vigor: {
        ...theater.vigor,
        actCosts: [
          ...theater.vigor.actCosts,
          { act: 3, cost: fixture.imaginariumTheater.vigorCostPerAct },
          { act: 4, cost: fixture.imaginariumTheater.vigorCostPerAct }
        ]
      }
    };
    expect(
      validateTheaterPlan({
        input: theaterInput(),
        scenario: vigorScenario,
        characters: theaterCharacters,
        knowledge: THEATER_KNOWLEDGE,
        plan: {
          ...theaterPlan,
          acts: [...theaterPlan.acts, repeatedAct, exhaustedAct]
        }
      })
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'VIGOR_BUDGET_INVALID' })])
    });
  });
});

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as HistoricalAdvisorFacts;
}

interface HistoricalAdvisorFacts {
  schemaVersion: number;
  scope: string;
  retrievedAt: string;
  license: string;
  attribution: string;
  currentProductionScenarioAvailable: boolean;
  spiralAbyss: {
    snapshot: string;
    sourceUrl: string;
    rulesSourceUrl: string;
    chambersPerFloor: number;
    halvesPerChamber: number;
    partySizePerHalf: number;
    sameCharacterAcrossHalves: boolean;
  };
  imaginariumTheater: {
    snapshot: string;
    sourceUrl: string;
    rulesSourceUrl: string;
    acts: number;
    partySizePerAct: number;
    vigorPerCharacter: number;
    vigorCostPerAct: number;
    hardMinimumLevel: number;
    eligibleElements: string[];
    openingCharacters: string[];
    specialGuests: string[];
  };
  stygianOnslaught: {
    snapshot: string;
    sourceUrl: string;
    rulesSourceUrl: string;
    battlefields: number;
    timedPhases: number;
    battlefieldNames: string[];
    difficultyNames: string[];
  };
}
