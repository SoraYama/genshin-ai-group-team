import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  BuildInterpreter,
  type BuildInterpretationOptions
} from '../../../src/main/services/build-interpreter.js';
import type { AdvisorCharacterInput } from '../../../src/main/services/advisor-profile-serializer.js';
import { KnowledgeBundleStore } from '../../../src/main/services/knowledge-bundle-store.js';
import type { ArtifactMainStatKey } from '../../../src/shared/advisor-knowledge.js';

const knowledgeDirectory = resolve(process.cwd(), 'resources/knowledge');

let interpreter: BuildInterpreter;

beforeAll(async () => {
  interpreter = new BuildInterpreter(await KnowledgeBundleStore.load(knowledgeDirectory));
});

type MainStats = Record<'sands' | 'goblet' | 'circlet', ArtifactMainStatKey | 'unknown'>;

function reviewedBuild(
  id: number,
  mainStats: Partial<MainStats>,
  statOverrides: AdvisorCharacterInput['stats'] = {},
  overrides: Partial<AdvisorCharacterInput> = {}
): AdvisorCharacterInput {
  return {
    id,
    name: `Character-${id}`,
    element: 'Unknown',
    rarity: 5,
    level: 90,
    weapon: { name: 'Informational Weapon', level: 90, refinement: 1 },
    artifactSummary: {
      sets: [{ name: 'Unverified Cross-source Set', count: 4 }],
      mainStats: {
        sands: 'atkPct',
        goblet: 'atkPct',
        circlet: 'critRate',
        ...mainStats
      }
    },
    stats: {
      hp: 30_000,
      atk: 1_800,
      def: 800,
      critRate: 70,
      critDmg: 160,
      energyRecharge: 100,
      elementalMastery: 100,
      ...statOverrides
    },
    completeness: 'detailed',
    provenanceSummary: {
      ownership: 'miyoushe-list',
      build: 'miyoushe-detail',
      stats: 'enka'
    },
    ...overrides
  };
}

function interpret(character: AdvisorCharacterInput, options?: BuildInterpretationOptions) {
  return interpreter.interpret(character, options);
}

describe('BuildInterpreter reviewed archetypes', () => {
  it('recognizes Raiden triple-EM hyperbloom from canonical main stats', () => {
    const result = interpret(
      reviewedBuild(10000052, {
        sands: 'elementalMastery',
        goblet: 'elementalMastery',
        circlet: 'elementalMastery'
      })
    );

    expect(result).toMatchObject({
      archetypeId: 'raiden-em-hyperbloom',
      confidence: 'high',
      currentBuildUsable: true,
      adjustment: 'none',
      contextRequired: false
    });
    expect(result.matchedSignals).toEqual([
      'raiden-hb-sands-em',
      'raiden-hb-goblet-em',
      'raiden-hb-circlet-em'
    ]);
    expect(result.unknowns).toContain('artifact-set-identity-unverified');
  });

  it('recognizes Raiden on-field at adequate ER without requiring ER sands', () => {
    const result = interpret(
      reviewedBuild(
        10000052,
        { sands: 'atkPct', goblet: 'electroDmg', circlet: 'critRate' },
        { energyRecharge: 130 }
      )
    );

    expect(result).toMatchObject({
      archetypeId: 'raiden-emblem-on-field',
      confidence: 'medium',
      currentBuildUsable: true
    });
    expect(result.matchedSignals).toEqual(['raiden-onfield-er']);
    expect(result.conflictingSignals).not.toContain('raiden-onfield-er-sands');
  });

  it('distinguishes Kuki triple-EM and HP/healing builds', () => {
    const hyperbloom = interpret(
      reviewedBuild(10000065, {
        sands: 'elementalMastery',
        goblet: 'elementalMastery',
        circlet: 'elementalMastery'
      })
    );
    const healer = interpret(
      reviewedBuild(10000065, {
        sands: 'hpPct',
        goblet: 'electroDmg',
        circlet: 'healingBonus'
      })
    );

    expect(hyperbloom).toMatchObject({
      archetypeId: 'shinobu-em-hyperbloom',
      confidence: 'high'
    });
    expect(healer).toMatchObject({
      archetypeId: 'shinobu-healer-quicken',
      confidence: 'high'
    });
  });

  it('recognizes Nahida on-field clues and leaves overlapping high-EM builds unresolved', () => {
    const onField = interpret(
      reviewedBuild(10000073, {
        sands: 'atkPct',
        goblet: 'dendroDmg',
        circlet: 'critRate'
      })
    );
    const overlapping = reviewedBuild(
      10000073,
      {
        sands: 'elementalMastery',
        goblet: 'dendroDmg',
        circlet: 'critRate'
      },
      { elementalMastery: 900 }
    );

    expect(onField).toMatchObject({
      archetypeId: 'nahida-on-field-driver',
      confidence: 'high'
    });
    expect(interpret(overlapping)).toMatchObject({
      archetypeId: null,
      confidence: 'low',
      currentBuildUsable: true,
      adjustment: 'none',
      contextRequired: true,
      candidateArchetypeIds: ['nahida-on-field-driver', 'nahida-off-field-dendro']
    });
    expect(interpret(overlapping).unknowns).toContain('multiple-compatible-archetypes');

    expect(interpret(overlapping, { roleHint: 'off-field' })).toMatchObject({
      archetypeId: 'nahida-off-field-dendro',
      confidence: 'medium',
      currentBuildUsable: true,
      contextRequired: false
    });
  });

  it('distinguishes Kokomi bloom, off-field, and on-field clues as far as evidence permits', () => {
    const bloom = interpret(
      reviewedBuild(10000054, {
        sands: 'elementalMastery',
        goblet: 'elementalMastery',
        circlet: 'hpPct'
      })
    );
    const offField = interpret(
      reviewedBuild(10000054, {
        sands: 'hpPct',
        goblet: 'hpPct',
        circlet: 'hpPct'
      })
    );
    const onField = interpret(
      reviewedBuild(10000054, {
        sands: 'energyRecharge',
        goblet: 'hydroDmg',
        circlet: 'hpPct'
      })
    );

    expect(bloom).toMatchObject({
      archetypeId: 'kokomi-bloom-trigger',
      confidence: 'high'
    });
    expect(offField).toMatchObject({
      archetypeId: 'kokomi-off-field-healer',
      confidence: 'medium'
    });
    expect(onField).toMatchObject({
      archetypeId: 'kokomi-on-field-driver',
      confidence: 'medium'
    });
  });

  it('does not silently choose between overlapping Kokomi healing and driver clues', () => {
    const result = interpret(
      reviewedBuild(10000054, {
        sands: 'hpPct',
        goblet: 'hydroDmg',
        circlet: 'healingBonus'
      })
    );

    expect(result).toMatchObject({
      archetypeId: null,
      confidence: 'low',
      currentBuildUsable: true,
      adjustment: 'none',
      contextRequired: true,
      candidateArchetypeIds: ['kokomi-off-field-healer', 'kokomi-on-field-driver']
    });
  });

  it('recognizes Furina off-field fanfare without inventing a healer role', () => {
    const result = interpret(
      reviewedBuild(
        10000089,
        {
          sands: 'energyRecharge',
          goblet: 'hpPct',
          circlet: 'critRate'
        },
        { energyRecharge: 180, hp: 38_000, critRate: 70, critDmg: 170 }
      )
    );

    expect(result).toMatchObject({
      archetypeId: 'furina-off-field-fanfare',
      confidence: 'high',
      candidateArchetypeIds: ['furina-off-field-fanfare']
    });
    expect(result.unknowns.some((unknown) => unknown.includes('治疗'))).toBe(true);
    expect(result.unknowns.some((unknown) => unknown.includes('充能'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('"role":"healer"');
  });
});

describe('BuildInterpreter conservative boundaries', () => {
  it('keeps all 104 unreviewed catalog entries as explicit low-confidence gaps', () => {
    const bundle = JSON.parse(
      readFileSync(resolve(knowledgeDirectory, 'character-strategies.v2.json'), 'utf8')
    ) as {
      characters: Array<{ id: string; reviewState: 'reviewed' | 'unreviewed' }>;
    };
    const unreviewedIds = bundle.characters
      .filter(({ reviewState }) => reviewState === 'unreviewed')
      .map(({ id }) => id);

    expect(unreviewedIds).toHaveLength(104);
    for (const id of unreviewedIds) {
      expect(interpret(reviewedBuild(Number(id), {}))).toMatchObject({
        characterId: id,
        archetypeId: null,
        confidence: 'low',
        currentBuildUsable: false,
        adjustment: 'optional',
        contextRequired: false,
        unknowns: [`character-review-gap:${id}`]
      });
    }
    expect(
      interpret(reviewedBuild(Number(unreviewedIds[0]), {}), {
        allowRequiredAdjustment: true
      })
    ).toMatchObject({
      archetypeId: null,
      adjustment: 'optional'
    });
    expect(
      interpret(reviewedBuild(99999999, {}), {
        allowRequiredAdjustment: true
      })
    ).toMatchObject({
      archetypeId: null,
      adjustment: 'optional',
      unknowns: ['character-knowledge-unknown:99999999']
    });
  });

  it('never guesses from a basic-only or incompletely covered build', () => {
    const basic = reviewedBuild(
      10000052,
      {},
      {},
      {
        artifactSummary: undefined,
        stats: undefined,
        completeness: 'basic',
        missingFields: ['stats', 'weapon', 'artifacts', 'talents'],
        provenanceSummary: { ownership: 'miyoushe-list' }
      }
    );
    const incompleteMainStats = reviewedBuild(
      10000052,
      {},
      {},
      {
        artifactSummary: {
          sets: [],
          mainStats: { sands: 'elementalMastery', goblet: 'elementalMastery' }
        }
      }
    );

    expect(interpret(basic)).toMatchObject({
      archetypeId: null,
      confidence: 'low',
      currentBuildUsable: false,
      unknowns: expect.arrayContaining(['build-data-missing'])
    });
    expect(interpret(basic, { allowRequiredAdjustment: true })).toMatchObject({
      archetypeId: null,
      adjustment: 'optional',
      unknowns: expect.arrayContaining(['build-data-missing'])
    });
    expect(interpret(incompleteMainStats)).toMatchObject({
      archetypeId: null,
      confidence: 'low',
      currentBuildUsable: false,
      unknowns: expect.arrayContaining(['build-signal-coverage-incomplete'])
    });
  });

  it('allows required adjustment only when the caller explicitly opts in', () => {
    const incompatible = reviewedBuild(10000052, {
      sands: 'hpPct',
      goblet: 'pyroDmg',
      circlet: 'healingBonus'
    });

    expect(interpret(incompatible)).toMatchObject({
      archetypeId: null,
      confidence: 'low',
      currentBuildUsable: false,
      adjustment: 'optional'
    });
    expect(interpret(incompatible, { allowRequiredAdjustment: true })).toMatchObject({
      archetypeId: null,
      confidence: 'low',
      currentBuildUsable: false,
      adjustment: 'required'
    });
  });

  it('lowers confidence and records stale or missing build provenance', () => {
    const stale = reviewedBuild(
      10000052,
      {
        sands: 'elementalMastery',
        goblet: 'elementalMastery',
        circlet: 'elementalMastery'
      },
      {},
      {
        provenanceSummary: {
          ownership: 'miyoushe-list',
          build: 'miyoushe-detail',
          stats: 'enka',
          staleFields: ['build', 'stats']
        }
      }
    );
    const missing = reviewedBuild(
      10000052,
      {
        sands: 'elementalMastery',
        goblet: 'elementalMastery',
        circlet: 'elementalMastery'
      },
      {},
      { provenanceSummary: { ownership: 'miyoushe-list' } }
    );

    expect(interpret(stale)).toMatchObject({
      archetypeId: 'raiden-em-hyperbloom',
      confidence: 'medium',
      unknowns: expect.arrayContaining(['build-provenance-stale'])
    });
    expect(interpret(missing)).toMatchObject({
      archetypeId: 'raiden-em-hyperbloom',
      confidence: 'low',
      unknowns: expect.arrayContaining(['build-provenance-missing'])
    });
  });

  it('does not use artifact set names or weapon metadata as classification signals', () => {
    const first = reviewedBuild(10000052, {
      sands: 'elementalMastery',
      goblet: 'elementalMastery',
      circlet: 'elementalMastery'
    });
    const second = structuredClone(first);
    second.weapon = { name: 'Different Informational Weapon', level: 1 };
    second.artifactSummary!.sets = [{ name: 'Different Unverified Set', count: 5 }];

    expect(interpret(second)).toEqual(interpret(first));
    expect(JSON.stringify(interpret(second))).not.toContain('Different Unverified Set');
    expect(JSON.stringify(interpret(second))).not.toContain('Different Informational Weapon');
  });
});
