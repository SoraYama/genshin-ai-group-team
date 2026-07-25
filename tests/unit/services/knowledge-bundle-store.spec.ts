import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  KnowledgeBundleLoadError,
  KnowledgeBundleStore
} from '../../../src/main/services/knowledge-bundle-store.js';

const knowledgeDirectory = resolve(process.cwd(), 'resources/knowledge');
const fileNames = [
  'sources.v1.json',
  'character-catalog.v1.json',
  'character-strategies.v2.json',
  'enemy-mechanic-strategies.v1.json',
  'review-evidence.v1.json'
] as const;

type KnowledgeFileName = (typeof fileNames)[number];

function committedFiles(): Record<KnowledgeFileName, string> {
  return Object.fromEntries(
    fileNames.map((fileName) => [
      fileName,
      readFileSync(resolve(knowledgeDirectory, fileName), 'utf8')
    ])
  ) as Record<KnowledgeFileName, string>;
}

function injectedReader(files: Partial<Record<KnowledgeFileName, string>>) {
  return async (filePath: string, _encoding: 'utf8'): Promise<string> => {
    const fileName = basename(filePath) as KnowledgeFileName;
    const contents = files[fileName];
    if (contents === undefined) throw new Error(`missing ${fileName}`);
    return contents;
  };
}

describe('KnowledgeBundleStore', () => {
  it('loads the committed bundle and exposes only requested cloned records', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);

    expect(store.version).toBe('2026-07-25.reviewed-2');
    expect(store.catalogVersion).toBe('enka-2026-07-24');
    expect(store.getCatalogEntry('10000052')).toMatchObject({
      id: '10000052',
      name: '雷电将军'
    });
    expect(store.getCharacterStrategy('10000052')).toMatchObject({
      status: 'reviewed',
      characterId: '10000052',
      strategy: { id: '10000052', reviewState: 'reviewed' }
    });
    expect(store.getCharacterStrategy('10000002')).toMatchObject({
      status: 'gap',
      characterId: '10000002'
    });
    expect(store.getCharacterStrategy('99999999')).toEqual({
      status: 'unknown',
      characterId: '99999999',
      knowledgeVersion: store.version
    });

    const raiden = store.getArchetype('10000052', 'raiden-em-hyperbloom');
    expect(raiden?.id).toBe('raiden-em-hyperbloom');
    raiden!.signals[0]!.description = 'mutated outside the store';
    expect(
      store.getArchetype('10000052', 'raiden-em-hyperbloom')?.signals[0]?.description
    ).not.toBe('mutated outside the store');

    const catalogEntry = store.getCatalogEntry('10000052')!;
    catalogEntry.name = 'mutated outside the store';
    expect(store.getCatalogEntry('10000052')?.name).toBe('雷电将军');

    const strategy = store.getCharacterStrategy('10000052');
    if (strategy.status !== 'reviewed') throw new Error('reviewed fixture is required');
    strategy.strategy.name = 'mutated outside the store';
    expect(store.getCharacterStrategy('10000052')).toMatchObject({
      strategy: { name: '雷电将军' }
    });
  });

  it('resolves only committed citations and returns fresh clones', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);

    const first = store.citations([
      'kqm-raiden-quickguide',
      'missing-citation',
      'kqm-raiden-quickguide'
    ]);
    expect(first.map(({ id }) => id)).toEqual(['kqm-raiden-quickguide']);
    first[0]!.title = 'mutated outside the store';
    expect(store.citations(['kqm-raiden-quickguide'])[0]?.title).toBe('Raiden Shogun Quick Guide');
  });

  it('exposes a cloned research registry/catalog and enforces committed character-archetype citation bindings', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);

    const registry = store.getSourceRegistry();
    expect(registry.sources).toContainEqual({
      id: 'kqm-guides',
      host: 'keqingmains.com',
      trust: 'trusted-local'
    });
    registry.sources[0]!.host = 'mutated.example';
    expect(store.getSourceRegistry().sources[0]!.host).not.toBe('mutated.example');

    const catalog = store.getCanonicalCharacterCatalog();
    expect(catalog).toContainEqual({ name: '雷电将军', element: 'electro' });
    catalog[0]!.name = 'mutated outside store';
    expect(store.getCanonicalCharacterCatalog()[0]!.name).not.toBe('mutated outside store');

    expect(
      store.supportsCharacterCitation(
        'kqm-raiden-quickguide',
        '10000052',
        'raiden-em-hyperbloom'
      )
    ).toBe(true);
    expect(
      store.supportsCharacterCitation(
        'kqm-raiden-quickguide',
        '10000054',
        'raiden-em-hyperbloom'
      )
    ).toBe(false);
    expect(
      store.supportsCharacterCitation(
        'kqm-raiden-quickguide',
        '10000052',
        'raiden-unreviewed-archetype'
      )
    ).toBe(false);
    expect(
      store.supportsCharacterCitation('missing-citation', '10000052', 'raiden-em-hyperbloom')
    ).toBe(false);
  });

  it('matches reviewed scenario mechanics by normalized tags and returns fresh clones', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);

    const matches = store.matchMechanics([
      'elemental-shield',
      'high-resistance',
      'multi-wave',
      'groupable',
      'single-target',
      'survival-pressure'
    ]);
    expect(matches.map(({ id }) => id)).toEqual([
      'shield-breaking',
      'resistance-avoidance',
      'wave-efficient-rotation',
      'grouping-value',
      'single-target-pressure',
      'sustain-required'
    ]);

    matches[0]!.requiredCapabilities[0] = 'mutated-outside-store';
    expect(store.getMechanicStrategy('shield-breaking')?.requiredCapabilities).toEqual([
      'counter-element-application'
    ]);
  });

  it('classifies avoid-only tags as recognized neutral and leaves only unregistered tags unknown', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);

    expect(
      store.analyzeMechanics([
        'shield-absent',
        'single-wave-only',
        'stationary-target',
        'future-unknown-mechanic'
      ])
    ).toMatchObject({
      matched: [],
      conflicts: [],
      recognizedNeutralTags: ['shield-absent', 'single-wave-only', 'stationary-target'],
      unknownTags: ['future-unknown-mechanic']
    });
  });

  it.each([
    [['elemental-shield', 'shield-absent'], ['shield-breaking']],
    [['multi-wave', 'single-wave-only'], ['wave-efficient-rotation']],
    [
      ['groupable', 'ungroupable'],
      ['grouping-value', 'ungroupable-pressure']
    ]
  ])('classifies contradictory tags %j as canonical mechanic conflicts', async (tags, ids) => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);
    const analysis = store.analyzeMechanics(tags);

    expect(analysis.matched).toEqual([]);
    expect(analysis.unknownTags).toEqual([]);
    expect(analysis.conflicts.map(({ mechanicId }) => mechanicId)).toEqual(ids);
    for (const conflict of analysis.conflicts) {
      expect(conflict.matchTags.length).toBeGreaterThan(0);
      expect(conflict.avoidTags.length).toBeGreaterThan(0);
    }
  });

  it('marks mechanic knowledge stale outside the cadence of every supporting source', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);

    expect(
      store.mechanicCoverageFor({
        mechanicIds: ['shield-breaking'],
        now: new Date('2026-07-26T00:00:00+08:00')
      }).trustedMechanicIds
    ).toEqual(['shield-breaking']);
    expect(
      store.mechanicCoverageFor({
        mechanicIds: ['shield-breaking'],
        now: new Date('2027-01-22T01:00:00+08:00')
      }).trustedMechanicIds
    ).toEqual([]);
  });

  it('reports exactly five reviewed characters as trusted without expanding gap details', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);
    const allIds = JSON.parse(committedFiles()['character-catalog.v1.json']).characters.map(
      ({ id }: { id: string }) => id
    );

    const coverage = store.coverageFor({
      characterIds: allIds,
      now: new Date('2026-07-25T00:00:00+08:00')
    });
    expect(coverage.requestedCharacterIds).toHaveLength(109);
    expect(coverage.trustedCharacterIds.sort()).toEqual(
      ['10000052', '10000054', '10000065', '10000073', '10000089'].sort()
    );
    expect(coverage.unknownCharacterIds).toHaveLength(104);
    expect(JSON.stringify(coverage)).not.toContain('strategy-gap-');

    expect(
      store.coverageFor({
        characterIds: ['10000052', '10000002', '99999999', '10000052'],
        now: new Date('2026-07-25T00:00:00+08:00')
      })
    ).toEqual({
      knowledgeVersion: store.version,
      catalogVersion: store.catalogVersion,
      requestedCharacterIds: ['10000052', '10000002', '99999999'],
      trustedCharacterIds: ['10000052'],
      unknownCharacterIds: ['10000002', '99999999']
    });
  });

  it('moves reviewed characters outside their source cadence back to unknown coverage', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);

    expect(
      store.coverageFor({
        characterIds: ['10000052'],
        now: new Date('2026-10-24T00:00:00+08:00')
      })
    ).toEqual({
      knowledgeVersion: store.version,
      catalogVersion: store.catalogVersion,
      requestedCharacterIds: ['10000052'],
      trustedCharacterIds: [],
      unknownCharacterIds: ['10000052']
    });
  });

  it('does not trust review evidence before its declared review time', async () => {
    const store = await KnowledgeBundleStore.load(knowledgeDirectory);

    expect(
      store.coverageFor({
        characterIds: ['10000052'],
        now: new Date('2026-07-24T20:00:00+08:00')
      }).trustedCharacterIds
    ).toEqual([]);
  });

  it('fails loading on malformed JSON, missing files, or catalog-version mismatch', async () => {
    const files = committedFiles();
    const malformed = KnowledgeBundleStore.load(
      '/virtual/knowledge',
      injectedReader({ ...files, 'sources.v1.json': 'x' })
    );
    await expect(malformed).rejects.toMatchObject({
      name: 'KnowledgeBundleLoadError',
      stage: 'parse',
      fileName: 'sources.v1.json',
      message: 'Malformed JSON in trusted knowledge file sources.v1.json'
    });

    const missing = KnowledgeBundleStore.load('/virtual/knowledge', async (filePath, encoding) => {
      if (basename(filePath) === 'sources.v1.json') {
        throw new Error('secret-cookie=must-not-leak');
      }
      return injectedReader(files)(filePath, encoding);
    });
    await expect(missing).rejects.toMatchObject({
      name: 'KnowledgeBundleLoadError',
      stage: 'read',
      fileName: 'sources.v1.json',
      message: 'Unable to read trusted knowledge file sources.v1.json'
    });
    await expect(missing).rejects.not.toThrow(/secret-cookie/);

    const mismatchedStrategies = JSON.parse(files['character-strategies.v2.json']);
    mismatchedStrategies.catalogVersion = 'stale-catalog-version';
    const invalid = KnowledgeBundleStore.load(
      '/virtual/knowledge',
      injectedReader({
        ...files,
        'character-strategies.v2.json': JSON.stringify(mismatchedStrategies)
      })
    );
    await expect(invalid).rejects.toBeInstanceOf(KnowledgeBundleLoadError);
    await expect(invalid).rejects.toMatchObject({
      stage: 'validation',
      message: 'Trusted knowledge bundle validation failed'
    });
  });

  it('fails loading when evidence or strategy facts have been tampered with', async () => {
    const files = committedFiles();
    const evidence = JSON.parse(files['review-evidence.v1.json']);
    evidence.entries[0].paraphrasedEvidence[0].summary += '未经重新审核的改动';
    await expect(
      KnowledgeBundleStore.load(
        '/virtual/knowledge',
        injectedReader({ ...files, 'review-evidence.v1.json': JSON.stringify(evidence) })
      )
    ).rejects.toThrow();

    const strategies = JSON.parse(files['character-strategies.v2.json']);
    strategies.characters
      .flatMap(
        ({ archetypes }: { archetypes: Array<{ facts: Array<{ id: string }> }> }) => archetypes
      )
      .flatMap(({ facts }: { facts: Array<{ id: string; statement: string }> }) => facts)
      .find(({ id }: { id: string }) => id === 'raiden-hb-role').statement += '篡改';
    await expect(
      KnowledgeBundleStore.load(
        '/virtual/knowledge',
        injectedReader({ ...files, 'character-strategies.v2.json': JSON.stringify(strategies) })
      )
    ).rejects.toThrow();

    const mechanics = JSON.parse(files['enemy-mechanic-strategies.v1.json']);
    mechanics.mechanics[0].requiredCapabilities.push('unreviewed-capability');
    await expect(
      KnowledgeBundleStore.load(
        '/virtual/knowledge',
        injectedReader({
          ...files,
          'enemy-mechanic-strategies.v1.json': JSON.stringify(mechanics)
        })
      )
    ).rejects.toThrow();
  });

  it('fails loading when a schema-valid reviewed signal policy has been tampered with', async () => {
    const files = committedFiles();
    const strategies = JSON.parse(files['character-strategies.v2.json']);
    const raidenOnField = strategies.characters
      .find(({ id }: { id: string }) => id === '10000052')
      .archetypes.find(({ id }: { id: string }) => id === 'raiden-emblem-on-field');
    raidenOnField.signals.find(({ id }: { id: string }) => id === 'raiden-onfield-er').value = 131;

    await expect(
      KnowledgeBundleStore.load(
        '/virtual/knowledge',
        injectedReader({ ...files, 'character-strategies.v2.json': JSON.stringify(strategies) })
      )
    ).rejects.toThrow();
  });
});
