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

  it('returns a redacted and bounded profile view without image URLs or provenance', async () => {
    const tools = createAbyssBusinessTools({
      getProfile: () => ({
        schemaVersion: 2,
        uid: '123456789',
        source: 'merged',
        fetchedAt: '2026-07-23T00:00:00.000Z',
        characters: [...ABYSS_CHARACTERS, ...ABYSS_CHARACTERS],
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
    const result = await tools[0]!.handler({ uid: '123456789' }, {});
    const payload = textPayload(result) as { characters: unknown[] };
    expect(payload.characters).toHaveLength(8);
    expect(JSON.stringify(payload)).not.toMatch(/imageUrl|provenance|weapon|artifact/i);
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
