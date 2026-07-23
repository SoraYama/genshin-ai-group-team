import { describe, expect, it } from 'vitest';

import {
  THEATER_MCP_TOOL_NAMES,
  createTheaterBusinessTools
} from '../../../src/main/services/theater-business-tools.js';
import { THEATER_CHARACTERS, theaterScenario } from './theater-test-fixtures.js';

function payload(result: { content: Array<{ type: string; text?: string }> }) {
  const item = result.content[0];
  if (!item || item.type !== 'text' || !item.text) throw new Error('Expected text');
  return JSON.parse(item.text) as unknown;
}

describe('theater business tools', () => {
  it('exposes only bounded profile, per-act encounter, and character knowledge reads', () => {
    const tools = createTheaterBusinessTools({
      getProfile: () => null,
      getScenario: theaterScenario
    });
    expect(tools.map(({ name }) => name)).toEqual([
      'read_profile_cache',
      'query_theater_act',
      'query_genshin_db'
    ]);
    expect(THEATER_MCP_TOOL_NAMES).toEqual([
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_theater_act',
      'mcp__genshin__query_genshin_db'
    ]);
    expect(tools.every(({ annotations }) => annotations?.readOnlyHint === true)).toBe(true);
  });

  it('returns localized act enemies, path uncertainty and vigor without internal IDs', async () => {
    const tools = createTheaterBusinessTools({
      getProfile: () => null,
      getScenario: theaterScenario
    });
    const scenario = theaterScenario();
    const result = payload(
      await tools[1]!.handler(
        { scenarioId: scenario.id, dataVersion: scenario.meta.dataVersion, act: 1 },
        {}
      )
    );
    const text = JSON.stringify(result);
    expect(text).toContain('如果');
    expect(text).toContain('聚怪能力');
    expect(text).not.toMatch(/act-1-encounter|requires-capability|theater-validator/);
  });

  it('redacts profile internals and bounds knowledge reads', async () => {
    const tools = createTheaterBusinessTools({
      getProfile: () => ({
        schemaVersion: 2,
        uid: '123456789',
        source: 'merged',
        fetchedAt: '2026-07-23T00:00:00.000Z',
        characters: THEATER_CHARACTERS,
        coverage: {
          ownedCount: 12,
          detailedCount: 8,
          buildCount: 12,
          statsCount: 12,
          enkaShowcaseCount: 8,
          missingDetailCount: 4,
          partial: true
        }
      }),
      getScenario: theaterScenario
    });
    expect(JSON.stringify(payload(await tools[0]!.handler({ uid: '123456789' }, {})))).not.toMatch(
      /imageUrl|provenance|artifact/i
    );
    const knowledge = payload(await tools[2]!.handler({ characterIds: ['1001'] }, {}));
    expect(JSON.stringify(knowledge)).toContain('unknown');
  });
});
