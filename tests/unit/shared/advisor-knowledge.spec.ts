import { describe, expect, it } from 'vitest';

import {
  canonicalCharacterIdSchema,
  characterStrategyBundleSchema,
  enemyMechanicStrategyBundleSchema,
  knowledgeContextPacketSchema,
  signalPredicateSchema,
  sourceCitationSchema,
  sourceRegistryEntrySchema,
  sourceRegistrySchema
} from '../../../src/shared/advisor-knowledge.js';

const reviewedAt = '2026-07-24T10:00:00+08:00';

function sourceRegistry() {
  return {
    sources: [
      {
        id: 'local-review',
        name: '本地审核资料',
        hosts: ['example.com'],
        trust: 'trusted-local' as const
      }
    ],
    citations: [
      {
        id: 'citation-raiden',
        sourceId: 'local-review',
        url: 'https://example.com/characters/raiden',
        title: '雷电将军配装审核记录',
        reviewedAt,
        trust: 'trusted-local' as const
      }
    ]
  };
}

function characterStrategyBundle() {
  return {
    schemaVersion: 1 as const,
    knowledgeVersion: '2026.07.reviewed-1',
    trust: 'trusted-local' as const,
    sourceRegistry: sourceRegistry(),
    characters: [
      {
        id: '10000052',
        name: '雷电将军',
        archetypes: [
          {
            id: 'raiden-on-field',
            name: '站场充能核心',
            signals: [
              {
                id: 'raiden-er',
                field: 'energyRecharge',
                operator: 'gte',
                value: 200,
                description: '充能效率达到站场循环阈值'
              }
            ],
            facts: [
              {
                id: 'raiden-energy-loop',
                statement: '元素爆发期间可协助全队恢复元素能量。',
                citationIds: ['citation-raiden']
              }
            ]
          }
        ]
      }
    ]
  };
}

describe('advisor knowledge contracts', () => {
  it('returns validation failures instead of throwing for malformed URLs', () => {
    const malformedUrl = 'https://[';
    const homepageAttempt = () =>
      sourceRegistryEntrySchema.safeParse({
        id: 'malformed-homepage',
        name: 'Malformed homepage',
        hosts: ['example.com'],
        trust: 'trusted-local',
        homepageUrl: malformedUrl
      });
    const citationAttempt = () =>
      sourceCitationSchema.safeParse({
        ...sourceRegistry().citations[0],
        url: malformedUrl
      });
    const registry = sourceRegistry();
    registry.citations[0]!.url = malformedUrl;
    const registryAttempt = () => sourceRegistrySchema.safeParse(registry);

    expect(homepageAttempt).not.toThrow();
    expect(citationAttempt).not.toThrow();
    expect(registryAttempt).not.toThrow();
    expect(homepageAttempt().success).toBe(false);
    expect(citationAttempt().success).toBe(false);
    expect(registryAttempt().success).toBe(false);
  });

  it('bounds canonical character IDs', () => {
    expect(canonicalCharacterIdSchema.safeParse('9'.repeat(20)).success).toBe(true);
    expect(canonicalCharacterIdSchema.safeParse('9'.repeat(21)).success).toBe(false);
    expect(canonicalCharacterIdSchema.safeParse('9'.repeat(100_000)).success).toBe(false);
  });

  it('bounds reviewed-at ISO datetimes', () => {
    const citation = sourceRegistry().citations[0]!;
    const oversizedDatetime = `2026-07-24T10:00:00.${'1'.repeat(100_000)}+08:00`;

    expect(
      sourceCitationSchema.safeParse({ ...citation, reviewedAt: oversizedDatetime }).success
    ).toBe(false);
  });

  it('rejects character strategy facts whose citation IDs do not resolve', () => {
    const bundle = characterStrategyBundle();
    bundle.characters[0]!.archetypes[0]!.facts[0]!.citationIds = ['missing-citation'];

    const result = characterStrategyBundleSchema.safeParse(bundle);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['characters', 0, 'archetypes', 0, 'facts', 0, 'citationIds', 0]
        })
      ])
    );
  });

  it('keeps trusted and ephemeral coverage separate and internally consistent', () => {
    const packet = knowledgeContextPacketSchema.parse({
      knowledgeVersion: '2026.07.reviewed-1',
      buildInterpretations: [
        {
          characterId: '10000052',
          archetypeId: 'raiden-on-field',
          confidence: 'high',
          matchedSignals: ['充能效率 220%'],
          conflictingSignals: [],
          currentBuildUsable: true,
          adjustment: 'none',
          unknowns: []
        }
      ],
      trustedMatches: [
        {
          id: 'trusted-raiden',
          characterId: '10000052',
          archetypeId: 'raiden-on-field',
          summary: '本地审核知识已覆盖该配装方向。',
          citationIds: ['citation-raiden']
        }
      ],
      ephemeralMatches: [
        {
          id: 'guide-enemy',
          subjectId: 'enemy:abyss-shield',
          summary: '临时检索到当期护盾提示。',
          citationIds: ['citation-guide']
        }
      ],
      unknowns: [
        {
          id: 'gap-rotation',
          subjectId: '10000089',
          reason: '本地知识与临时资料均未覆盖当前配装。'
        }
      ],
      coverage: { requested: 3, trusted: 1, ephemeral: 1, unknown: 1 },
      citations: [
        sourceRegistry().citations[0],
        {
          id: 'citation-guide',
          sourceId: 'web-guide',
          url: 'https://guide.example.org/current-abyss',
          title: '当期深渊临时攻略',
          reviewedAt,
          trust: 'ephemeral-web'
        }
      ]
    });

    expect(packet.coverage).toEqual({
      requested: 3,
      trusted: 1,
      ephemeral: 1,
      unknown: 1
    });
    expect(
      knowledgeContextPacketSchema.safeParse({
        ...packet,
        coverage: { requested: 3, trusted: 2, ephemeral: 1, unknown: 1 }
      }).success
    ).toBe(false);
  });

  it('requires source registry URL hosts to match declared hosts', () => {
    const registry = sourceRegistry();
    registry.citations[0]!.url = 'https://unreviewed.example.net/characters/raiden';

    const result = sourceRegistrySchema.safeParse(registry);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['citations', 0, 'url']);
  });

  it('requires unique character, archetype, mechanic, and citation IDs', () => {
    const duplicateCharacters = characterStrategyBundle();
    duplicateCharacters.characters.push(structuredClone(duplicateCharacters.characters[0]!));
    expect(characterStrategyBundleSchema.safeParse(duplicateCharacters).success).toBe(false);

    const duplicateArchetypes = characterStrategyBundle();
    duplicateArchetypes.characters[0]!.archetypes.push(
      structuredClone(duplicateArchetypes.characters[0]!.archetypes[0]!)
    );
    const duplicateArchetypeResult = characterStrategyBundleSchema.safeParse(duplicateArchetypes);
    expect(duplicateArchetypeResult.success).toBe(false);
    expect(duplicateArchetypeResult.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['characters', 0, 'archetypes', 1, 'id']
        })
      ])
    );

    const duplicateCitations = characterStrategyBundle();
    duplicateCitations.sourceRegistry.citations.push(
      structuredClone(duplicateCitations.sourceRegistry.citations[0]!)
    );
    expect(characterStrategyBundleSchema.safeParse(duplicateCitations).success).toBe(false);

    const mechanic = {
      schemaVersion: 1 as const,
      knowledgeVersion: '2026.07.reviewed-1',
      trust: 'trusted-local' as const,
      sourceRegistry: sourceRegistry(),
      mechanics: [
        {
          id: 'abyss-elemental-shield',
          name: '元素护盾',
          matchTags: ['elemental-shield'],
          facts: [
            {
              id: 'shield-counter',
              statement: '应按护盾元素选择破盾手段。',
              citationIds: ['citation-raiden']
            }
          ]
        }
      ]
    };
    mechanic.mechanics.push(structuredClone(mechanic.mechanics[0]!));
    expect(enemyMechanicStrategyBundleSchema.safeParse(mechanic).success).toBe(false);
  });

  it('requires facts and trusted citations', () => {
    const characterBundle = characterStrategyBundle();
    characterBundle.characters[0]!.archetypes[0]!.facts = [];
    expect(characterStrategyBundleSchema.safeParse(characterBundle).success).toBe(false);

    const mechanicBundle = {
      schemaVersion: 1 as const,
      knowledgeVersion: '2026.07.reviewed-1',
      trust: 'trusted-local' as const,
      sourceRegistry: sourceRegistry(),
      mechanics: [
        {
          id: 'abyss-elemental-shield',
          name: '元素护盾',
          matchTags: ['elemental-shield'],
          facts: []
        }
      ]
    };
    expect(enemyMechanicStrategyBundleSchema.safeParse(mechanicBundle).success).toBe(false);

    expect(
      knowledgeContextPacketSchema.safeParse({
        knowledgeVersion: '2026.07.reviewed-1',
        buildInterpretations: [],
        trustedMatches: [
          {
            id: 'trusted-without-citation',
            characterId: '10000052',
            summary: 'This must be cited.',
            citationIds: []
          }
        ],
        ephemeralMatches: [],
        unknowns: [],
        coverage: { requested: 1, trusted: 1, ephemeral: 0, unknown: 0 },
        citations: []
      }).success
    ).toBe(false);
  });

  it('rejects impossible signal field, operator, and value combinations', () => {
    const common = { id: 'signal', description: 'Invalid signal' };

    expect(
      signalPredicateSchema.safeParse({
        ...common,
        field: 'weapon',
        operator: 'gte',
        value: 100
      }).success
    ).toBe(false);
    expect(
      signalPredicateSchema.safeParse({
        ...common,
        field: 'hp',
        operator: 'includes',
        value: 'foo'
      }).success
    ).toBe(false);
  });

  it('reports duplicate knowledge IDs at real nested paths', () => {
    const trustedCitation = sourceRegistry().citations[0]!;
    const duplicateTrusted = {
      knowledgeVersion: '2026.07.reviewed-1',
      buildInterpretations: [],
      trustedMatches: [
        {
          id: 'duplicate-id',
          characterId: '10000052',
          summary: 'First match.',
          citationIds: [trustedCitation.id]
        },
        {
          id: 'duplicate-id',
          characterId: '10000089',
          summary: 'Second match.',
          citationIds: [trustedCitation.id]
        }
      ],
      ephemeralMatches: [],
      unknowns: [],
      coverage: { requested: 2, trusted: 2, ephemeral: 0, unknown: 0 },
      citations: [trustedCitation]
    };
    const trustedResult = knowledgeContextPacketSchema.safeParse(duplicateTrusted);
    expect(trustedResult.success).toBe(false);
    expect(trustedResult.error?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['trustedMatches', 1, 'id'] })])
    );

    const crossArrayDuplicate = {
      ...duplicateTrusted,
      trustedMatches: duplicateTrusted.trustedMatches.slice(0, 1),
      ephemeralMatches: [
        {
          id: 'duplicate-id',
          subjectId: '10000089',
          summary: 'Ephemeral match.',
          citationIds: ['ephemeral-citation']
        }
      ],
      coverage: { requested: 2, trusted: 1, ephemeral: 1, unknown: 0 },
      citations: [
        trustedCitation,
        {
          id: 'ephemeral-citation',
          sourceId: 'ephemeral-source',
          url: 'https://guide.example.org/character',
          title: 'Ephemeral guide',
          reviewedAt,
          trust: 'ephemeral-web' as const
        }
      ]
    };
    const crossArrayResult = knowledgeContextPacketSchema.safeParse(crossArrayDuplicate);
    expect(crossArrayResult.success).toBe(false);
    expect(crossArrayResult.error?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['ephemeralMatches', 0, 'id'] })])
    );
  });

  it('rejects ephemeral citations in trusted local strategy bundles', () => {
    const original = characterStrategyBundle();
    const bundle = {
      ...original,
      sourceRegistry: {
        sources: original.sourceRegistry.sources.map((source) => ({
          ...source,
          trust: 'ephemeral-web' as const
        })),
        citations: original.sourceRegistry.citations.map((citation) => ({
          ...citation,
          trust: 'ephemeral-web' as const
        }))
      }
    };

    expect(characterStrategyBundleSchema.safeParse(bundle).success).toBe(false);
  });
});
