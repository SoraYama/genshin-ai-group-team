import type { PersistedProfile } from '../../shared/domain.js';
import {
  ALL_CHARACTER_KNOWLEDGE_FIELDS,
  type CharacterKnowledgeReader
} from '../../shared/character-knowledge.js';
import { buildAdvisorProfileView } from './advisor-profile-serializer.js';

export const UNKNOWN_CHARACTER_KNOWLEDGE: CharacterKnowledgeReader = {
  version: 'unavailable',
  coverage: { characterCount: 0, notes: '角色知识资料不可用。' },
  lookup: (id) => ({
    status: 'unknown',
    id,
    knowledgeVersion: 'unavailable',
    unknownFields: [...ALL_CHARACTER_KNOWLEDGE_FIELDS]
  }),
  coverageFor: (characterIds) => ({
    knowledgeVersion: 'unavailable',
    requested: new Set(characterIds).size,
    known: 0,
    unknownCharacterIds: Array.from(new Set(characterIds))
  })
};

export function redactedProfileView(profile: PersistedProfile, maxCharacters: number) {
  return buildAdvisorProfileView(profile, maxCharacters);
}

export function characterKnowledgeView(
  knowledge: CharacterKnowledgeReader,
  characterIds: string[]
) {
  return {
    knowledgeVersion: knowledge.version,
    coverage: knowledge.coverageFor(characterIds),
    characters: characterIds.map((id) => knowledge.lookup(id))
  };
}

export function textToolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function errorToolResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true
  };
}
