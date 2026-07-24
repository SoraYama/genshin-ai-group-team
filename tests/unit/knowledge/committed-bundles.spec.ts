import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  committedAdvisorKnowledgeSetSchema,
  committedCharacterCatalogSchema,
  committedCharacterStrategyBundleV2Schema,
  committedSourceRegistrySchema
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

describe('committed advisor knowledge bundles', () => {
  it('parses every committed bundle with its shared strict schema', () => {
    expect(sources.schemaVersion).toBe(1);
    expect(catalog.schemaVersion).toBe(1);
    expect(strategies.schemaVersion).toBe(2);
    expect(() =>
      committedAdvisorKnowledgeSetSchema.parse({ sources, catalog, strategies })
    ).not.toThrow();
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
        strategies: unsupportedStrategies
      }).success
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
    expect(catalog.provenance.map(({ url }) => url).sort()).toEqual(
      [
        'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json',
        'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/loc.json'
      ].sort()
    );
    expect(Object.fromEntries(catalog.provenance.map(({ id, sha256 }) => [id, sha256]))).toEqual({
      'enka-characters': '51dbaef256968a41dab3429d60f88f77f29645c4b79bf606fc93d4fbf3be33e4',
      'enka-localization': 'ee8a58105be0595b386d035377711d7aa0859d09550241b291459372bbd38976'
    });
  });
});
