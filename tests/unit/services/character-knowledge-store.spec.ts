import { describe, expect, it } from 'vitest';

import {
  CharacterKnowledgeStore,
  characterKnowledgeBundleSchema
} from '../../../src/main/services/character-knowledge-store.js';

const bundle = {
  schemaVersion: 1,
  knowledgeVersion: '2026.07.seed-1',
  updatedAt: '2026-07-23T00:00:00.000Z',
  coverage: {
    characterCount: 2,
    notes: '测试知识只覆盖两个角色。'
  },
  characters: [
    {
      id: '1001',
      name: '测试治疗弓手',
      weaponType: 'bow',
      roles: ['support'],
      energyCost: 60,
      energyNeeds: 'medium',
      capabilities: ['healing', 'off-field'],
      applicationNotes: ['可在后台提供恢复。'],
      kitNotes: ['这里只记录机制标签，不推断伤害。'],
      unknownFields: []
    },
    {
      id: '1002',
      name: '测试大剑角色',
      weaponType: 'claymore',
      roles: ['on-field'],
      capabilities: ['onslaught'],
      applicationNotes: [],
      kitNotes: [],
      unknownFields: ['energyCost', 'energyNeeds']
    }
  ]
} as const;

describe('CharacterKnowledgeStore', () => {
  it('strictly loads a versioned bundle and returns bounded known knowledge', () => {
    const store = CharacterKnowledgeStore.fromUnknown(bundle);

    expect(store.version).toBe('2026.07.seed-1');
    expect(store.coverage).toEqual({ characterCount: 2, notes: '测试知识只覆盖两个角色。' });
    expect(store.lookup('1001')).toMatchObject({
      status: 'known',
      weaponType: 'bow',
      roles: ['support'],
      energyCost: 60,
      energyNeeds: 'medium',
      capabilities: ['healing', 'off-field'],
      unknownFields: []
    });
  });

  it('returns an explicit unknown record without inventing fields', () => {
    const store = CharacterKnowledgeStore.fromUnknown(bundle);

    expect(store.lookup('9999')).toEqual({
      status: 'unknown',
      id: '9999',
      knowledgeVersion: '2026.07.seed-1',
      unknownFields: [
        'weaponType',
        'roles',
        'energyCost',
        'energyNeeds',
        'capabilities',
        'applicationNotes',
        'kitNotes'
      ]
    });
  });

  it('rejects version drift, duplicate ids, unsafe bounds, and missing unknown declarations', () => {
    expect(characterKnowledgeBundleSchema.safeParse({ ...bundle, schemaVersion: 2 }).success).toBe(
      false
    );
    expect(
      characterKnowledgeBundleSchema.safeParse({
        ...bundle,
        characters: [bundle.characters[0], bundle.characters[0]]
      }).success
    ).toBe(false);
    expect(
      characterKnowledgeBundleSchema.safeParse({
        ...bundle,
        characters: [{ ...bundle.characters[0], energyCost: 999 }]
      }).success
    ).toBe(false);
    expect(
      characterKnowledgeBundleSchema.safeParse({
        ...bundle,
        characters: [
          {
            ...bundle.characters[1],
            unknownFields: [],
            energyCost: undefined,
            energyNeeds: undefined
          }
        ],
        coverage: { ...bundle.coverage, characterCount: 1 }
      }).success
    ).toBe(false);
  });

  it('reports exact target coverage without exposing unrelated records', () => {
    const store = CharacterKnowledgeStore.fromUnknown(bundle);
    expect(store.coverageFor(['1001', '1002', '9999'])).toEqual({
      knowledgeVersion: '2026.07.seed-1',
      requested: 3,
      known: 2,
      unknownCharacterIds: ['9999']
    });
  });
});
