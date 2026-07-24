import { describe, expect, it } from 'vitest';

import {
  KnowledgeCoverageGate,
  knowledgeResearchTaskSchema
} from '../../../src/main/services/knowledge-coverage-gate.js';
import {
  knowledgeContextPacketSchema,
  type KnowledgeContextPacket,
  type KnowledgeGap
} from '../../../src/shared/advisor-knowledge.js';

function packet(unknowns: KnowledgeGap[]): KnowledgeContextPacket {
  return knowledgeContextPacketSchema.parse({
    knowledgeVersion: 'test-knowledge',
    buildInterpretations: unknowns
      .filter(({ subjectId }) => /^\d+$/.test(subjectId))
      .map(({ subjectId }) => ({
        characterId: subjectId,
        archetypeId: null,
        confidence: 'low',
        candidateArchetypeIds: [],
        contextRequired: false,
        matchedSignals: ['safe-signal'],
        conflictingSignals: [],
        currentBuildUsable: false,
        adjustment: 'optional',
        unknowns: ['safe-build-unknown']
      })),
    trustedMatches: [],
    ephemeralMatches: [],
    unknowns,
    coverage: {
      requested: unknowns.length,
      trusted: 0,
      ephemeral: 0,
      unknown: unknowns.length
    },
    citations: []
  });
}

function gap(index: number, kind: KnowledgeGap['kind'], subjectId = '10000052'): KnowledgeGap {
  return {
    id: `gap-${index}`,
    subjectId,
    kind,
    reason: `Safe ${kind} reason`
  };
}

describe('KnowledgeCoverageGate', () => {
  it('does not request research when local coverage is complete', () => {
    const complete = knowledgeContextPacketSchema.parse({
      knowledgeVersion: 'complete',
      buildInterpretations: [],
      trustedMatches: [],
      ephemeralMatches: [],
      unknowns: [],
      coverage: { requested: 0, trusted: 0, ephemeral: 0, unknown: 0 },
      citations: []
    });

    expect(
      new KnowledgeCoverageGate().plan(complete, { characters: [], scenarioTags: [] })
    ).toEqual([]);
  });

  it.each(['missing', 'stale', 'conflict', 'build-unmatched'] as const)(
    'creates one anonymous strictly parsed research task for a %s gap',
    (kind) => {
      const tasks = new KnowledgeCoverageGate().plan(packet([gap(1, kind)]), {
        characters: [
          {
            id: '10000052',
            name: '雷电将军',
            element: 'electro',
            weaponType: 'polearm'
          }
        ],
        scenarioTags: ['elemental-shield']
      });

      expect(tasks).toEqual([
        {
          key: 'gap-1',
          reason: kind,
          character: {
            name: '雷电将军',
            element: 'electro',
            weaponType: 'polearm',
            buildSignals: ['safe-signal', 'safe-build-unknown']
          },
          scenarioTags: ['elemental-shield']
        }
      ]);
      expect(() => knowledgeResearchTaskSchema.parse(tasks[0])).not.toThrow();
    }
  );

  it('ignores payload-truncated gaps because they are not a knowledge research reason', () => {
    expect(
      new KnowledgeCoverageGate().plan(packet([gap(1, 'payload-truncated')]), {
        characters: [],
        scenarioTags: []
      })
    ).toEqual([]);
  });

  it('serializes only whitelisted anonymous fields and bounds signals and scenario tags', () => {
    const maliciousContext = {
      uid: '123456789',
      nickname: 'PRIVATE-NICKNAME',
      cookie: 'ltoken_v2=COOKIE-SECRET',
      Authorization: 'Bearer AUTH-SECRET',
      characters: [
        {
          id: '10000052',
          name: '雷电将军',
          element: 'electro',
          weaponType: 'polearm',
          uid: '123456789',
          cookie: 'COOKIE-SECRET',
          Authorization: 'AUTH-SECRET',
          fullStats: { hp: 99_999, atk: 9_999 }
        }
      ],
      scenarioTags: Array.from({ length: 30 }, (_, index) => `tag-${index}`)
    };
    const unsafePacket = packet([gap(1, 'missing'), gap(2, 'stale', 'scenario:elemental-shield')]);
    unsafePacket.buildInterpretations[0]!.matchedSignals = Array.from(
      { length: 12 },
      (_, index) => `matched-${index}`
    );
    unsafePacket.buildInterpretations[0]!.conflictingSignals = ['must-be-trimmed'];
    unsafePacket.buildInterpretations[0]!.unknowns = ['must-also-be-trimmed'];

    const tasks = new KnowledgeCoverageGate().plan(unsafePacket, maliciousContext);
    const serialized = JSON.stringify(tasks);

    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.character?.buildSignals).toHaveLength(12);
    expect(tasks[0]?.scenarioTags).toHaveLength(24);
    expect(serialized).not.toMatch(
      /123456789|PRIVATE-NICKNAME|COOKIE-SECRET|AUTH-SECRET|fullStats|99999|9999/
    );
    for (const task of tasks) {
      expect(Object.keys(task).sort()).toEqual(
        ['character', 'key', 'reason', 'scenarioTags']
          .filter((key) => key !== 'character' || task.character !== undefined)
          .sort()
      );
      expect(() => knowledgeResearchTaskSchema.parse(task)).not.toThrow();
    }
  });
});
