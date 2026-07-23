import { describe, expect, it } from 'vitest';

import { buildV2PipelineContext } from '../../../src/main/services/v2-agent-context.js';
import { ABYSS_CHARACTERS, validAbyssPlan } from './abyss-test-fixtures.js';

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
      knowledge: {
        version: 'knowledge-v1',
        unknownCharacterIds: ['1009', '1010']
      }
    });

    expect(context.candidate).toMatchObject({
      kind: 'feasibleBaseline',
      feasibleBaseline: baseline
    });
    expect(context.profile.characters[0]).toMatchObject({
      level: 90,
      stats: expect.objectContaining({ atk: 1200, energyRecharge: 110 }),
      completeness: 'detailed'
    });
    expect(context.profile.characters[6]).toMatchObject({
      missingFields: ['weapon', 'artifacts', 'talents']
    });
    expect(context.knowledge.unknownCharacterIds).toHaveLength(2);
    expect(JSON.stringify(context)).not.toMatch(
      /imageUrl|iconUrl|subStats|private\.example|cookie|apiKey|Authorization|https?:\/\//
    );
  });
});
