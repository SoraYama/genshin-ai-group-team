import { describe, expect, it, vi } from 'vitest';

import {
  STYGIAN_MCP_TOOL_NAMES,
  createStygianBusinessTools
} from '../../../src/main/services/stygian-business-tools.js';
import { CharacterKnowledgeStore } from '../../../src/main/services/character-knowledge-store.js';
import { STYGIAN_CHARACTERS, stygianScenario } from './stygian-test-fixtures.js';

function textPayload(
  result: Awaited<ReturnType<ReturnType<typeof createStygianBusinessTools>[number]['handler']>>
) {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('Expected text result');
  return JSON.parse(first.text) as unknown;
}

describe('stygian in-process business tools', () => {
  it('exposes only bounded profile, per-phase enemy, and character knowledge reads', () => {
    const tools = createStygianBusinessTools({
      getProfile: () => null,
      getScenario: () => stygianScenario()
    });
    expect(tools.map(({ name }) => name)).toEqual([
      'read_profile_cache',
      'query_stygian_phase',
      'query_genshin_db'
    ]);
    expect(STYGIAN_MCP_TOOL_NAMES).toEqual([
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_stygian_phase',
      'mcp__genshin__query_genshin_db'
    ]);
    expect(tools.every(({ annotations }) => annotations?.readOnlyHint === true)).toBe(true);
  });

  it('returns localized boss and selected difficulty modifiers without raw slugs or unknown claims', async () => {
    const scenario = stygianScenario();
    scenario.phases[0]!.boss.mechanics.tags = ['requires-capability:bow', 'internal-tag'];
    const log = vi.fn();
    const tools = createStygianBusinessTools({
      getProfile: () => null,
      getScenario: () => scenario,
      log
    });
    const mismatch = await tools[1]!.handler(
      {
        scenarioId: 'wrong',
        dataVersion: scenario.meta.dataVersion,
        difficultyId: 'difficulty-6',
        phase: 1
      },
      {}
    );
    expect(mismatch.isError).toBe(true);
    const result = await tools[1]!.handler(
      {
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        difficultyId: 'difficulty-6',
        phase: 1
      },
      {}
    );
    const payload = textPayload(result);
    expect(JSON.stringify(payload)).toContain('试炼首领1');
    expect(JSON.stringify(payload)).toContain('限时窗口更紧');
    expect(JSON.stringify(payload)).toContain('"value":"bow"');
    expect(JSON.stringify(payload)).not.toMatch(/Trial Boss|boss-1|encounter-1|internal-tag/);
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tool: 'query_stygian_phase',
        parameterSummary: { difficultyOrder: 6, phase: 1 }
      })
    );
  });

  it('reuses redacted profile and versioned knowledge views with correlated safe audit fields', async () => {
    const log = vi.fn();
    const knowledge = CharacterKnowledgeStore.fromUnknown({
      schemaVersion: 1,
      knowledgeVersion: 'stygian-knowledge-v1',
      updatedAt: '2026-07-23T00:00:00.000Z',
      coverage: { characterCount: 1, notes: 'test' },
      characters: [
        {
          id: '1001',
          name: '幽境角色1',
          weaponType: 'bow',
          roles: ['support'],
          energyCost: 60,
          energyNeeds: 'medium',
          capabilities: ['shield'],
          applicationNotes: ['test'],
          kitNotes: ['test'],
          unknownFields: []
        }
      ]
    });
    const scenario = stygianScenario();
    const tools = createStygianBusinessTools({
      getProfile: () => ({
        schemaVersion: 2,
        uid: '123456789',
        source: 'merged',
        fetchedAt: '2026-07-23T00:00:00.000Z',
        characters: STYGIAN_CHARACTERS,
        coverage: {
          ownedCount: 14,
          detailedCount: 8,
          buildCount: 14,
          statsCount: 14,
          enkaShowcaseCount: 14,
          missingDetailCount: 6,
          partial: true
        }
      }),
      getScenario: () => scenario,
      knowledge,
      auditContext: {
        correlationId: 'stygian-audit',
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        round: 'repair'
      },
      log
    });
    const profile = textPayload(
      await tools[0]!.handler(
        {
          uid: '123456789',
          characterIds: STYGIAN_CHARACTERS.slice(0, 8).map(({ id }) => String(id)),
          cursor: undefined,
          pageSize: undefined
        },
        {}
      )
    );
    const profileView = profile as {
      coverage: { partial: boolean };
      provenanceSummaries: Array<Record<string, unknown>>;
      characters: Array<Record<string, unknown>>;
    };
    expect(profileView.coverage.partial).toBe(true);
    expect(profileView.characters[0]).toMatchObject({
      completeness: expect.any(String),
      stats: expect.any(Object)
    });
    expect(profileView.provenanceSummaries[0]).toMatchObject({
      ownership: 'miyoushe-list',
      characterIndexes: expect.any(Array)
    });
    expect(JSON.stringify(profile)).not.toMatch(/imageUrl|iconUrl|subStats|fetchedAt/);
    const result = textPayload(await tools[2]!.handler({ characterIds: ['1001', '9999'] }, {})) as {
      knowledgeVersion: string;
    };
    expect(result.knowledgeVersion).toBe('stygian-knowledge-v1');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'query_genshin_db',
        correlationId: 'stygian-audit',
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        knowledgeVersion: 'stygian-knowledge-v1',
        round: 'repair',
        parameterSummary: { requestedCount: 2 },
        issueCodes: []
      })
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/123456789|1001|9999|authorization/i);
  });

  it('localizes difficulty, phase, and boss modifiers before returning Agent context', async () => {
    const scenario = stygianScenario();
    scenario.difficulties[5]!.modifiers = [
      { id: 'energy-pressure', description: 'Energy pressure increased' }
    ];
    scenario.phases[0]!.phaseModifiers = [{ id: 'unknown-phase', description: 'phase_damage_up' }];
    scenario.phases[0]!.bossModifiers = [
      { id: 'unknown-boss', description: 'Boss gains increased resistance' }
    ];
    const tools = createStygianBusinessTools({
      getProfile: () => null,
      getScenario: () => scenario
    });

    const payload = textPayload(
      await tools[1]!.handler(
        {
          scenarioId: scenario.id,
          dataVersion: scenario.meta.dataVersion,
          difficultyId: 'difficulty-6',
          phase: 1
        },
        {}
      )
    ) as {
      difficultyModifiers: string[];
      phaseModifiers: string[];
      bossModifiers: string[];
    };

    expect(payload.difficultyModifiers).toEqual(['能量回复压力上升。']);
    expect(payload.phaseModifiers).toEqual(['挑战修正暂无中文说明']);
    expect(payload.bossModifiers).toEqual(['挑战修正暂无中文说明']);
    expect(JSON.stringify(payload)).not.toMatch(/Energy pressure|phase_damage_up|Boss gains/i);
  });

  it('fails closed with a typed error for an oversized phase payload', async () => {
    const scenario = stygianScenario();
    scenario.crossPartyReusePolicy.notes = ['界'.repeat(17_000)];
    const tools = createStygianBusinessTools({
      getProfile: () => null,
      getScenario: () => scenario
    });

    const result = await tools[1]!.handler(
      {
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        difficultyId: 'difficulty-6',
        phase: 1
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
});
