import type { PersistedProfile } from '../../shared/domain.js';
import { z } from 'zod';
import {
  ALL_CHARACTER_KNOWLEDGE_FIELDS,
  type CharacterKnowledgeReader
} from '../../shared/character-knowledge.js';
import { buildAdvisorProfileView, toAdvisorCharacter } from './advisor-profile-serializer.js';
import {
  AgentPayloadTooLargeError,
  stringifyAgentPayload
} from './agent-payload-budget.js';

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

export const profileCacheToolInput = {
  uid: z.string().regex(/^\d{9}$/),
  characterIds: z
    .array(z.string().regex(/^[1-9]\d*$/))
    .min(1)
    .max(32)
    .optional(),
  cursor: z.number().int().nonnegative().optional(),
  pageSize: z.number().int().min(1).max(100).optional()
};

export interface ProfileCacheToolQuery {
  characterIds?: string[];
  cursor?: number;
  pageSize?: number;
}

export function profileCacheView(profile: PersistedProfile, query: ProfileCacheToolQuery) {
  const sortedCharacters = profile.characters.slice().sort((left, right) => left.id - right.id);
  if (query.characterIds) {
    const requestedCharacterIds = [...new Set(query.characterIds)].sort(
      (left, right) => Number(left) - Number(right)
    );
    const byId = new Map<string, (typeof sortedCharacters)[number]>();
    sortedCharacters.forEach((character) => {
      const id = String(character.id);
      if (!byId.has(id)) byId.set(id, character);
    });
    const selected = requestedCharacterIds.flatMap((id) => {
      const character = byId.get(id);
      return character ? [character] : [];
    });
    const view = buildAdvisorProfileView(
      { ...profile, characters: selected },
      Math.max(1, selected.length)
    );
    const found = new Set(selected.map(({ id }) => String(id)));
    return boundedProfileResponse({
      kind: 'details' as const,
      coverage: view.coverage,
      requestedCharacterIds,
      missingCharacterIds: requestedCharacterIds.filter((id) => !found.has(id)),
      provenanceSummaries: view.provenanceSummaries,
      characters: view.characters
    });
  }
  const cursor = Math.min(query.cursor ?? 0, sortedCharacters.length);
  const pageSize = query.pageSize ?? 100;
  const characters = sortedCharacters.slice(cursor, cursor + pageSize).map((character) => {
    const { id, name, element, rarity, level, completeness, missingFields } =
      toAdvisorCharacter(character);
    return {
      id,
      name,
      element,
      rarity,
      ...(level === undefined ? {} : { level }),
      completeness,
      ...(missingFields === undefined ? {} : { missingFields })
    };
  });
  const next = cursor + characters.length;
  return boundedProfileResponse({
    kind: 'index-page' as const,
    coverage: profile.coverage,
    total: sortedCharacters.length,
    cursor,
    pageSize,
    ...(next < sortedCharacters.length ? { nextCursor: next } : {}),
    characters
  });
}

function boundedProfileResponse<T>(value: T): T {
  stringifyAgentPayload(value, 'profile-tool-result');
  return value;
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
  return {
    content: [{ type: 'text' as const, text: stringifyAgentPayload(value, 'business-tool-result') }]
  };
}

export function errorToolResult(error: unknown) {
  const payload =
    error instanceof AgentPayloadTooLargeError
      ? { error: error.toDescriptor() }
      : { error: error instanceof Error ? error.message : 'Tool request failed' };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError: true
  };
}
