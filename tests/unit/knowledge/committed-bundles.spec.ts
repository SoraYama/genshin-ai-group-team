import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { committedAdvisorKnowledgeSetSchema } from '../../../src/main/services/committed-advisor-knowledge.js';
import {
  committedCharacterCatalogSchema,
  committedCharacterStrategyBundleV2Schema,
  committedReviewEvidenceBundleSchema,
  committedSourceRegistrySchema,
  enemyMechanicStrategyBundleSchema
} from '../../../src/shared/advisor-knowledge.js';

const knowledgeDirectory = resolve(process.cwd(), 'resources/knowledge');

function readJson(fileName: string): unknown {
  return JSON.parse(readFileSync(resolve(knowledgeDirectory, fileName), 'utf8'));
}

const sources = committedSourceRegistrySchema.parse(readJson('sources.v1.json'));
const catalog = committedCharacterCatalogSchema.parse(readJson('character-catalog.v1.json'));
const strategies = committedCharacterStrategyBundleV2Schema.parse(
  readJson('character-strategies.v2.json')
);
const evidence = committedReviewEvidenceBundleSchema.parse(readJson('review-evidence.v1.json'));
const mechanicsInput = readJson('enemy-mechanic-strategies.v1.json');

function clonedKnowledgeSet() {
  return {
    sources: structuredClone(sources),
    catalog: structuredClone(catalog),
    strategies: structuredClone(strategies),
    mechanics: enemyMechanicStrategyBundleSchema.parse(structuredClone(mechanicsInput)),
    evidence: structuredClone(evidence)
  };
}

describe('committed advisor knowledge bundles', () => {
  it('parses every committed bundle with its shared strict schema', () => {
    const mechanics = enemyMechanicStrategyBundleSchema.parse(mechanicsInput);
    expect(sources.schemaVersion).toBe(1);
    expect(catalog.schemaVersion).toBe(1);
    expect(strategies.schemaVersion).toBe(2);
    expect(mechanics.schemaVersion).toBe(1);
    expect(() =>
      committedAdvisorKnowledgeSetSchema.parse({
        sources,
        catalog,
        strategies,
        mechanics,
        evidence
      })
    ).not.toThrow();
  });

  it('covers the required scenario tags with capability-only mechanic policies', () => {
    const mechanics = enemyMechanicStrategyBundleSchema.parse(mechanicsInput);
    const mechanicByTag = new Map(
      mechanics.mechanics.flatMap((mechanic) =>
        mechanic.matchTags.map((tag) => [tag, mechanic.id] as const)
      )
    );

    expect(Object.fromEntries(mechanicByTag)).toMatchObject({
      'elemental-shield': 'shield-breaking',
      'high-resistance': 'resistance-avoidance',
      'multi-wave': 'wave-efficient-rotation',
      groupable: 'grouping-value',
      'single-target': 'single-target-pressure',
      'survival-pressure': 'sustain-required'
    });
    expect(mechanicByTag.get('ungroupable')).toBe('ungroupable-pressure');
    expect(mechanicByTag.get('burrow')).toBe('mobile-window-alignment');
    expect(mechanicByTag.get('short-damage-window')).toBe('mobile-window-alignment');
    expect(mechanicByTag.get('reaction-restricted')).toBe('reaction-constraint');

    const serialized = JSON.stringify(mechanics);
    expect(serialized).not.toMatch(/characterIds|10000052|10000065|10000073|10000089/);
    for (const mechanic of mechanics.mechanics) {
      expect(mechanic.avoidTags).toBeDefined();
      expect(mechanic.requiredCapabilities.length).toBeGreaterThan(0);
      expect(mechanic.preferredArchetypes.length).toBeGreaterThan(0);
      expect(mechanic.teamSkeletonHints.length).toBeGreaterThan(0);
      expect(mechanic.facts.length).toBeGreaterThan(0);
    }
  });

  it('rejects mechanic bundles that smuggle an unregistered trusted source', () => {
    const mechanics = enemyMechanicStrategyBundleSchema.parse(mechanicsInput);
    mechanics.sourceRegistry.sources.push({
      id: 'unregistered-source',
      name: 'Unregistered source',
      hosts: ['unregistered.example'],
      trust: 'trusted-local',
      homepageUrl: 'https://unregistered.example/'
    });

    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        sources,
        catalog,
        strategies,
        mechanics,
        evidence
      }).success
    ).toBe(false);
  });

  it.each([
    [
      'source id',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.sources[0]!.id = 'tampered-official-source';
      }
    ],
    [
      'source display name',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.sources[0]!.displayName += ' tampered';
      }
    ],
    [
      'source host',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.sources[0]!.host = 'tampered.hoyoverse.com';
      }
    ],
    [
      'source trust',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        (bundle.sources.sources[0] as { trust: string }).trust = 'ephemeral-web';
      }
    ],
    [
      'source review cadence',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.sources[0]!.reviewCadenceDays += 1;
      }
    ],
    [
      'citation id',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations[0]!.id += '-tampered';
      }
    ],
    [
      'citation source id',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations[0]!.sourceId = 'hoyolab-wiki';
      }
    ],
    [
      'citation URL',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations[0]!.url += '?tampered=1';
      }
    ],
    [
      'citation title',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations[0]!.title += ' tampered';
      }
    ],
    [
      'citation reviewedAt',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations[0]!.reviewedAt = '2026-07-25T00:00:00Z';
      }
    ],
    [
      'citation retrievedAt',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations[0]!.retrievedAt = '2026-07-25T00:00:00Z';
      }
    ],
    [
      'citation trust',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        (bundle.sources.citations[0] as { trust: string }).trust = 'ephemeral-web';
      }
    ],
    [
      'citation character subjects',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations[0]!.subjectCharacterIds = ['10000089'];
      }
    ],
    [
      'citation mechanic subjects',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations.at(-1)!.subjectMechanicIds = ['shield-breaking'];
      }
    ],
    [
      'citation evidence version',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        (bundle.sources.citations[0] as { reviewEvidenceVersion: string }).reviewEvidenceVersion =
          'tampered-evidence-v1';
      }
    ],
    [
      'citation evidence digest',
      (bundle: ReturnType<typeof clonedKnowledgeSet>) => {
        bundle.sources.citations[0]!.reviewEvidenceSha256 = '0'.repeat(64);
      }
    ]
  ])('rejects a single-field %s trust-policy mutation', (_label, mutate) => {
    const bundle = clonedKnowledgeSet();
    mutate(bundle);

    expect(committedAdvisorKnowledgeSetSchema.safeParse(bundle).success).toBe(false);
  });

  it('rejects a coordinated mechanic citation title mutation across top-level and embedded registries', () => {
    const bundle = clonedKnowledgeSet();
    const citationId = bundle.mechanics.sourceRegistry.citations[0]!.id;
    bundle.mechanics.sourceRegistry.citations[0]!.title += ' tampered';
    bundle.sources.citations.find(({ id }) => id === citationId)!.title += ' tampered';

    expect(committedAdvisorKnowledgeSetSchema.safeParse(bundle).success).toBe(false);
  });

  it('indexes every upstream canonical character exactly once in catalog and strategy data', () => {
    const catalogIds = catalog.characters.map(({ id }) => id);
    const strategyIds = strategies.characters.map(({ id }) => id);

    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(new Set(strategyIds).size).toBe(strategyIds.length);
    expect(catalogIds).toHaveLength(109);
    expect([...strategyIds].sort()).toEqual([...catalogIds].sort());
  });

  it('audits every non-canonical numeric upstream entry excluded from the roster', () => {
    expect(catalog.exclusions.map(({ id }) => id).sort()).toEqual(
      ['10000901', '10000902', '10000903', '10000904', '11000046'].sort()
    );
    for (const exclusion of catalog.exclusions) {
      expect(exclusion.reason.length).toBeGreaterThan(0);
    }
    expect(catalog.exclusions.find(({ id }) => id === '10000903')).toMatchObject({
      kind: 'alternate-variant',
      canonicalId: '10000116'
    });
    expect(catalog.exclusions.find(({ id }) => id === '10000904')).toMatchObject({
      kind: 'provisional'
    });
  });

  it('keeps conservative indexed gaps structurally complete without inflating review coverage', () => {
    for (const character of strategies.characters) {
      expect(character.baseRoles.length).toBeGreaterThan(0);
      expect(character.archetypes.length).toBeGreaterThan(0);

      for (const archetype of character.archetypes) {
        expect(archetype).toHaveProperty('environments');
        expect(archetype).toHaveProperty('teammateSlots');
        expect(archetype).toHaveProperty('unknowns');
      }

      if (character.reviewState === 'unreviewed') {
        expect(character.baseRoles).toEqual(['unclassified']);
        expect(character.archetypes.every(({ coverage }) => coverage === 'gap')).toBe(true);
        expect(character.archetypes.every(({ unknowns }) => unknowns.length > 0)).toBe(true);
        expect(character.archetypes.every(({ facts }) => facts.length === 0)).toBe(true);
      } else {
        expect(character.archetypes.every(({ facts }) => facts.length > 0)).toBe(true);
        for (const archetype of character.archetypes) {
          if (archetype.coverage !== 'reviewed') {
            throw new Error('Reviewed character archetypes must be reviewed');
          }
          expect(archetype.requiredMode).toBe('all');
          expect(archetype.minimumSupportingWeight).toBeGreaterThanOrEqual(0);
          expect(
            archetype.signals.every(
              ({ required, weight }) =>
                typeof required === 'boolean' &&
                Number.isInteger(weight) &&
                weight >= 1 &&
                weight <= 5
            )
          ).toBe(true);
          const signalFields: string[] = archetype.signals.map(({ field }) => field);
          expect(signalFields).not.toContain('artifactSet');
        }
      }
    }

    const reviewedIds = strategies.characters
      .filter(({ reviewState }) => reviewState === 'reviewed')
      .map(({ id }) => id)
      .sort();
    expect(reviewedIds).toEqual(
      ['10000052', '10000054', '10000065', '10000073', '10000089'].sort()
    );
  });

  it('resolves every fact citation against the reviewed registry', () => {
    const citationsById = new Map(sources.citations.map((citation) => [citation.id, citation]));

    for (const character of strategies.characters) {
      for (const archetype of character.archetypes) {
        for (const fact of archetype.coverage === 'reviewed' ? archetype.facts : []) {
          for (const citationId of fact.citationIds) {
            const citation = citationsById.get(citationId);
            expect(citation, `${fact.id} -> ${citationId}`).toBeDefined();
            expect(citation?.trust).toBe('trusted-local');
          }
        }
      }
    }
  });

  it('rejects stale source versions and unresolved trusted citations as one knowledge set', () => {
    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        sources,
        catalog,
        mechanics: mechanicsInput,
        evidence,
        strategies: { ...strategies, sourceVersion: 'stale-source-version' }
      }).success
    ).toBe(false);

    const unsupportedStrategies = structuredClone(strategies);
    const reviewedCharacter = unsupportedStrategies.characters.find(
      ({ reviewState }) => reviewState === 'reviewed'
    );
    if (reviewedCharacter === undefined) throw new Error('reviewed fixture is required');
    reviewedCharacter.archetypes[0]!.facts[0]!.citationIds = ['missing-citation'];

    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        sources,
        catalog,
        mechanics: mechanicsInput,
        evidence,
        strategies: unsupportedStrategies
      }).success
    ).toBe(false);

    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        sources,
        catalog,
        mechanics: mechanicsInput,
        evidence,
        strategies: { ...strategies, catalogVersion: 'stale-catalog-version' }
      }).success
    ).toBe(false);
  });

  it('rejects citations whose declared subject does not include the fact character', () => {
    const swappedSources = structuredClone(sources);
    const raidenCitation = swappedSources.citations.find(
      ({ id }) => id === 'kqm-raiden-quickguide'
    );
    if (raidenCitation === undefined) throw new Error('Raiden citation is required');
    raidenCitation.subjectCharacterIds = ['10000089'];

    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        sources: swappedSources,
        catalog,
        strategies,
        mechanics: mechanicsInput,
        evidence
      }).success
    ).toBe(false);
  });

  it('rejects incomplete signal matching policies', () => {
    const invalidStrategies = structuredClone(strategies);
    const reviewedCharacter = invalidStrategies.characters.find(
      ({ reviewState }) => reviewState === 'reviewed'
    );
    if (reviewedCharacter === undefined) throw new Error('reviewed fixture is required');
    const reviewedArchetype = reviewedCharacter.archetypes.find(
      ({ coverage }) => coverage === 'reviewed'
    );
    if (reviewedArchetype === undefined) throw new Error('reviewed archetype is required');
    if (reviewedArchetype.coverage !== 'reviewed') {
      throw new Error('reviewed archetype coverage is required');
    }
    reviewedArchetype.minimumSupportingWeight = 99;

    expect(committedCharacterStrategyBundleV2Schema.safeParse(invalidStrategies).success).toBe(
      false
    );

    const matchEverythingStrategies = structuredClone(strategies);
    const matchEverythingCharacter = matchEverythingStrategies.characters.find(
      ({ reviewState }) => reviewState === 'reviewed'
    );
    if (matchEverythingCharacter === undefined) throw new Error('reviewed fixture is required');
    const matchEverythingArchetype = matchEverythingCharacter.archetypes.find(
      ({ coverage }) => coverage === 'reviewed'
    );
    if (matchEverythingArchetype?.coverage !== 'reviewed') {
      throw new Error('reviewed archetype is required');
    }
    matchEverythingArchetype.signals = matchEverythingArchetype.signals.map((signal) => ({
      ...signal,
      required: false
    }));
    matchEverythingArchetype.minimumSupportingWeight = 0;

    expect(
      committedCharacterStrategyBundleV2Schema.safeParse(matchEverythingStrategies).success
    ).toBe(false);
  });

  it('rejects reviewed characters whose base role remains unclassified', () => {
    const invalidStrategies = structuredClone(strategies);
    const reviewedCharacter = invalidStrategies.characters.find(
      ({ reviewState }) => reviewState === 'reviewed'
    );
    if (reviewedCharacter === undefined) throw new Error('reviewed fixture is required');
    reviewedCharacter.baseRoles = ['unclassified'];

    expect(committedCharacterStrategyBundleV2Schema.safeParse(invalidStrategies).success).toBe(
      false
    );
  });

  it('records immutable upstream provenance hashes for the catalog snapshot', () => {
    expect(catalog.provenance).toHaveLength(2);
    for (const { url } of catalog.provenance) {
      expect(url).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/EnkaNetwork\/API-docs\/[0-9a-f]{40}\/store\/(?:characters|loc)\.json$/
      );
      expect(url).not.toContain('/master/');
    }
    expect(Object.fromEntries(catalog.provenance.map(({ id, sha256 }) => [id, sha256]))).toEqual({
      'enka-characters': '51dbaef256968a41dab3429d60f88f77f29645c4b79bf606fc93d4fbf3be33e4',
      'enka-localization': 'ee8a58105be0595b386d035377711d7aa0859d09550241b291459372bbd38976'
    });
  });
});
