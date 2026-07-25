import { describe, expect, it, vi } from 'vitest';

import {
  ABYSS_MCP_TOOL_NAMES,
  createAbyssBusinessTools
} from '../../../src/main/services/abyss-business-tools.js';
import type { KnowledgeContextPacket } from '../../../src/shared/advisor-knowledge.js';
import { ABYSS_CHARACTERS, abyssScenario } from './abyss-test-fixtures.js';

function textPayload(
  result: Awaited<ReturnType<ReturnType<typeof createAbyssBusinessTools>[number]['handler']>>
) {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('Expected text result');
  return JSON.parse(first.text) as unknown;
}

describe('abyss in-process business tools', () => {
  const packet: KnowledgeContextPacket = {
    knowledgeVersion: 'packet-v1',
    buildInterpretations: ['1001', '1002'].map((characterId, index) => ({
      characterId,
      archetypeId: `role-${index + 1}`,
      confidence: 'high',
      candidateArchetypeIds: [`role-${index + 1}`],
      contextRequired: false,
      matchedSignals: ['build-match'],
      conflictingSignals: [],
      currentBuildUsable: true,
      adjustment: 'none',
      unknowns: []
    })),
    trustedMatches: [
      ...['1001', '1002'].map((characterId, index) => ({
        id: `match-${characterId}`,
        characterId,
        archetypeId: `role-${index + 1}`,
        summary: `strategy-${characterId}`,
        citationIds: [`citation-${characterId}`]
      })),
      {
        id: 'match-shield-breaking',
        mechanicId: 'shield-breaking',
        summary: 'Use counter-element application against the selected shield.',
        citationIds: ['citation-shield-breaking']
      }
    ],
    ephemeralMatches: [],
    unknowns: [
      {
        id: 'gap-scenario-unknown',
        subjectId: 'scenario:unknown-window',
        kind: 'missing',
        reason: 'The exact damage window is not reviewed.'
      }
    ],
    coverage: { requested: 4, trusted: 3, ephemeral: 0, unknown: 1 },
    citations: [
      ...['1001', '1002'].map((characterId) => ({
        id: `citation-${characterId}`,
        sourceId: 'reviewed-source',
        url: `https://example.test/${characterId}`,
        title: `citation-${characterId}`,
        reviewedAt: '2026-07-24T00:00:00.000Z',
        trust: 'trusted-local' as const
      })),
      {
        id: 'citation-shield-breaking',
        sourceId: 'reviewed-source',
        url: 'https://example.test/shield-breaking',
        title: 'citation-shield-breaking',
        reviewedAt: '2026-07-24T00:00:00.000Z',
        trust: 'trusted-local'
      }
    ]
  };

  it('exposes only the three bounded read-only tool names', () => {
    const tools = createAbyssBusinessTools({
      getProfile: () => null,
      getScenario: () => abyssScenario()
    });
    expect(tools.map(({ name }) => name)).toEqual([
      'read_profile_cache',
      'query_enemy_data',
      'query_team_knowledge'
    ]);
    expect(ABYSS_MCP_TOOL_NAMES).toEqual([
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_enemy_data',
      'mcp__genshin__query_team_knowledge'
    ]);
    expect(tools.every(({ annotations }) => annotations?.readOnlyHint === true)).toBe(true);
  });

  it('returns the complete bounded advisor profile DTO without raw media or build internals', async () => {
    const detailedCharacter = {
      ...ABYSS_CHARACTERS[0]!,
      constellation: 2,
      build: {
        ...ABYSS_CHARACTERS[0]!.build,
        weapon: {
          id: 123,
          name: '测试武器',
          iconUrl: 'https://private.example/weapon.png',
          level: 90,
          refinement: 2,
          rarity: 5
        },
        artifacts: [
          {
            slot: 'goblet' as const,
            setId: 1,
            setName: '测试套装',
            level: 20,
            rarity: 5,
            mainStat: { key: 'pyroDmg', value: 46.6 },
            subStats: [{ key: 'critRate', value: 10 }],
            iconUrl: 'https://private.example/artifact.png'
          }
        ],
        talents: { normalAttack: 6, elementalSkill: 9, elementalBurst: 10 }
      },
      provenance: {
        ...ABYSS_CHARACTERS[0]!.provenance,
        build: { source: 'miyoushe-detail' as const, fetchedAt: '2026-07-23T00:00:00.000Z' }
      }
    };
    const tools = createAbyssBusinessTools({
      getProfile: () => ({
        schemaVersion: 2,
        uid: '123456789',
        source: 'merged',
        fetchedAt: '2026-07-23T00:00:00.000Z',
        characters: [detailedCharacter, ...ABYSS_CHARACTERS, ...ABYSS_CHARACTERS],
        coverage: {
          ownedCount: 20,
          detailedCount: 12,
          buildCount: 20,
          statsCount: 20,
          enkaShowcaseCount: 20,
          missingDetailCount: 8,
          partial: true
        }
      }),
      getScenario: () => abyssScenario(),
      maxCharacters: 8
    });
    const result = await tools[0]!.handler(
      {
        uid: '123456789',
        characterIds: ['1001', '1002', '1003', '1004'],
        cursor: undefined,
        pageSize: undefined
      },
      {}
    );
    const payload = textPayload(result) as {
      kind: string;
      coverage: { partial: boolean };
      provenanceSummaries: Array<Record<string, unknown>>;
      characters: Array<Record<string, unknown>>;
    };
    expect(payload.kind).toBe('details');
    expect(payload.characters).toHaveLength(4);
    expect(payload.coverage.partial).toBe(true);
    expect(payload.characters[0]).toMatchObject({
      level: expect.any(Number),
      constellation: expect.any(Number),
      completeness: expect.any(String),
      weapon: { name: '测试武器', level: 90 },
      artifactSummary: {
        sets: [{ name: '测试套装', count: 1 }],
        mainStats: { goblet: 'pyroDmg' }
      },
      talents: { normal: 6, skill: 9, burst: 10 },
      stats: expect.any(Object)
    });
    expect(payload.provenanceSummaries[0]).toMatchObject({
      ownership: 'miyoushe-list',
      characterIndexes: expect.any(Array)
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /imageUrl|iconUrl|subStats|private\.example|fetchedAt/
    );
  });

  it('pages all 112 safe index rows and can explicitly retrieve a character stored last', async () => {
    const characters = Array.from({ length: 112 }, (_, index) => ({
      ...structuredClone(ABYSS_CHARACTERS[0]!),
      id: 30_000 + index,
      name: `角色-${index}`
    }));
    const tools = createAbyssBusinessTools({
      getProfile: () => ({
        schemaVersion: 2,
        uid: '123456789',
        source: 'merged',
        fetchedAt: '2026-07-23T00:00:00.000Z',
        characters: characters.slice().reverse(),
        coverage: {
          ownedCount: 112,
          detailedCount: 112,
          buildCount: 112,
          statsCount: 112,
          enkaShowcaseCount: 8,
          missingDetailCount: 0,
          partial: false
        }
      }),
      getScenario: () => abyssScenario()
    });

    const firstPage = textPayload(
      await tools[0]!.handler(
        { uid: '123456789', characterIds: undefined, cursor: 0, pageSize: 100 },
        {}
      )
    ) as {
      kind: string;
      total: number;
      nextCursor?: number;
      characters: Array<{ id: number }>;
    };
    const secondPage = textPayload(
      await tools[0]!.handler(
        {
          uid: '123456789',
          characterIds: undefined,
          cursor: firstPage.nextCursor,
          pageSize: 100
        },
        {}
      )
    ) as typeof firstPage;
    const details = textPayload(
      await tools[0]!.handler(
        {
          uid: '123456789',
          characterIds: ['30111'],
          cursor: undefined,
          pageSize: undefined
        },
        {}
      )
    ) as {
      kind: string;
      characters: Array<{ id: number; name: string }>;
      missingCharacterIds: string[];
    };

    expect(firstPage).toMatchObject({ kind: 'index-page', total: 112, nextCursor: 100 });
    expect([...firstPage.characters, ...secondPage.characters]).toHaveLength(112);
    expect(details).toMatchObject({
      kind: 'details',
      characters: [{ id: 30111, name: '角色-111' }],
      missingCharacterIds: []
    });
  });

  it('fails closed instead of returning a profile tool payload above 48 KiB', async () => {
    const tools = createAbyssBusinessTools({
      getProfile: () => ({
        schemaVersion: 2,
        uid: '123456789',
        source: 'merged',
        fetchedAt: '2026-07-23T00:00:00.000Z',
        characters: [
          {
            ...structuredClone(ABYSS_CHARACTERS[0]!),
            name: 'X'.repeat(60_000)
          }
        ],
        coverage: {
          ownedCount: 1,
          detailedCount: 1,
          buildCount: 1,
          statsCount: 1,
          enkaShowcaseCount: 1,
          missingDetailCount: 0,
          partial: false
        }
      }),
      getScenario: () => abyssScenario()
    });

    const result = await tools[0]!.handler(
      {
        uid: '123456789',
        characterIds: ['1001'],
        cursor: undefined,
        pageSize: undefined
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(textPayload(result)).toMatchObject({
      error: {
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        scope: 'profile-tool-result',
        maxBytes: 48 * 1024,
        actualBytes: expect.any(Number)
      }
    });
  });

  it('fails closed with a typed error for an oversized enemy payload', async () => {
    const scenario = abyssScenario();
    scenario.blessing.description = '界'.repeat(17_000);
    const tools = createAbyssBusinessTools({
      getProfile: () => null,
      getScenario: () => scenario
    });

    const result = await tools[1]!.handler(
      {
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        floor: 12,
        chamber: 1
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(textPayload(result)).toMatchObject({
      error: {
        code: 'AGENT_PAYLOAD_TOO_LARGE',
        scope: 'business-tool-result'
      }
    });
  });

  it('rejects scenario identity drift and returns only the selected localized enemy fields', async () => {
    const scenario = abyssScenario();
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.tags.push(
      'development-sample',
      'requires-capability:bow'
    );
    scenario.floors[0]!.chambers[0]!.firstHalf.waves[0]!.enemies[0]!.mechanics.immunities = [
      'hydro',
      'internal-immunity'
    ];
    const tools = createAbyssBusinessTools({
      getProfile: () => null,
      getScenario: () => scenario
    });
    const enemyTool = tools[1]!;
    const mismatch = await enemyTool.handler(
      { scenarioId: 'wrong', dataVersion: '2026.07.1', floor: 12, chamber: 1 },
      {}
    );
    expect(mismatch.isError).toBe(true);

    const result = await enemyTool.handler(
      {
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1',
        floor: 12,
        chamber: 1
      },
      {}
    );
    const payload = textPayload(result) as { firstHalf: unknown; secondHalf: unknown };
    expect(JSON.stringify(payload)).toContain('训练水兽');
    expect(JSON.stringify(payload)).toContain('水元素护盾');
    expect(payload).toMatchObject({
      firstHalf: [
        {
          enemies: [
            {
              mechanics: {
                requiredCapabilities: [{ contractVersion: 1, value: 'bow', known: true }]
              }
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /Training Hydra|training-hydra|12-1-first-wave-1|development-sample|internal-immunity|"hydro"/
    );
  });

  it('returns only the scoped prebuilt knowledge packet subset and exact citation ids', async () => {
    const log = vi.fn();
    const tools = createAbyssBusinessTools({
      getProfile: () => null,
      getScenario: () => abyssScenario(),
      knowledgePacket: packet,
      knowledgeScope: {
        floor: 12,
        chambers: [1, 2],
        eligibleCharacterIds: ['1001', '1002']
      },
      knowledgeTargetScopes: {
        '12:1:first': {
          trustedMatchIds: ['match-shield-breaking'],
          ephemeralMatchIds: [],
          unknownIds: ['gap-scenario-unknown']
        }
      },
      auditContext: {
        correlationId: 'audit-request-1',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1'
      },
      log
    });
    const result = await tools[2]!.handler(
      { characterIds: ['1001'], floor: 12, chamber: 1, half: 'first' },
      {}
    );
    const payload = textPayload(result) as {
      knowledgeVersion: string;
      target: Record<string, unknown>;
      buildInterpretations: Array<Record<string, unknown>>;
      characterStrategies: Array<Record<string, unknown>>;
      mechanicStrategies: Array<Record<string, unknown>>;
      unknown: Array<Record<string, unknown>>;
      citationIds: string[];
    };
    expect(payload).toMatchObject({
      knowledgeVersion: 'packet-v1',
      target: { floor: 12, chamber: 1, half: 'first' },
      buildInterpretations: [{ characterId: '1001', archetypeId: 'role-1' }],
      characterStrategies: [
        { characterId: '1001', citationIds: ['citation-1001'] }
      ],
      mechanicStrategies: [
        {
          mechanicId: 'shield-breaking',
          citationIds: ['citation-shield-breaking']
        }
      ],
      unknown: [{ subjectId: 'scenario:unknown-window', kind: 'missing' }],
      citationIds: ['citation-1001', 'citation-shield-breaking']
    });
    expect(structuredClone(payload)).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain('1002');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'query_team_knowledge',
        itemCount: 1,
        ok: true,
        correlationId: 'audit-request-1',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1',
        knowledgeVersion: 'packet-v1',
        parameterSummary: expect.objectContaining({
          requestedCount: 1,
          floor: 12,
          chamber: 1,
          half: 'first',
          returnedCitationIds: 'citation-1001,citation-shield-breaking'
        }),
        issueCodes: []
      })
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/123456789|api.?key|authorization/i);
  });

  it('keeps mechanic, scenario, ephemeral, unknown, and citations isolated to the exact target key', async () => {
    const scopedPacket = structuredClone(packet);
    scopedPacket.trustedMatches.push({
      id: 'match-wave-efficient',
      mechanicId: 'wave-efficient-rotation',
      summary: 'Use short rotations in multi-wave content.',
      citationIds: ['citation-wave-efficient']
    });
    scopedPacket.ephemeralMatches.push(
      {
        id: 'ephemeral-first-bound',
        subjectId: 'mechanic:shield-breaking',
        summary: 'First-half runtime evidence.',
        citationIds: ['citation-first-ephemeral']
      },
      {
        id: 'ephemeral-unbound',
        subjectId: 'scenario:unbound',
        summary: 'This must never leak into a target result.',
        citationIds: ['citation-unbound']
      }
    );
    scopedPacket.unknowns.push({
      id: 'gap-second-scenario',
      subjectId: 'scenario:second-only',
      kind: 'missing',
      reason: 'Second-half scenario knowledge is missing.'
    });
    scopedPacket.citations.push(
      {
        id: 'citation-wave-efficient',
        sourceId: 'reviewed-source',
        url: 'https://example.test/wave-efficient',
        title: 'citation-wave-efficient',
        reviewedAt: '2026-07-24T00:00:00.000Z',
        trust: 'trusted-local'
      },
      {
        id: 'citation-first-ephemeral',
        sourceId: 'reviewed-source',
        url: 'https://example.test/first-ephemeral',
        title: 'citation-first-ephemeral',
        reviewedAt: '2026-07-24T00:00:00.000Z',
        trust: 'ephemeral-web'
      },
      {
        id: 'citation-unbound',
        sourceId: 'reviewed-source',
        url: 'https://example.test/unbound',
        title: 'citation-unbound',
        reviewedAt: '2026-07-24T00:00:00.000Z',
        trust: 'ephemeral-web'
      }
    );
    scopedPacket.coverage = {
      requested:
        scopedPacket.trustedMatches.length +
        scopedPacket.ephemeralMatches.length +
        scopedPacket.unknowns.length,
      trusted: scopedPacket.trustedMatches.length,
      ephemeral: scopedPacket.ephemeralMatches.length,
      unknown: scopedPacket.unknowns.length
    };
    const tools = createAbyssBusinessTools({
      getProfile: () => null,
      getScenario: () => abyssScenario(),
      knowledgePacket: scopedPacket,
      knowledgeScope: {
        floor: 12,
        chambers: [1],
        eligibleCharacterIds: ['1001', '1002']
      },
      knowledgeTargetScopes: {
        '12:1:first': {
          trustedMatchIds: ['match-shield-breaking'],
          ephemeralMatchIds: ['ephemeral-first-bound'],
          unknownIds: ['gap-scenario-unknown']
        },
        '12:1:second': {
          trustedMatchIds: ['match-wave-efficient'],
          ephemeralMatchIds: [],
          unknownIds: ['gap-second-scenario']
        }
      }
    });

    const first = textPayload(
      await tools[2]!.handler(
        { characterIds: ['1001'], floor: 12, chamber: 1, half: 'first' },
        {}
      )
    );
    const second = textPayload(
      await tools[2]!.handler(
        { characterIds: ['1002'], floor: 12, chamber: 1, half: 'second' },
        {}
      )
    );
    const firstPayload = first as {
      mechanicStrategies: Array<{ id: string }>;
      ephemeralCharacterStrategies: Array<{ id: string }>;
      ephemeralMechanicStrategies: Array<{ id: string }>;
      ephemeralScenarioStrategies: Array<{ id: string }>;
      unknown: Array<{ id: string }>;
      citationIds: string[];
    };
    const secondPayload = second as typeof firstPayload;
    expect(firstPayload.mechanicStrategies.map(({ id }) => id)).toEqual([
      'match-shield-breaking'
    ]);
    expect(firstPayload.ephemeralCharacterStrategies).toEqual([]);
    expect(firstPayload.ephemeralMechanicStrategies.map(({ id }) => id)).toEqual([
      'ephemeral-first-bound'
    ]);
    expect(firstPayload.ephemeralScenarioStrategies).toEqual([]);
    expect(firstPayload.unknown.map(({ id }) => id)).toEqual(['gap-scenario-unknown']);
    expect(firstPayload.citationIds).toEqual([
      'citation-1001',
      'citation-first-ephemeral',
      'citation-shield-breaking'
    ]);
    expect(JSON.stringify(firstPayload)).not.toMatch(
      /match-wave-efficient|gap-second-scenario|ephemeral-unbound|citation-unbound/
    );
    expect(secondPayload.mechanicStrategies.map(({ id }) => id)).toEqual([
      'match-wave-efficient'
    ]);
    expect(secondPayload.ephemeralCharacterStrategies).toEqual([]);
    expect(secondPayload.ephemeralMechanicStrategies).toEqual([]);
    expect(secondPayload.ephemeralScenarioStrategies).toEqual([]);
    expect(secondPayload.unknown.map(({ id }) => id)).toEqual(['gap-second-scenario']);
    expect(secondPayload.citationIds).toEqual([
      'citation-1002',
      'citation-wave-efficient'
    ]);
    expect(JSON.stringify(secondPayload)).not.toMatch(
      /match-shield-breaking|ephemeral-first-bound|gap-scenario-unknown|ephemeral-unbound/
    );
  });

  it('fails closed for unknown characters, duplicate ids, target drift, and cross-run scope', async () => {
    const tools = createAbyssBusinessTools({
      getProfile: () => null,
      getScenario: () => abyssScenario(),
      knowledgePacket: packet,
      knowledgeScope: {
        floor: 12,
        chambers: [1, 2],
        eligibleCharacterIds: ['1001', '1002']
      },
      knowledgeTargetScopes: {
        '12:1:first': {
          trustedMatchIds: ['match-shield-breaking'],
          ephemeralMatchIds: [],
          unknownIds: ['gap-scenario-unknown']
        }
      },
      auditContext: {
        correlationId: 'run-current',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1'
      }
    });
    const handler = tools[2]!.handler;

    expect(
      await handler(
        { characterIds: ['1001', '1001'], floor: 12, chamber: 1, half: 'first' },
        {}
      )
    ).toMatchObject({ isError: true });
    expect(
      await handler(
        { characterIds: ['9999'], floor: 12, chamber: 1, half: 'first' },
        {}
      )
    ).toMatchObject({ isError: true });
    expect(
      await handler(
        { characterIds: ['1001'], floor: 11, chamber: 1, half: 'first' },
        {}
      )
    ).toMatchObject({ isError: true });
    expect(
      await handler(
        { characterIds: ['1001'], floor: 12, chamber: 3, half: 'second' },
        {}
      )
    ).toMatchObject({ isError: true });
  });
});
