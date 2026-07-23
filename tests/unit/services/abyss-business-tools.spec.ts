import { describe, expect, it, vi } from 'vitest';

import {
  ABYSS_MCP_TOOL_NAMES,
  createAbyssBusinessTools
} from '../../../src/main/services/abyss-business-tools.js';
import { CharacterKnowledgeStore } from '../../../src/main/services/character-knowledge-store.js';
import { ABYSS_CHARACTERS, abyssScenario } from './abyss-test-fixtures.js';

function textPayload(
  result: Awaited<ReturnType<ReturnType<typeof createAbyssBusinessTools>[number]['handler']>>
) {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('Expected text result');
  return JSON.parse(first.text) as unknown;
}

describe('abyss in-process business tools', () => {
  it('exposes only the three bounded read-only tool names', () => {
    const tools = createAbyssBusinessTools({
      getProfile: () => null,
      getScenario: () => abyssScenario()
    });
    expect(tools.map(({ name }) => name)).toEqual([
      'read_profile_cache',
      'query_enemy_data',
      'query_genshin_db'
    ]);
    expect(ABYSS_MCP_TOOL_NAMES).toEqual([
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_enemy_data',
      'mcp__genshin__query_genshin_db'
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
    expect(JSON.stringify(result)).toContain('PROFILE_RESPONSE_TOO_LARGE');
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

  it('returns versioned character knowledge and records only correlated safe observability fields', async () => {
    const log = vi.fn();
    const knowledge = CharacterKnowledgeStore.fromUnknown({
      schemaVersion: 1,
      knowledgeVersion: 'test-knowledge-v1',
      updatedAt: '2026-07-23T00:00:00.000Z',
      coverage: { characterCount: 1, notes: '测试覆盖。' },
      characters: [
        {
          id: '1001',
          name: '测试角色1',
          weaponType: 'bow',
          roles: ['support'],
          energyCost: 60,
          energyNeeds: 'medium',
          capabilities: ['healing', 'off-field'],
          applicationNotes: ['后台恢复。'],
          kitNotes: ['不推断伤害。'],
          unknownFields: []
        }
      ]
    });
    const tools = createAbyssBusinessTools({
      getProfile: () => null,
      getScenario: () => abyssScenario(),
      knowledge,
      auditContext: {
        correlationId: 'audit-request-1',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1'
      },
      log
    });
    const result = await tools[2]!.handler({ characterIds: ['1001', '9999'] }, {});
    const payload = textPayload(result) as {
      knowledgeVersion: string;
      characters: Array<Record<string, unknown>>;
    };
    expect(payload.knowledgeVersion).toBe('test-knowledge-v1');
    expect(payload.characters[0]).toMatchObject({
      id: '1001',
      status: 'known',
      weaponType: 'bow',
      roles: ['support'],
      capabilities: ['healing', 'off-field']
    });
    expect(payload.characters[1]).toMatchObject({
      id: '9999',
      status: 'unknown',
      unknownFields: expect.arrayContaining(['weaponType', 'roles', 'capabilities', 'kitNotes'])
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'query_genshin_db',
        itemCount: 2,
        ok: true,
        correlationId: 'audit-request-1',
        scenarioId: 'abyss.2026-07',
        dataVersion: '2026.07.1',
        knowledgeVersion: 'test-knowledge-v1',
        parameterSummary: { requestedCount: 2 },
        issueCodes: []
      })
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /123456789|1001|9999|api.?key|authorization/i
    );
  });
});
