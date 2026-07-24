import { describe, expect, it } from 'vitest';

import {
  guideResearchTaskSchema,
  KnowledgeCoverageGate
} from '../../../src/main/services/knowledge-coverage-gate.js';
import {
  knowledgeContextPacketSchema,
  type CommittedCharacterCatalogEntry,
  type KnowledgeContextPacket,
  type KnowledgeGap
} from '../../../src/shared/advisor-knowledge.js';

const RAIDEN: CommittedCharacterCatalogEntry = {
  id: '10000052',
  name: '雷电将军',
  aliases: [],
  element: 'electro',
  weaponType: 'polearm'
};

const trustedCatalog = {
  getCatalogEntry(characterId: string): CommittedCharacterCatalogEntry | undefined {
    if (characterId === RAIDEN.id) return structuredClone(RAIDEN);
    if (characterId === '123456789') {
      return {
        id: '123456789',
        name: '不应被视为角色',
        aliases: [],
        element: 'unknown',
        weaponType: 'unknown'
      };
    }
    return undefined;
  }
};

function gate(): KnowledgeCoverageGate {
  return new KnowledgeCoverageGate(trustedCatalog);
}

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

function gap(index: number, kind: KnowledgeGap['kind'], subjectId = RAIDEN.id): KnowledgeGap {
  return {
    id: `gap-${index}`,
    subjectId,
    kind,
    reason: `Safe ${kind} reason`
  };
}

const safeContext = {
  characters: [
    {
      id: RAIDEN.id,
      name: RAIDEN.name,
      element: RAIDEN.element,
      weaponType: RAIDEN.weaponType
    }
  ],
  scenarioTags: ['elemental-shield']
};

describe('guideResearchTaskSchema', () => {
  const validTask = {
    key: 'guide-missing-0123456789abcdef',
    reason: 'missing',
    character: {
      name: RAIDEN.name,
      element: RAIDEN.element,
      weaponType: RAIDEN.weaponType,
      buildSignals: ['build-match-present']
    },
    scenarioTags: ['elemental-shield']
  } as const;

  it('is strict at the task and character boundaries', () => {
    expect(() =>
      guideResearchTaskSchema.parse({ ...validTask, privateContext: 'secret' })
    ).toThrow();
    expect(() =>
      guideResearchTaskSchema.parse({
        ...validTask,
        character: { ...validTask.character, uid: '123456789' }
      })
    ).toThrow();
  });

  it.each([
    ['invalid weapon type', { character: { ...validTask.character, weaponType: 'axe' } }],
    ['100-character name', { character: { ...validTask.character, name: '角'.repeat(100) } }],
    ['30-character element', { character: { ...validTask.character, element: 'e'.repeat(30) } }],
    [
      '150-character build signal',
      { character: { ...validTask.character, buildSignals: ['s'.repeat(150)] } }
    ],
    ['161-character key', { key: 'k'.repeat(161) }]
  ])('rejects %s', (_label, override) => {
    expect(() =>
      guideResearchTaskSchema.parse({
        ...validTask,
        ...override
      })
    ).toThrow();
  });

  it('accepts the exact published upper bounds', () => {
    expect(() =>
      guideResearchTaskSchema.parse({
        ...validTask,
        key: 'k'.repeat(160),
        character: {
          ...validTask.character,
          name: '角'.repeat(80),
          element: 'e'.repeat(24),
          buildSignals: ['s'.repeat(120)]
        }
      })
    ).not.toThrow();
  });
});

describe('KnowledgeCoverageGate', () => {
  it('evaluates complete local coverage without research', () => {
    const complete = knowledgeContextPacketSchema.parse({
      knowledgeVersion: 'complete',
      buildInterpretations: [],
      trustedMatches: [],
      ephemeralMatches: [],
      unknowns: [],
      coverage: { requested: 0, trusted: 0, ephemeral: 0, unknown: 0 },
      citations: []
    });

    expect(gate().evaluate(complete, { characters: [], scenarioTags: [] })).toEqual({
      required: false,
      tasks: []
    });
  });

  it.each(['missing', 'stale', 'conflict', 'build-unmatched'] as const)(
    'requires one strictly parsed guide task for a %s gap',
    (kind) => {
      const evaluation = gate().evaluate(packet([gap(1, kind)]), safeContext);

      expect(evaluation.required).toBe(true);
      expect(evaluation.tasks).toHaveLength(1);
      expect(evaluation.tasks[0]).toMatchObject({
        reason: kind,
        character: {
          name: RAIDEN.name,
          element: RAIDEN.element,
          weaponType: RAIDEN.weaponType,
          buildSignals: ['build-match-present', 'build-unknown-present']
        },
        scenarioTags: ['elemental-shield']
      });
      expect(evaluation.tasks[0]?.key).toMatch(new RegExp(`^guide-${kind}-[a-f0-9]{24}$`));
      expect(() => guideResearchTaskSchema.parse(evaluation.tasks[0])).not.toThrow();
    }
  );

  it('does not trigger research for payload truncation', () => {
    expect(gate().evaluate(packet([gap(1, 'payload-truncated')]), safeContext)).toEqual({
      required: false,
      tasks: []
    });
  });

  it('uses only canonical catalog character context and never mistakes a 9-digit account UID for a character', () => {
    const unsafePacket = packet([
      {
        id: 'gap-PRIVATE-NICKNAME-COOKIE-SECRET',
        subjectId: RAIDEN.id,
        kind: 'build-unmatched',
        reason: 'PRIVATE-NICKNAME AUTH-SECRET'
      },
      {
        id: 'gap-123456789-AUTH-SECRET',
        subjectId: '123456789',
        kind: 'missing',
        reason: 'COOKIE-SECRET'
      }
    ]);
    for (const interpretation of unsafePacket.buildInterpretations) {
      interpretation.matchedSignals = ['PRIVATE-NICKNAME', '123456789', 'ltoken-v2-COOKIE-SECRET'];
      interpretation.conflictingSignals = ['AUTHORIZATION-SECRET'];
      interpretation.unknowns = ['API-KEY-SECRET', 'full-stats-99999'];
    }
    const maliciousContext = {
      characters: [
        {
          id: RAIDEN.id,
          name: 'PRIVATE-NICKNAME',
          element: '123456789',
          weaponType: 'COOKIE-SECRET',
          buildSignals: ['AUTHORIZATION-SECRET', 'API-KEY-SECRET', 'full-stats-99999']
        },
        {
          id: '123456789',
          name: 'PRIVATE-ACCOUNT-NICKNAME',
          element: 'UID-SECRET',
          weaponType: 'API-KEY-SECRET',
          buildSignals: ['COOKIE-SECRET']
        }
      ],
      scenarioTags: [
        'elemental-shield',
        '123456789',
        'PRIVATE-NICKNAME',
        'ltoken_v2=COOKIE-SECRET',
        'Authorization: Bearer AUTH-SECRET',
        'api-key=API-KEY-SECRET',
        'full-stats-99999'
      ]
    };

    const first = gate().evaluate(unsafePacket, maliciousContext);
    const second = gate().evaluate(unsafePacket, maliciousContext);
    const serialized = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(first.required).toBe(true);
    expect(first.tasks).toHaveLength(2);
    expect(new Set(first.tasks.map(({ key }) => key)).size).toBe(first.tasks.length);
    expect(first.tasks[0]?.character).toEqual({
      name: RAIDEN.name,
      element: RAIDEN.element,
      weaponType: RAIDEN.weaponType,
      buildSignals: ['build-match-present', 'build-conflict-present', 'build-unknown-present']
    });
    expect(first.tasks[1]?.character).toBeUndefined();
    expect(
      first.tasks.every(({ scenarioTags }) => scenarioTags.join(',') === 'elemental-shield')
    ).toBe(true);
    expect(serialized).not.toMatch(
      /123456789|PRIVATE|NICKNAME|COOKIE|AUTH|API-KEY|full-stats|99999|ltoken|Bearer/i
    );
  });

  it('deduplicates equivalent anonymous tasks without copying gap identifiers into the key', () => {
    const repeated = packet([
      {
        id: 'gap-private-one',
        subjectId: 'scenario:PRIVATE-NICKNAME',
        kind: 'missing',
        reason: 'first private reason'
      },
      {
        id: 'gap-private-two',
        subjectId: 'scenario:COOKIE-SECRET',
        kind: 'missing',
        reason: 'second private reason'
      }
    ]);

    const evaluation = gate().evaluate(repeated, {
      characters: [],
      scenarioTags: ['elemental-shield', 'PRIVATE-NICKNAME']
    });

    expect(evaluation.tasks).toHaveLength(1);
    expect(evaluation.tasks[0]?.key).toMatch(/^guide-missing-[a-f0-9]{24}$/);
    expect(JSON.stringify(evaluation)).not.toMatch(/private-one|private-two|NICKNAME|COOKIE/i);
  });

  it('keeps anonymous keys stable when equivalent safe scenario tags arrive in another order', () => {
    const targetPacket = packet([gap(1, 'missing')]);
    const first = gate().evaluate(targetPacket, {
      ...safeContext,
      scenarioTags: ['elemental-shield', 'boss']
    });
    const reordered = gate().evaluate(targetPacket, {
      ...safeContext,
      scenarioTags: ['boss', 'elemental-shield']
    });

    expect(reordered).toEqual(first);
  });
});
