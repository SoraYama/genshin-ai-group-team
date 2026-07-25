import { describe, expect, it } from 'vitest';

import {
  buildUnknownKnowledgeContext,
  buildV2PipelineContext
} from '../../../src/main/services/v2-agent-context.js';
import { toAdvisorCharacter } from '../../../src/main/services/advisor-profile-serializer.js';
import { knowledgeContextPacketSchema } from '../../../src/shared/advisor-knowledge.js';
import { ABYSS_CHARACTERS, validAbyssPlan } from './abyss-test-fixtures.js';

function knowledgePacket(unknownCharacterIds: string[] = []) {
  return buildUnknownKnowledgeContext('knowledge-v1', unknownCharacterIds);
}

function profileFixture() {
  return {
    schemaVersion: 2 as const,
    uid: '123456789',
    source: 'merged' as const,
    fetchedAt: '2026-07-23T00:00:00.000Z',
    characters: ABYSS_CHARACTERS,
    coverage: {
      ownedCount: 10,
      detailedCount: 6,
      buildCount: 10,
      statsCount: 10,
      enkaShowcaseCount: 8,
      missingDetailCount: 4,
      partial: true
    }
  };
}

function interpretation(characterId: string, signalPrefix: string) {
  return {
    characterId,
    archetypeId: null,
    confidence: 'low' as const,
    candidateArchetypeIds: [],
    contextRequired: false,
    matchedSignals: Array.from(
      { length: 12 },
      (_, index) => `${signalPrefix}-${index}-${'s'.repeat(120)}`
    ),
    conflictingSignals: [],
    currentBuildUsable: false,
    adjustment: 'optional' as const,
    unknowns: []
  };
}

describe('V2 deterministic context builder', () => {
  it('joins the safe full profile, feasible baseline, mechanics, interventions, and knowledge gaps', () => {
    const profile = {
      schemaVersion: 2 as const,
      uid: '123456789',
      source: 'merged' as const,
      fetchedAt: '2026-07-23T00:00:00.000Z',
      characters: ABYSS_CHARACTERS,
      coverage: {
        ownedCount: 10,
        detailedCount: 6,
        buildCount: 10,
        statsCount: 10,
        enkaShowcaseCount: 8,
        missingDetailCount: 4,
        partial: true
      }
    };
    const baseline = validAbyssPlan();
    const context = buildV2PipelineContext({
      correlationId: 'context-test',
      profile,
      feasibleBaseline: baseline,
      eligibleCharacterIds: ABYSS_CHARACTERS.map(({ id }) => String(id)),
      mechanics: [{ target: '12-1 上半', facts: ['水元素护盾'], unknowns: ['精确破盾时长未知'] }],
      interventions: { lockedCharacterIds: ['1001'], noBuildChange: true },
      knowledge: knowledgePacket(['1009', '1010'])
    });

    expect(context.candidate).toMatchObject({
      kind: 'feasibleBaseline',
      feasibleBaseline: {
        mode: baseline.mode,
        firstHalfTeam: {
          characterIds: baseline.firstHalfTeam.characterIds
        }
      }
    });
    expect(context.profile.detailedProfiles[0]).toMatchObject({
      level: 90,
      stats: expect.objectContaining({ atk: 1200, energyRecharge: 110 }),
      completeness: 'detailed'
    });
    expect(context.profile.detailedProfiles[6]).toMatchObject({
      missingFields: ['weapon', 'artifacts', 'talents']
    });
    expect(context.knowledge.unknowns).toHaveLength(2);
    expect(context.knowledge.coverage).toEqual({
      requested: 2,
      trusted: 0,
      ephemeral: 0,
      unknown: 2
    });
    expect(JSON.stringify(context)).not.toMatch(
      /imageUrl|iconUrl|subStats|private\.example|cookie|apiKey|Authorization|https?:\/\//
    );
  });

  it('keeps a UID-scoped all-character index and prioritizes baseline details independent of storage order', () => {
    const fillers = Array.from({ length: 112 - ABYSS_CHARACTERS.length }, (_, index) => ({
      ...structuredClone(ABYSS_CHARACTERS[0]!),
      id: 20_000 + index,
      name: `填充角色-${index}`
    }));
    const characters = [...fillers, ...ABYSS_CHARACTERS];
    const profile = {
      schemaVersion: 2 as const,
      uid: '123456789',
      source: 'merged' as const,
      fetchedAt: '2026-07-23T00:00:00.000Z',
      characters,
      coverage: {
        ownedCount: 112,
        detailedCount: 112,
        buildCount: 112,
        statsCount: 112,
        enkaShowcaseCount: 8,
        missingDetailCount: 0,
        partial: false
      }
    };
    const build = (orderedCharacters: typeof characters) =>
      buildV2PipelineContext({
        correlationId: 'context-112',
        profile: { ...profile, characters: orderedCharacters },
        feasibleBaseline: validAbyssPlan(),
        eligibleCharacterIds: orderedCharacters.map(({ id }) => String(id)),
        mechanics: [{ target: '12-1 上半', facts: ['水元素护盾'], unknowns: ['精确破盾时长未知'] }],
        interventions: { lockedCharacterIds: ['1008'], noBuildChange: true },
        knowledge: knowledgePacket()
      });

    const first = build(characters);
    const reversed = build(characters.slice().reverse());
    const firstProfile = first.profile as unknown as {
      minimalIndex: Array<{ id: number }>;
      detailedProfiles: Array<{ id: number }>;
    };
    const reversedProfile = reversed.profile as unknown as typeof firstProfile;

    expect((first as unknown as { profileRef: { uid: string } }).profileRef.uid).toBe('123456789');
    expect(firstProfile.minimalIndex).toHaveLength(112);
    expect(firstProfile.detailedProfiles.map(({ id }) => id)).toEqual(
      expect.arrayContaining(validAbyssPlan().firstHalfTeam.characterIds.map(Number))
    );
    expect(firstProfile.detailedProfiles.map(({ id }) => id)).toContain(1008);
    expect(firstProfile.minimalIndex.map(({ id }) => id)).toEqual(
      reversedProfile.minimalIndex.map(({ id }) => id)
    );
    expect(firstProfile.detailedProfiles.map(({ id }) => id)).toEqual(
      reversedProfile.detailedProfiles.map(({ id }) => id)
    );
  });

  it('keeps high-ID baseline, locked, and selected characters ahead of the eligible remainder', () => {
    const lowIdFillers = Array.from({ length: 32 }, (_, index) => ({
      ...structuredClone(ABYSS_CHARACTERS[0]!),
      id: 1_001 + index,
      name: `低 ID 填充角色-${index}`
    }));
    const priorityIds = Array.from({ length: 10 }, (_, index) => 90_001 + index);
    const priorityCharacters = priorityIds.map((id, index) => ({
      ...structuredClone(ABYSS_CHARACTERS[index % ABYSS_CHARACTERS.length]!),
      id,
      name: `高 ID 优先角色-${index}`
    }));
    const characters = [...lowIdFillers, ...priorityCharacters];
    const baseline = structuredClone(validAbyssPlan());
    baseline.firstHalfTeam.characterIds = priorityIds.slice(0, 4).map(String);
    baseline.secondHalfTeam.characterIds = priorityIds.slice(4, 8).map(String);
    const context = buildV2PipelineContext({
      correlationId: 'context-high-priority',
      profile: {
        schemaVersion: 2,
        uid: '123456789',
        source: 'merged',
        fetchedAt: '2026-07-23T00:00:00.000Z',
        characters,
        coverage: {
          ownedCount: characters.length,
          detailedCount: characters.length,
          buildCount: characters.length,
          statsCount: characters.length,
          enkaShowcaseCount: 8,
          missingDetailCount: 0,
          partial: false
        }
      },
      feasibleBaseline: baseline,
      eligibleCharacterIds: characters.map(({ id }) => String(id)),
      mechanics: [{ target: '12-1 上半', facts: ['水元素护盾'], unknowns: [] }],
      interventions: {
        lockedCharacterIds: [String(priorityIds[8])],
        selectedCharacterIds: [String(priorityIds[9])],
        noBuildChange: true
      },
      knowledge: knowledgePacket()
    });
    const detailedIds = context.profile.detailedProfiles.map(({ id }) => id);

    expect(detailedIds).toHaveLength(24);
    expect(detailedIds.slice(0, 10)).toEqual(priorityIds);
    expect(detailedIds).toEqual(expect.arrayContaining(priorityIds));
  });

  it('fails closed when the complete serialized context exceeds 48 KiB', () => {
    const profile = {
      schemaVersion: 2 as const,
      uid: '123456789',
      source: 'merged' as const,
      fetchedAt: '2026-07-23T00:00:00.000Z',
      characters: ABYSS_CHARACTERS,
      coverage: {
        ownedCount: 10,
        detailedCount: 6,
        buildCount: 10,
        statsCount: 10,
        enkaShowcaseCount: 8,
        missingDetailCount: 4,
        partial: true
      }
    };

    expect(() =>
      buildV2PipelineContext({
        correlationId: 'context-over-budget',
        profile,
        feasibleBaseline: {
          ...validAbyssPlan(),
          warnings: ['W'.repeat(60_000)]
        },
        eligibleCharacterIds: ABYSS_CHARACTERS.map(({ id }) => String(id)),
        mechanics: [
          {
            target: '12-1 上半',
            facts: ['F'.repeat(60_000)],
            unknowns: ['U'.repeat(60_000)]
          }
        ],
        interventions: { lockedCharacterIds: [], noBuildChange: true },
        knowledge: knowledgePacket()
      })
    ).toThrow(expect.objectContaining({ name: 'V2ContextBudgetError' }));
  });

  it('trims unselected candidate interpretations before selected low-priority facts', () => {
    const baseline = validAbyssPlan();
    const selectedIds = [
      ...baseline.firstHalfTeam.characterIds,
      ...baseline.secondHalfTeam.characterIds
    ];
    const selectedFact = `selected-fact-${'f'.repeat(180)}`;
    const unselectedIds = Array.from({ length: 100 }, (_, index) => String(8_000_000 + index));
    const knowledge = knowledgeContextPacketSchema.parse({
      knowledgeVersion: 'budget-order',
      buildInterpretations: [
        ...selectedIds.map((id) => interpretation(id, `selected-${id}`)),
        ...unselectedIds.map((id) => interpretation(id, `unselected-${id}`))
      ],
      trustedMatches: [
        {
          id: 'trusted-selected',
          characterId: selectedIds[0],
          summary: 'Selected reviewed match.',
          factStatements: [selectedFact],
          citationIds: ['trusted-budget-citation']
        }
      ],
      ephemeralMatches: [],
      unknowns: [],
      coverage: { requested: 1, trusted: 1, ephemeral: 0, unknown: 0 },
      citations: [
        {
          id: 'trusted-budget-citation',
          sourceId: 'trusted-source',
          url: 'https://example.com/budget',
          title: 'Budget citation',
          reviewedAt: '2026-07-24T10:00:00+08:00',
          trust: 'trusted-local'
        }
      ]
    });

    const context = buildV2PipelineContext({
      correlationId: 'context-budget-candidates',
      profile: profileFixture(),
      feasibleBaseline: baseline,
      eligibleCharacterIds: ABYSS_CHARACTERS.map(({ id }) => String(id)),
      mechanics: [
        {
          target: '12-1 上半',
          facts: ['当前目标机制必须保留'],
          unknowns: ['当前目标未知也必须保留']
        }
      ],
      interventions: { noBuildChange: true },
      knowledge
    });

    expect(
      context.knowledge.buildInterpretations.map(({ characterId }) => characterId).sort()
    ).toEqual(selectedIds.sort());
    expect(context.knowledge.trustedMatches[0]?.factStatements).toEqual([selectedFact]);
    expect(context.mechanics).toEqual([
      {
        target: '12-1 上半',
        facts: ['当前目标机制必须保留'],
        unknowns: ['当前目标未知也必须保留']
      }
    ]);
    expect(context.knowledge.unknowns).toContainEqual(
      expect.objectContaining({ kind: 'payload-truncated' })
    );
    for (const provenance of context.profile.provenanceSummaries) {
      const { characterIndexes, ...actualProvenance } = provenance;
      for (const characterIndex of characterIndexes) {
        expect(characterIndex).toBeLessThan(context.profile.detailedProfiles.length);
        const retained = context.profile.detailedProfiles[characterIndex]!;
        const source = profileFixture().characters.find(({ id }) => id === retained.id)!;
        expect(actualProvenance).toEqual(toAdvisorCharacter(source).provenanceSummary);
      }
    }
  });

  it('drops only unselected character gaps when they would overflow the context budget', () => {
    const baseline = validAbyssPlan();
    const selectedIds = [
      ...baseline.firstHalfTeam.characterIds,
      ...baseline.secondHalfTeam.characterIds
    ];
    const selectedGaps = selectedIds.map((subjectId, index) => ({
      id: `gap-selected-${index}`,
      subjectId,
      kind: 'missing' as const,
      reason: 'Selected baseline knowledge is still unresolved.'
    }));
    const scenarioGap = {
      id: 'gap-current-scenario',
      subjectId: 'scenario:current-floor',
      kind: 'missing' as const,
      reason: 'Current scenario knowledge must remain explicit.'
    };
    const unselectedGaps = Array.from({ length: 120 }, (_, index) => ({
      id: `gap-unselected-${index}`,
      subjectId: String(8_300_000 + index),
      kind: 'missing' as const,
      reason: `Unselected character knowledge ${index}: ${'u'.repeat(400)}`
    }));
    const knowledge = knowledgeContextPacketSchema.parse({
      knowledgeVersion: 'budget-character-gaps',
      buildInterpretations: [],
      trustedMatches: [],
      ephemeralMatches: [],
      unknowns: [...selectedGaps, scenarioGap, ...unselectedGaps],
      coverage: {
        requested: selectedGaps.length + 1 + unselectedGaps.length,
        trusted: 0,
        ephemeral: 0,
        unknown: selectedGaps.length + 1 + unselectedGaps.length
      },
      citations: []
    });

    const context = buildV2PipelineContext({
      correlationId: 'context-budget-character-gaps',
      profile: profileFixture(),
      feasibleBaseline: baseline,
      eligibleCharacterIds: ABYSS_CHARACTERS.map(({ id }) => String(id)),
      mechanics: [{ target: '12-1 上半', facts: ['元素盾'], unknowns: [] }],
      interventions: { noBuildChange: true },
      knowledge
    });

    expect(context.knowledge.unknowns).toEqual(
      expect.arrayContaining([
        ...selectedGaps,
        scenarioGap,
        expect.objectContaining({ kind: 'payload-truncated' })
      ])
    );
    expect(
      context.knowledge.unknowns.some(({ subjectId }) =>
        unselectedGaps.some((gap) => gap.subjectId === subjectId)
      )
    ).toBe(false);
    expect(context.knowledge.coverage).toEqual({
      requested: selectedGaps.length + 2,
      trusted: 0,
      ephemeral: 0,
      unknown: selectedGaps.length + 2
    });
  });

  it('drops low-priority fact details only after candidates and preserves selected builds, citations, mechanics, and all gaps', () => {
    const baseline = validAbyssPlan();
    const selectedIds = [
      ...baseline.firstHalfTeam.characterIds,
      ...baseline.secondHalfTeam.characterIds
    ];
    const unselectedIds = Array.from({ length: 20 }, (_, index) => String(8_200_000 + index));
    const citation = {
      id: 'trusted-required-citation',
      sourceId: 'trusted-source',
      url: 'https://example.com/required',
      title: 'Required citation',
      reviewedAt: '2026-07-24T10:00:00+08:00',
      trust: 'trusted-local' as const
    };
    const knowledge = knowledgeContextPacketSchema.parse({
      knowledgeVersion: 'budget-facts',
      buildInterpretations: [
        ...selectedIds.map((id) => interpretation(id, `selected-${id}`)),
        ...unselectedIds.map((id) => interpretation(id, `unselected-${id}`))
      ],
      trustedMatches: selectedIds.map((characterId, index) => ({
        id: `trusted-selected-${index}`,
        characterId,
        summary: `Selected summary ${index}`,
        factStatements: Array.from(
          { length: 32 },
          (_, factIndex) => `fact-${index}-${factIndex}-${'f'.repeat(560)}`
        ),
        citationIds: [citation.id]
      })),
      ephemeralMatches: [],
      unknowns: [
        {
          id: 'gap-original',
          subjectId: 'scenario:original',
          kind: 'missing',
          reason: 'Original unknown must remain.'
        }
      ],
      coverage: { requested: 9, trusted: 8, ephemeral: 0, unknown: 1 },
      citations: [citation]
    });
    const mechanics = [
      {
        target: '12-1 上半',
        facts: ['元素盾'],
        unknowns: ['精确破盾时间未知']
      }
    ];

    const context = buildV2PipelineContext({
      correlationId: 'context-budget-facts',
      profile: profileFixture(),
      feasibleBaseline: baseline,
      eligibleCharacterIds: ABYSS_CHARACTERS.map(({ id }) => String(id)),
      mechanics,
      interventions: { noBuildChange: true },
      knowledge
    });

    expect(
      context.knowledge.buildInterpretations.map(({ characterId }) => characterId).sort()
    ).toEqual(selectedIds.sort());
    expect(
      context.knowledge.trustedMatches.every((match) => match.factStatements === undefined)
    ).toBe(true);
    expect(context.knowledge.citations).toEqual([citation]);
    expect(context.mechanics).toEqual(mechanics);
    expect(context.knowledge.unknowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'gap-original', kind: 'missing' }),
        expect.objectContaining({
          kind: 'payload-truncated',
          reason: expect.stringMatching(/entries.*fact details/i)
        })
      ])
    );
    expect(context.knowledge.coverage).toEqual({
      requested: 10,
      trusted: 8,
      ephemeral: 0,
      unknown: 2
    });
  });

  it('preserves 256 normal gaps and adds one marker after removing oversized unselected knowledge', () => {
    const baseline = validAbyssPlan();
    const originalUnknowns = Array.from({ length: 256 }, (_, index) => ({
      id: `gap-boundary-${index}`,
      subjectId: `scenario:boundary-${index}`,
      kind: 'missing' as const,
      reason: 'Unresolved.'
    }));
    const unselectedIds = Array.from({ length: 100 }, (_, index) => String(8_100_000 + index));
    const knowledge = knowledgeContextPacketSchema.parse({
      knowledgeVersion: 'boundary-compaction',
      buildInterpretations: unselectedIds.map((id) => interpretation(id, `unselected-${id}`)),
      trustedMatches: [],
      ephemeralMatches: [],
      unknowns: originalUnknowns,
      coverage: { requested: 256, trusted: 0, ephemeral: 0, unknown: 256 },
      citations: []
    });

    const context = buildV2PipelineContext({
      correlationId: 'context-boundary-gaps',
      profile: profileFixture(),
      feasibleBaseline: baseline,
      eligibleCharacterIds: ABYSS_CHARACTERS.map(({ id }) => String(id)),
      mechanics: [{ target: '12-1 上半', facts: ['元素盾'], unknowns: [] }],
      interventions: { noBuildChange: true },
      knowledge
    });

    expect(context.knowledge.buildInterpretations).toEqual([]);
    expect(context.knowledge.unknowns).toHaveLength(257);
    expect(context.knowledge.unknowns.slice(0, 256)).toEqual(originalUnknowns);
    expect(context.knowledge.unknowns.at(-1)).toMatchObject({
      kind: 'payload-truncated',
      reason: expect.stringContaining('Knowledge')
    });
    expect(context.knowledge.coverage).toEqual({
      requested: 257,
      trusted: 0,
      ephemeral: 0,
      unknown: 257
    });
  });

  it('preserves 512 business entries plus one marker when fact compaction fits the budget', () => {
    const citation = {
      id: 'c',
      sourceId: 's',
      url: 'https://e.co/x',
      title: 't',
      reviewedAt: '2026-07-24T10:00:00+08:00',
      trust: 'trusted-local' as const
    };
    const trustedMatches = Array.from({ length: 256 }, (_, index) => ({
      id: `t${index}`,
      mechanicId: `m${index}`,
      summary: 's',
      factStatements: [`fact-${index}-${'f'.repeat(180)}`],
      citationIds: [citation.id]
    }));
    const normalGaps = Array.from({ length: 256 }, (_, index) => ({
      id: `g${index}`,
      subjectId: `u${index}`,
      kind: 'missing' as const,
      reason: 'u'
    }));
    const knowledge = knowledgeContextPacketSchema.parse({
      knowledgeVersion: 'v',
      buildInterpretations: [],
      trustedMatches,
      ephemeralMatches: [],
      unknowns: normalGaps,
      coverage: { requested: 512, trusted: 256, ephemeral: 0, unknown: 256 },
      citations: [citation]
    });
    const originalKnowledge = structuredClone(knowledge);

    const context = buildV2PipelineContext({
      correlationId: 'context-business-boundary',
      profile: profileFixture(),
      feasibleBaseline: validAbyssPlan(),
      eligibleCharacterIds: ABYSS_CHARACTERS.map(({ id }) => String(id)),
      mechanics: [{ target: '12-1 上半', facts: ['元素盾'], unknowns: [] }],
      interventions: { noBuildChange: true },
      knowledge
    });

    expect(context.knowledge.trustedMatches).toHaveLength(256);
    expect(
      context.knowledge.trustedMatches.every((match) => match.factStatements === undefined)
    ).toBe(true);
    expect(context.knowledge.unknowns.slice(0, 256)).toEqual(normalGaps);
    expect(
      context.knowledge.unknowns.filter(({ kind }) => kind === 'payload-truncated')
    ).toHaveLength(1);
    expect(context.knowledge.coverage).toEqual({
      requested: 513,
      trusted: 256,
      ephemeral: 0,
      unknown: 257
    });
    expect(knowledge).toEqual(originalKnowledge);
  });

  it('does not claim knowledge truncation when profile detail compaction alone fits the budget', () => {
    const characters = Array.from({ length: 24 }, (_, index) => {
      const source = structuredClone(ABYSS_CHARACTERS[index % ABYSS_CHARACTERS.length]!);
      source.id = index < ABYSS_CHARACTERS.length ? source.id : 30_000 + index;
      source.name = `${'角'.repeat(70)}-${index}`;
      if (source.build?.weapon) source.build.weapon.name = '武'.repeat(100);
      if (source.build?.artifacts) {
        source.build.artifacts = source.build.artifacts.map((artifact, artifactIndex) => ({
          ...artifact,
          setName: `${'套'.repeat(100)}-${artifactIndex}`
        }));
      }
      return source;
    });
    const profile = {
      ...profileFixture(),
      characters,
      coverage: {
        ownedCount: 24,
        detailedCount: 24,
        buildCount: 24,
        statsCount: 24,
        enkaShowcaseCount: 8,
        missingDetailCount: 0,
        partial: false
      }
    };

    const context = buildV2PipelineContext({
      correlationId: 'profile-only-compaction',
      profile,
      feasibleBaseline: validAbyssPlan(),
      eligibleCharacterIds: characters.map(({ id }) => String(id)),
      mechanics: [
        {
          target: '12-1 上半',
          facts: Array.from({ length: 16 }, () => '机'.repeat(240)),
          unknowns: []
        },
        {
          target: '12-1 下半',
          facts: Array.from({ length: 16 }, () => '制'.repeat(240)),
          unknowns: []
        },
        {
          target: '12-2 上半',
          facts: Array.from({ length: 16 }, () => '压'.repeat(240)),
          unknowns: []
        }
      ],
      interventions: { noBuildChange: true },
      knowledge: knowledgePacket()
    });

    expect(context.profile.detailedProfiles).toHaveLength(8);
    expect(context.knowledge.unknowns).toEqual([]);
  });
});
