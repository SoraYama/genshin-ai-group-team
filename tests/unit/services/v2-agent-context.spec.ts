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
    expect(context.knowledge.unknownCharacterIds).toHaveLength(2);
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
        knowledge: { version: 'knowledge-v1', unknownCharacterIds: [] }
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
      knowledge: { version: 'knowledge-v1', unknownCharacterIds: [] }
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
        knowledge: { version: 'knowledge-v1', unknownCharacterIds: [] }
      })
    ).toThrow(expect.objectContaining({ name: 'V2ContextBudgetError' }));
  });
});
