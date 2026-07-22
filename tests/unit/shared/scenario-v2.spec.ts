import { describe, expect, it } from 'vitest';

import {
  abyssPlanSchema,
  communityWikiSourceReferenceSchema,
  imaginariumTheaterScenarioSchema,
  internalReviewEvidenceSchema,
  playerInterventionSchema,
  recommendationPlanSchema,
  scenarioCacheEnvelopeSchema,
  scenarioPublicationEnvelopeSchema,
  scenarioV2Schema,
  sourceReferenceSchema,
  spiralAbyssScenarioSchema,
  stygianOnslaughtScenarioSchema,
  stygianPlanSchema,
  theaterPlanSchema,
  versionedMetaSchema
} from '../../../src/shared/scenario-v2';

const sourceRef = {
  id: 'official-2026-07-01',
  source: 'official-announcement' as const,
  url: 'https://example.com/announcement',
  retrievedAt: '2026-07-01T00:00:00.000Z'
};

const communityWikiSourceRef = {
  id: 'community-wiki-2026-07-01',
  source: 'community-wiki' as const,
  url: 'https://example.fandom.com/wiki/Spiral_Abyss',
  retrievedAt: '2026-07-01T00:30:00.000Z',
  attribution: 'Example Wiki contributors',
  license: { kind: 'CC-BY-SA-3.0' as const }
};

const legacyReviewedMeta = {
  schemaVersion: 2 as const,
  dataVersion: '2026.07.1',
  effectiveFrom: '2026-07-01T00:00:00.000Z',
  effectiveTo: '2026-08-01T00:00:00.000Z',
  sourceRefs: [sourceRef],
  staleStatus: 'fresh' as const,
  reviewedAt: '2026-07-01T01:00:00.000Z',
  reviewedBy: 'content-reviewer',
  manifest: {
    algorithm: 'sha256' as const,
    hash: 'a'.repeat(64),
    signature: 'release-signature'
  }
};

const reviewedMeta = {
  schemaVersion: 2 as const,
  dataVersion: '2026.07.1',
  effectiveFrom: '2026-07-01T00:00:00.000Z',
  effectiveTo: '2026-08-01T00:00:00.000Z',
  sourceRefs: [sourceRef],
  fieldProvenance: [
    { fieldPath: 'meta.effectiveRange', sourceRefId: sourceRef.id },
    { fieldPath: 'scenario.floors', sourceRefId: sourceRef.id },
    { fieldPath: 'scenario.blessing', sourceRefId: sourceRef.id }
  ],
  reviewedAt: '2026-07-01T01:00:00.000Z',
  reviewedBy: 'content-reviewer'
};

const meta = reviewedMeta;

const metaWithPaths = (fieldPaths: string[]) => ({
  ...reviewedMeta,
  fieldProvenance: fieldPaths.map((fieldPath) => ({ fieldPath, sourceRefId: sourceRef.id }))
});

const stygianMeta = metaWithPaths([
  'meta.effectiveRange',
  'scenario.phases',
  'scenario.difficulties',
  'scenario.reusePolicy'
]);

const theaterMeta = metaWithPaths([
  'meta.effectiveRange',
  'scenario.eligibility',
  'scenario.cast',
  'scenario.nodes',
  'scenario.vigor'
]);

const entity = (id: string, zhName: string) => ({
  id,
  names: { 'zh-CN': zhName, en: id }
});

const enemy = {
  enemy: entity('enemy.hilichurl', '丘丘人'),
  level: 100,
  count: 2,
  mechanics: {
    shields: [{ element: 'pyro', strength: 12 }],
    resistances: [{ damageType: 'physical', percent: 10 }],
    immunities: ['frozen'],
    tags: ['groupable', 'lightweight']
  }
};

const wave = (id: string) => ({ id, enemies: [enemy] });

const team = (id: string, characterIds: string[]) => ({
  id,
  characterIds,
  purpose: '稳定完成目标'
});

const commonPlan = {
  schemaVersion: 2 as const,
  scenarioId: 'scenario.current',
  dataVersion: meta.dataVersion,
  confidence: 'high' as const,
  warnings: [],
  assumptions: ['角色状态以最近一次本地资料为准']
};

const spiralPayload = {
  mode: 'spiral-abyss' as const,
  id: 'abyss.2026-07',
  meta,
  blessing: { id: 'blessing.current', description: '本期渊月祝福' },
  floors: [
    {
      floor: 12,
      chambers: [
        {
          chamber: 1,
          firstHalf: { waves: [wave('12-1-a-1')] },
          secondHalf: { waves: [wave('12-1-b-1')] }
        }
      ]
    }
  ]
};

const stygianPayload = {
  mode: 'stygian-onslaught' as const,
  id: 'stygian.identities',
  meta: stygianMeta,
  crossPartyReusePolicy: { rule: 'forbidden' as const },
  difficulties: Array.from({ length: 6 }, (_, index) => ({
    id: `difficulty-${index + 1}`,
    order: index + 1,
    name: entity(`difficulty.${index + 1}`, `难度 ${index + 1}`),
    modifiers: [{ id: `difficulty-rule-${index + 1}`, description: '难度规则' }]
  })),
  phases: Array.from({ length: 3 }, (_, index) => ({
    phase: index + 1,
    encounterId: `encounter-${index + 1}`,
    boss: enemy,
    phaseModifiers: [{ id: `phase-rule-${index + 1}`, description: '阶段规则' }],
    bossModifiers: [{ id: `boss-rule-${index + 1}`, description: '首领规则' }]
  }))
};

const theaterPayload = {
  mode: 'imaginarium-theater' as const,
  id: 'theater.identities',
  meta: theaterMeta,
  eligibility: { elements: ['pyro' as const], minimumLevel: 70, requiredHeadcount: 10 },
  pools: {
    opening: [entity('character.opening', '开幕角色')],
    trial: [entity('character.trial', '试用角色')],
    specialGuest: [entity('character.guest', '特邀角色')],
    support: [entity('character.support', '助演角色')]
  },
  vigor: {
    initial: 2,
    max: 4,
    actCosts: [{ act: 1, cost: 1 }],
    nodeCosts: [{ nodeId: 'arcana-1', cost: 1 }]
  },
  acts: [
    {
      act: 1,
      encounters: [{ id: 'encounter-1', waves: [wave('theater-wave-1')] }],
      pathNotes: []
    }
  ],
  arcanaNodes: [
    { id: 'arcana-1', name: entity('arcana.1', '秘法节点'), description: '测试节点' }
  ]
};

const integrity = {
  scope: 'payload' as const,
  serialization: 'RFC8785-JCS' as const,
  hash: {
    algorithm: 'sha256' as const,
    encoding: 'base64' as const,
    value: `${'A'.repeat(43)}=`
  },
  signature: {
    algorithm: 'ed25519' as const,
    keyId: 'release-key-2026',
    encoding: 'base64' as const,
    value: `${'A'.repeat(86)}==`
  }
};

describe('scenario publication and runtime envelopes', () => {
  it('accepts a reviewed payload with detached integrity metadata', () => {
    const result = scenarioPublicationEnvelopeSchema.safeParse({
      payload: spiralPayload,
      integrity
    });

    expect(result.success).toBe(true);
  });

  it('rejects malformed hash and signature encodings', () => {
    const result = scenarioPublicationEnvelopeSchema.safeParse({
      payload: spiralPayload,
      integrity: {
        ...integrity,
        hash: { ...integrity.hash, value: 'not-a-sha256-digest' },
        signature: { ...integrity.signature, value: 'not-an-ed25519-signature' }
      }
    });

    expect(result.success).toBe(false);
  });

  it('rejects integrity metadata embedded in the signed payload', () => {
    const result = scenarioPublicationEnvelopeSchema.safeParse({
      payload: { ...spiralPayload, integrity },
      integrity
    });

    expect(result.success).toBe(false);
  });

  it('keeps refresh failure state in the runtime cache envelope', () => {
    const result = scenarioCacheEnvelopeSchema.safeParse({
      publication: { payload: spiralPayload, integrity },
      runtime: {
        freshness: 'refresh-failed',
        checkedAt: '2026-07-02T00:00:00.000Z',
        lastRefreshAttemptAt: '2026-07-02T00:00:00.000Z',
        refreshErrorCode: 'network-unavailable'
      }
    });

    expect(result.success).toBe(true);
  });

  it('rejects unknown publication envelope keys', () => {
    const result = scenarioPublicationEnvelopeSchema.safeParse({
      payload: spiralPayload,
      integrity,
      producerDrift: true
    });

    expect(result.success).toBe(false);
  });
});

describe('reviewed scenario metadata provenance', () => {
  it('accepts an attributed community wiki source with its license declaration', () => {
    expect(sourceReferenceSchema.safeParse(communityWikiSourceRef).success).toBe(true);
  });

  it('rejects a community wiki source without its URL', () => {
    const withoutUrl = { ...communityWikiSourceRef, url: undefined };

    expect(communityWikiSourceReferenceSchema.safeParse(withoutUrl).success).toBe(false);
  });

  it('rejects a community wiki source without attribution', () => {
    const withoutAttribution = { ...communityWikiSourceRef, attribution: undefined };

    expect(communityWikiSourceReferenceSchema.safeParse(withoutAttribution).success).toBe(false);
  });

  it('rejects a community wiki source without a license declaration', () => {
    const withoutLicense = { ...communityWikiSourceRef, license: undefined };

    expect(communityWikiSourceReferenceSchema.safeParse(withoutLicense).success).toBe(false);
  });

  it('rejects duplicate source reference IDs', () => {
    const result = versionedMetaSchema.safeParse({
      ...legacyReviewedMeta,
      sourceRefs: [sourceRef, { ...sourceRef }],
      fieldProvenance: [{ fieldPath: 'scenario.floors', sourceRefId: sourceRef.id }]
    });

    expect(result.success).toBe(false);
  });

  it('rejects field provenance that references an unknown source', () => {
    const result = versionedMetaSchema.safeParse({
      ...legacyReviewedMeta,
      fieldProvenance: [{ fieldPath: 'scenario.floors', sourceRefId: 'missing-source' }]
    });

    expect(result.success).toBe(false);
  });

  it('rejects publication metadata supported only by development cross-check sources', () => {
    const developmentSource = {
      ...sourceRef,
      id: 'raw-cross-check',
      source: 'development-cross-check' as const
    };
    const result = versionedMetaSchema.safeParse({
      ...legacyReviewedMeta,
      sourceRefs: [developmentSource],
      fieldProvenance: [{ fieldPath: 'scenario.floors', sourceRefId: developmentSource.id }]
    });

    expect(result.success).toBe(false);
  });

  it('rejects an unused official source that masks development-only field provenance', () => {
    const developmentSource = {
      ...sourceRef,
      id: 'raw-cross-check',
      source: 'development-cross-check' as const
    };
    const result = versionedMetaSchema.safeParse({
      ...reviewedMeta,
      sourceRefs: [sourceRef, developmentSource],
      fieldProvenance: [{ fieldPath: 'scenario.floors', sourceRefId: developmentSource.id }]
    });

    expect(result.success).toBe(false);
  });

  it('rejects a mixed payload when one field path is supported only by a development source', () => {
    const developmentSource = {
      ...sourceRef,
      id: 'raw-cross-check',
      source: 'development-cross-check' as const
    };
    const result = versionedMetaSchema.safeParse({
      ...reviewedMeta,
      sourceRefs: [sourceRef, developmentSource],
      fieldProvenance: [
        { fieldPath: 'scenario.floors', sourceRefId: sourceRef.id },
        { fieldPath: 'scenario.blessing', sourceRefId: developmentSource.id }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects development evidence from a public payload even when production supports the path', () => {
    const developmentSource = {
      ...sourceRef,
      id: 'raw-cross-check',
      source: 'development-cross-check' as const
    };
    const result = versionedMetaSchema.safeParse({
      ...reviewedMeta,
      sourceRefs: [sourceRef, developmentSource],
      fieldProvenance: [
        { fieldPath: 'scenario.floors', sourceRefId: sourceRef.id },
        { fieldPath: 'scenario.floors', sourceRefId: developmentSource.id }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('accepts development evidence in a separate internal review record', () => {
    const developmentSource = {
      ...sourceRef,
      id: 'raw-cross-check',
      source: 'development-cross-check' as const
    };
    const result = internalReviewEvidenceSchema.safeParse({
      sourceRefs: [developmentSource],
      fieldProvenance: [{ fieldPath: 'scenario.floors', sourceRefId: developmentSource.id }]
    });

    expect(result.success).toBe(true);
  });

  it('rejects a scene-rule field supported only by an Enka profile source', () => {
    const enkaSource = {
      ...sourceRef,
      id: 'enka-player-profile',
      source: 'enka-profile' as const
    };
    const result = versionedMetaSchema.safeParse({
      ...reviewedMeta,
      sourceRefs: [enkaSource],
      fieldProvenance: [{ fieldPath: 'scenario.floors', sourceRefId: enkaSource.id }]
    });

    expect(result.success).toBe(false);
  });

  it('rejects a scene-rule field supported only by Battle Chronicle', () => {
    const battleChronicleSource = {
      ...sourceRef,
      id: 'battle-chronicle-player-state',
      source: 'battle-chronicle' as const
    };
    const result = versionedMetaSchema.safeParse({
      ...reviewedMeta,
      sourceRefs: [battleChronicleSource],
      fieldProvenance: [{ fieldPath: 'scenario.floors', sourceRefId: battleChronicleSource.id }]
    });

    expect(result.success).toBe(false);
  });

  it('rejects runtime freshness and integrity fields inside reviewed metadata', () => {
    expect(versionedMetaSchema.safeParse(legacyReviewedMeta).success).toBe(false);
  });
});

describe('mode-specific publication provenance coverage', () => {
  it('rejects an arbitrary field provenance path', () => {
    const result = versionedMetaSchema.safeParse(metaWithPaths(['scenario.not-a-real-subtree']));

    expect(result.success).toBe(false);
  });

  it('rejects Abyss metadata missing blessing coverage', () => {
    const result = spiralAbyssScenarioSchema.safeParse({
      ...spiralPayload,
      meta: metaWithPaths(['meta.effectiveRange', 'scenario.floors'])
    });

    expect(result.success).toBe(false);
  });

  it('rejects Stygian metadata missing reuse-policy coverage', () => {
    const result = stygianOnslaughtScenarioSchema.safeParse({
      mode: 'stygian-onslaught',
      id: 'stygian.missing-provenance',
      meta: metaWithPaths([
        'meta.effectiveRange',
        'scenario.phases',
        'scenario.difficulties'
      ]),
      crossPartyReusePolicy: { rule: 'forbidden' },
      difficulties: Array.from({ length: 6 }, (_, index) => ({
        id: `difficulty-${index + 1}`,
        order: index + 1,
        name: entity(`difficulty.${index + 1}`, `难度 ${index + 1}`),
        modifiers: []
      })),
      phases: Array.from({ length: 3 }, (_, index) => ({
        phase: index + 1,
        encounterId: `encounter-${index + 1}`,
        boss: enemy,
        phaseModifiers: [],
        bossModifiers: []
      }))
    });

    expect(result.success).toBe(false);
  });

  it('rejects Theater metadata missing vigor coverage', () => {
    const result = imaginariumTheaterScenarioSchema.safeParse({
      mode: 'imaginarium-theater',
      id: 'theater.missing-provenance',
      meta: metaWithPaths([
        'meta.effectiveRange',
        'scenario.eligibility',
        'scenario.cast',
        'scenario.nodes'
      ]),
      eligibility: { elements: ['pyro'], minimumLevel: 70, requiredHeadcount: 10 },
      pools: { opening: [], trial: [], specialGuest: [], support: [] },
      vigor: { initial: 2, max: 4, actCosts: [] },
      acts: [
        {
          act: 1,
          encounters: [],
          pathNotes: []
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects a valid path that belongs to a different mode', () => {
    const result = spiralAbyssScenarioSchema.safeParse({
      ...spiralPayload,
      meta: metaWithPaths([
        'meta.effectiveRange',
        'scenario.floors',
        'scenario.blessing',
        'scenario.phases'
      ])
    });

    expect(result.success).toBe(false);
  });
});

describe('scenario v2 mode schemas', () => {
  it('rejects an Abyss scenario whose required blessing subtree is absent', () => {
    const withoutBlessing: Record<string, unknown> = { ...spiralPayload };
    delete withoutBlessing.blessing;

    expect(spiralAbyssScenarioSchema.safeParse(withoutBlessing).success).toBe(false);
  });

  it('accepts arbitrary configured Spiral Abyss floors with halves and waves', () => {
    const result = spiralAbyssScenarioSchema.safeParse({
      mode: 'spiral-abyss',
      id: 'abyss.2026-07',
      meta,
      blessing: { id: 'blessing.current', description: '本期渊月祝福' },
      floors: [
        {
          floor: 13,
          chambers: [
            {
              chamber: 1,
              firstHalf: { waves: [wave('13-1-a-1')] },
              secondHalf: { waves: [wave('13-1-b-1'), wave('13-1-b-2')] }
            }
          ]
        }
      ]
    });

    expect(result.success).toBe(true);
    expect(scenarioV2Schema.safeParse(result.data).success).toBe(true);
  });

  it('accepts Stygian Onslaught with three phases, six difficulties, and a data-owned reuse rule', () => {
    const result = stygianOnslaughtScenarioSchema.safeParse({
      mode: 'stygian-onslaught',
      id: 'stygian.2026-07',
      meta: stygianMeta,
      crossPartyReusePolicy: {
        rule: 'limited',
        maxPartyAppearancesPerCharacter: 2,
        notes: ['同一角色至多参与两场首领战']
      },
      difficulties: Array.from({ length: 6 }, (_, index) => ({
        id: `difficulty-${index + 1}`,
        order: index + 1,
        name: entity(`difficulty.${index + 1}`, `难度 ${index + 1}`),
        modifiers: [{ id: 'time-limit', description: '限时挑战' }]
      })),
      phases: Array.from({ length: 3 }, (_, index) => ({
        phase: index + 1,
        encounterId: `encounter-${index + 1}`,
        boss: {
          enemy: entity(`boss.${index + 1}`, `首领 ${index + 1}`),
          level: 110,
          count: 1,
          mechanics: { shields: [], resistances: [], immunities: [], tags: ['boss'] }
        },
        phaseModifiers: [{ id: 'phase-rule', description: '阶段规则' }],
        bossModifiers: [{ id: 'boss-rule', description: '首领强化' }]
      }))
    });

    expect(result.success).toBe(true);
    expect(scenarioV2Schema.safeParse(result.data).success).toBe(true);
  });

  it('accepts Imaginarium Theater eligibility, cast pools, vigor, and branching path notes', () => {
    const result = imaginariumTheaterScenarioSchema.safeParse({
      mode: 'imaginarium-theater',
      id: 'theater.2026-07',
      meta: theaterMeta,
      eligibility: {
        elements: ['pyro', 'hydro', 'anemo'],
        minimumLevel: 70,
        requiredHeadcount: 22
      },
      pools: {
        opening: [entity('character.opening', '开幕角色')],
        trial: [entity('character.trial', '试用角色')],
        specialGuest: [entity('character.guest', '特邀角色')],
        support: [entity('character.support', '助演角色')]
      },
      vigor: { initial: 2, max: 4, actCosts: [{ act: 1, cost: 1 }] },
      acts: [
        {
          act: 1,
          encounters: [{ id: 'act-1-battle', waves: [wave('act-1-wave-1')] }],
          pathNotes: [
            { kind: 'conditional', text: '若缺少治疗则优先恢复事件', condition: '无生存位' },
            { kind: 'random', text: '候选事件由本局随机生成' }
          ]
        }
      ],
      arcanaNodes: [
        { id: 'arcana-1', name: entity('arcana.1', '秘法节点'), description: '改变后续路线' }
      ]
    });

    expect(result.success).toBe(true);
    expect(scenarioV2Schema.safeParse(result.data).success).toBe(true);
  });

  it('rejects Stygian Onslaught unless it has exactly three phases', () => {
    const invalid = {
      mode: 'stygian-onslaught',
      id: 'stygian.invalid',
      meta: stygianMeta,
      crossPartyReusePolicy: { rule: 'forbidden' },
      difficulties: Array.from({ length: 6 }, (_, index) => ({
        id: `difficulty-${index + 1}`,
        order: index + 1,
        name: entity(`difficulty.${index + 1}`, `难度 ${index + 1}`),
        modifiers: []
      })),
      phases: [
        {
          phase: 1,
          encounterId: 'encounter-1',
          boss: enemy,
          phaseModifiers: [],
          bossModifiers: []
        },
        {
          phase: 2,
          encounterId: 'encounter-2',
          boss: enemy,
          phaseModifiers: [],
          bossModifiers: []
        }
      ]
    };

    expect(scenarioV2Schema.safeParse(invalid).success).toBe(false);
  });

  it('rejects Theater acts above the current act 10 ceiling', () => {
    const invalid = {
      mode: 'imaginarium-theater',
      id: 'theater.invalid',
      meta: theaterMeta,
      eligibility: { elements: ['pyro'], minimumLevel: 70, requiredHeadcount: 10 },
      pools: { opening: [], trial: [], specialGuest: [], support: [] },
      vigor: { initial: 2, max: 4, actCosts: [] },
      acts: [{ act: 11, encounters: [], pathNotes: [] }]
    };

    expect(imaginariumTheaterScenarioSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects metadata whose effective end precedes its start', () => {
    const result = spiralAbyssScenarioSchema.safeParse({
      mode: 'spiral-abyss',
      id: 'abyss.invalid-dates',
      meta: {
        ...meta,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z'
      },
      blessing: { id: 'blessing.current', description: '本期渊月祝福' },
      floors: []
    });

    expect(result.success).toBe(false);
  });
});

describe('scenario v2 recommendation plan schemas', () => {
  it('accepts an Abyss plan with two fixed non-overlapping teams and per-chamber tactics', () => {
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...commonPlan,
      firstHalfTeam: team('first', ['a', 'b', 'c', 'd']),
      secondHalfTeam: team('second', ['e', 'f', 'g', 'h']),
      chambers: [
        {
          floor: 12,
          chamber: 1,
          firstHalf: { tactics: ['先聚集第一波'], risks: ['注意冰抗'] },
          secondHalf: { tactics: ['保留爆发处理第二波'], substitutionNotes: [] }
        },
        {
          floor: 12,
          chamber: 2,
          firstHalf: { tactics: ['沿用固定上半队'] },
          secondHalf: { tactics: ['沿用固定下半队'] }
        }
      ]
    });

    expect(result.success).toBe(true);
    expect(recommendationPlanSchema.safeParse(result.data).success).toBe(true);
  });

  it('accepts a three-party Stygian plan with explicit reuse-policy acknowledgement', () => {
    const result = stygianPlanSchema.safeParse({
      mode: 'stygian-onslaught',
      ...commonPlan,
      reusePolicyAcknowledgement: 'limited',
      phases: [
        { phase: 1, team: team('phase-1', ['a', 'b', 'c', 'd']) },
        { phase: 2, team: team('phase-2', ['a', 'e', 'f', 'g']) },
        { phase: 3, team: team('phase-3', ['h', 'i', 'j', 'k']) }
      ]
    });

    expect(result.success).toBe(true);
    expect(recommendationPlanSchema.safeParse(result.data).success).toBe(true);
  });

  it('accepts a Theater cast and path plan instead of a fixed four-character team', () => {
    const result = theaterPlanSchema.safeParse({
      mode: 'imaginarium-theater',
      ...commonPlan,
      cast: {
        openingCharacterIds: ['a', 'b'],
        selectedCharacterIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        trialCharacterIds: ['c'],
        specialGuestCharacterIds: ['d'],
        supportCharacterIds: ['e']
      },
      acts: [
        {
          act: 1,
          candidateCharacterIds: ['a', 'b', 'c'],
          plannedVigorSpend: [{ characterId: 'a', cost: 1 }],
          pathChoice: { kind: 'conditional', note: '若出现精英战则保留主力' }
        }
      ]
    });

    expect(result.success).toBe(true);
    expect(recommendationPlanSchema.safeParse(result.data).success).toBe(true);
  });

  it('rejects an Abyss plan that reuses a character across chamber halves', () => {
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...commonPlan,
      firstHalfTeam: team('first', ['shared', 'b', 'c', 'd']),
      secondHalfTeam: team('second', ['shared', 'f', 'g', 'h']),
      chambers: [
        {
          floor: 12,
          chamber: 1,
          firstHalf: { tactics: ['处理上半'] },
          secondHalf: { tactics: ['处理下半'] }
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects legacy per-chamber roster keys that move a character across halves', () => {
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...commonPlan,
      firstHalfTeam: team('fixed-first', ['a', 'b', 'c', 'd']),
      secondHalfTeam: team('fixed-second', ['e', 'f', 'g', 'h']),
      chambers: [
        {
          floor: 12,
          chamber: 1,
          firstHalf: {
            tactics: ['处理上半'],
            roster: team('first-1', ['a', 'b', 'c', 'd'])
          },
          secondHalf: {
            tactics: ['处理下半'],
            roster: team('second-1', ['e', 'f', 'g', 'h'])
          }
        },
        {
          floor: 12,
          chamber: 2,
          firstHalf: {
            tactics: ['处理上半'],
            roster: team('first-2', ['i', 'j', 'k', 'l'])
          },
          secondHalf: {
            tactics: ['处理下半'],
            roster: team('second-2', ['a', 'm', 'n', 'o'])
          }
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects legacy per-chamber roster keys that change a fixed team', () => {
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...commonPlan,
      firstHalfTeam: team('fixed-first', ['a', 'b', 'c', 'd']),
      secondHalfTeam: team('fixed-second', ['e', 'f', 'g', 'h']),
      chambers: [
        {
          floor: 12,
          chamber: 1,
          firstHalf: {
            tactics: ['处理上半'],
            roster: team('first-1', ['a', 'b', 'c', 'd'])
          },
          secondHalf: {
            tactics: ['处理下半'],
            roster: team('second-1', ['e', 'f', 'g', 'h'])
          }
        },
        {
          floor: 12,
          chamber: 2,
          firstHalf: {
            tactics: ['处理上半'],
            roster: team('first-2', ['a', 'b', 'c', 'i'])
          },
          secondHalf: {
            tactics: ['处理下半'],
            roster: team('second-2', ['e', 'f', 'g', 'h'])
          }
        }
      ]
    });

    expect(result.success).toBe(false);
  });
});

describe('scenario and plan identity collections', () => {
  it('rejects duplicate Abyss floor numbers', () => {
    const floor = spiralPayload.floors[0];
    const result = spiralAbyssScenarioSchema.safeParse({
      ...spiralPayload,
      floors: [floor, floor]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate chamber numbers within an Abyss floor', () => {
    const chamber = spiralPayload.floors[0]?.chambers[0];
    const result = spiralAbyssScenarioSchema.safeParse({
      ...spiralPayload,
      floors: [{ floor: 12, chambers: [chamber, chamber] }]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate wave IDs within an Abyss half', () => {
    const duplicateWave = wave('duplicate-wave');
    const result = spiralAbyssScenarioSchema.safeParse({
      ...spiralPayload,
      floors: [
        {
          floor: 12,
          chambers: [
            {
              chamber: 1,
              firstHalf: { waves: [duplicateWave, duplicateWave] },
              secondHalf: { waves: [wave('unique-wave')] }
            }
          ]
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate floor and chamber coordinates in an Abyss plan', () => {
    const chamberPlan = {
      floor: 12,
      chamber: 1,
      firstHalf: { tactics: ['处理上半'] },
      secondHalf: { tactics: ['处理下半'] }
    };
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...commonPlan,
      firstHalfTeam: team('first', ['a', 'b', 'c', 'd']),
      secondHalfTeam: team('second', ['e', 'f', 'g', 'h']),
      chambers: [chamberPlan, chamberPlan]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Stygian difficulty IDs while preserving six ordered difficulties', () => {
    const result = stygianOnslaughtScenarioSchema.safeParse({
      mode: 'stygian-onslaught',
      id: 'stygian.duplicate-difficulty-id',
      meta: stygianMeta,
      crossPartyReusePolicy: { rule: 'forbidden' },
      difficulties: Array.from({ length: 6 }, (_, index) => ({
        id: index < 2 ? 'duplicate' : `difficulty-${index + 1}`,
        order: index + 1,
        name: entity(`difficulty.${index + 1}`, `难度 ${index + 1}`),
        modifiers: []
      })),
      phases: Array.from({ length: 3 }, (_, index) => ({
        phase: index + 1,
        encounterId: `encounter-${index + 1}`,
        boss: enemy,
        phaseModifiers: [],
        bossModifiers: []
      }))
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Stygian phase numbers', () => {
    const result = stygianOnslaughtScenarioSchema.safeParse({
      mode: 'stygian-onslaught',
      id: 'stygian.duplicate-phase',
      meta: stygianMeta,
      crossPartyReusePolicy: { rule: 'forbidden' },
      difficulties: Array.from({ length: 6 }, (_, index) => ({
        id: `difficulty-${index + 1}`,
        order: index + 1,
        name: entity(`difficulty.${index + 1}`, `难度 ${index + 1}`),
        modifiers: []
      })),
      phases: [1, 1, 2].map((phase, index) => ({
        phase,
        encounterId: `encounter-${index + 1}`,
        boss: enemy,
        phaseModifiers: [],
        bossModifiers: []
      }))
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Stygian encounter IDs', () => {
    const result = stygianOnslaughtScenarioSchema.safeParse({
      ...stygianPayload,
      phases: stygianPayload.phases.map((phase) => ({
        ...phase,
        encounterId: 'duplicate-encounter'
      }))
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate modifier IDs within a Stygian phase modifier collection', () => {
    const modifier = { id: 'duplicate-phase-rule', description: '重复阶段规则' };
    const result = stygianOnslaughtScenarioSchema.safeParse({
      ...stygianPayload,
      phases: stygianPayload.phases.map((phase, index) =>
        index === 0 ? { ...phase, phaseModifiers: [modifier, modifier] } : phase
      )
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate modifier IDs within a Stygian boss modifier collection', () => {
    const modifier = { id: 'duplicate-boss-rule', description: '重复首领规则' };
    const result = stygianOnslaughtScenarioSchema.safeParse({
      ...stygianPayload,
      phases: stygianPayload.phases.map((phase, index) =>
        index === 0 ? { ...phase, bossModifiers: [modifier, modifier] } : phase
      )
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate modifier IDs within a Stygian difficulty modifier collection', () => {
    const modifier = { id: 'duplicate-difficulty-rule', description: '重复难度规则' };
    const result = stygianOnslaughtScenarioSchema.safeParse({
      ...stygianPayload,
      difficulties: stygianPayload.difficulties.map((difficulty, index) =>
        index === 0 ? { ...difficulty, modifiers: [modifier, modifier] } : difficulty
      )
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Theater act numbers', () => {
    const act = {
      act: 1,
      encounters: [{ id: 'encounter-1', waves: [wave('theater-wave')] }],
      pathNotes: []
    };
    const result = imaginariumTheaterScenarioSchema.safeParse({
      mode: 'imaginarium-theater',
      id: 'theater.duplicate-acts',
      meta: theaterMeta,
      eligibility: { elements: ['pyro'], minimumLevel: 70, requiredHeadcount: 10 },
      pools: { opening: [], trial: [], specialGuest: [], support: [] },
      vigor: { initial: 2, max: 4, actCosts: [] },
      acts: [act, act]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Theater Arcana node IDs', () => {
    const arcana = {
      id: 'arcana-duplicate',
      name: entity('arcana.duplicate', '重复秘法'),
      description: '测试节点'
    };
    const result = imaginariumTheaterScenarioSchema.safeParse({
      mode: 'imaginarium-theater',
      id: 'theater.duplicate-arcana',
      meta: theaterMeta,
      eligibility: { elements: ['pyro'], minimumLevel: 70, requiredHeadcount: 10 },
      pools: { opening: [], trial: [], specialGuest: [], support: [] },
      vigor: { initial: 2, max: 4, actCosts: [] },
      acts: [
        {
          act: 1,
          encounters: [{ id: 'encounter-1', waves: [wave('theater-wave')] }],
          pathNotes: []
        }
      ],
      arcanaNodes: [arcana, arcana]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Theater vigor act-cost IDs', () => {
    const cost = { act: 1, cost: 1 };
    const result = imaginariumTheaterScenarioSchema.safeParse({
      ...theaterPayload,
      vigor: { ...theaterPayload.vigor, actCosts: [cost, cost] }
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Theater vigor node-cost IDs', () => {
    const cost = { nodeId: 'arcana-1', cost: 1 };
    const result = imaginariumTheaterScenarioSchema.safeParse({
      ...theaterPayload,
      vigor: { ...theaterPayload.vigor, nodeCosts: [cost, cost] }
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate character IDs within a Theater cast pool', () => {
    const duplicate = entity('character.duplicate', '重复角色');
    const result = imaginariumTheaterScenarioSchema.safeParse({
      ...theaterPayload,
      pools: { ...theaterPayload.pools, opening: [duplicate, duplicate] }
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate encounter IDs within a Theater act', () => {
    const encounter = { id: 'duplicate-encounter', waves: [wave('unique-wave')] };
    const result = imaginariumTheaterScenarioSchema.safeParse({
      ...theaterPayload,
      acts: [{ act: 1, encounters: [encounter, encounter], pathNotes: [] }]
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty Theater plan act list', () => {
    const result = theaterPlanSchema.safeParse({
      mode: 'imaginarium-theater',
      ...commonPlan,
      cast: {
        openingCharacterIds: ['a'],
        selectedCharacterIds: ['a'],
        trialCharacterIds: [],
        specialGuestCharacterIds: [],
        supportCharacterIds: []
      },
      acts: []
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate act numbers in a Theater plan', () => {
    const act = {
      act: 1,
      candidateCharacterIds: ['a'],
      plannedVigorSpend: [],
      pathChoice: { kind: 'fixed', note: '按固定路线推进' }
    };
    const result = theaterPlanSchema.safeParse({
      mode: 'imaginarium-theater',
      ...commonPlan,
      cast: {
        openingCharacterIds: ['a'],
        selectedCharacterIds: ['a'],
        trialCharacterIds: [],
        specialGuestCharacterIds: [],
        supportCharacterIds: []
      },
      acts: [act, act]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate candidate character IDs in a Theater plan act', () => {
    const result = theaterPlanSchema.safeParse({
      mode: 'imaginarium-theater',
      ...commonPlan,
      cast: {
        openingCharacterIds: ['a'],
        selectedCharacterIds: ['a'],
        trialCharacterIds: [],
        specialGuestCharacterIds: [],
        supportCharacterIds: []
      },
      acts: [
        {
          act: 1,
          candidateCharacterIds: ['a', 'a'],
          plannedVigorSpend: [],
          pathChoice: { kind: 'fixed', note: '按固定路线推进' }
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate planned vigor-spend character IDs in a Theater plan act', () => {
    const spend = { characterId: 'a', cost: 1 };
    const result = theaterPlanSchema.safeParse({
      mode: 'imaginarium-theater',
      ...commonPlan,
      cast: {
        openingCharacterIds: ['a'],
        selectedCharacterIds: ['a'],
        trialCharacterIds: [],
        specialGuestCharacterIds: [],
        supportCharacterIds: []
      },
      acts: [
        {
          act: 1,
          candidateCharacterIds: ['a'],
          plannedVigorSpend: [spend, spend],
          pathChoice: { kind: 'fixed', note: '按固定路线推进' }
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate character IDs within a Theater plan cast collection', () => {
    const result = theaterPlanSchema.safeParse({
      mode: 'imaginarium-theater',
      ...commonPlan,
      cast: {
        openingCharacterIds: ['a'],
        selectedCharacterIds: ['a', 'a'],
        trialCharacterIds: [],
        specialGuestCharacterIds: [],
        supportCharacterIds: []
      },
      acts: [
        {
          act: 1,
          candidateCharacterIds: ['a'],
          plannedVigorSpend: [],
          pathChoice: { kind: 'fixed', note: '按固定路线推进' }
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects recommendation plans without their own schema version', () => {
    const unversionedCommonPlan: Record<string, unknown> = { ...commonPlan };
    delete unversionedCommonPlan.schemaVersion;
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...unversionedCommonPlan,
      firstHalfTeam: team('first', ['a', 'b', 'c', 'd']),
      secondHalfTeam: team('second', ['e', 'f', 'g', 'h']),
      chambers: [
        {
          floor: 12,
          chamber: 1,
          firstHalf: { tactics: ['处理上半'] },
          secondHalf: { tactics: ['处理下半'] }
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown recommendation plan keys', () => {
    const result = abyssPlanSchema.safeParse({
      mode: 'spiral-abyss',
      ...commonPlan,
      firstHalfTeam: team('first', ['a', 'b', 'c', 'd']),
      secondHalfTeam: team('second', ['e', 'f', 'g', 'h']),
      chambers: [
        {
          floor: 12,
          chamber: 1,
          firstHalf: { tactics: ['处理上半'] },
          secondHalf: { tactics: ['处理下半'] }
        }
      ],
      producerDrift: true
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate character IDs within lock or exclude collections', () => {
    const result = playerInterventionSchema.safeParse({
      lockedCharacterIds: ['character.raiden', 'character.raiden'],
      excludedCharacterIds: [],
      target: { mode: 'spiral-abyss', floor: 12 },
      preferences: {
        comfort: 'medium',
        survival: 'high',
        lowInvestment: 'low',
        noBuildChange: false
      }
    });

    expect(result.success).toBe(false);
  });
});

describe('structured player intervention', () => {
  it('rejects overlapping locked and excluded characters', () => {
    const result = playerInterventionSchema.safeParse({
      lockedCharacterIds: ['character.raiden'],
      excludedCharacterIds: ['character.raiden'],
      target: { mode: 'spiral-abyss', floor: 12, chamber: 3 },
      preferences: {
        comfort: 'high',
        survival: 'high',
        lowInvestment: 'medium',
        noBuildChange: true
      }
    });

    expect(result.success).toBe(false);
  });
});

describe('recursive external payload strictness', () => {
  it('rejects an unknown key nested inside scenario mechanics', () => {
    const result = spiralAbyssScenarioSchema.safeParse({
      ...spiralPayload,
      floors: [
        {
          floor: 12,
          chambers: [
            {
              chamber: 1,
              firstHalf: {
                waves: [
                  {
                    id: 'strict-wave-a',
                    enemies: [
                      {
                        ...enemy,
                        mechanics: { ...enemy.mechanics, producerDrift: true }
                      }
                    ]
                  }
                ]
              },
              secondHalf: { waves: [wave('strict-wave-b')] }
            }
          ]
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown key nested inside a recommendation plan cast', () => {
    const result = theaterPlanSchema.safeParse({
      mode: 'imaginarium-theater',
      ...commonPlan,
      cast: {
        openingCharacterIds: ['a'],
        selectedCharacterIds: ['a'],
        trialCharacterIds: [],
        specialGuestCharacterIds: [],
        supportCharacterIds: [],
        producerDrift: true
      },
      acts: [
        {
          act: 1,
          candidateCharacterIds: ['a'],
          plannedVigorSpend: [],
          pathChoice: { kind: 'fixed', note: '按固定路线推进' }
        }
      ]
    });

    expect(result.success).toBe(false);
  });
});
