import { readFile as nodeReadFile } from 'node:fs/promises';

import {
  ALL_CHARACTER_KNOWLEDGE_FIELDS,
  characterKnowledgeBundleSchema,
  type CharacterKnowledgeBundle,
  type CharacterKnowledgeLookup,
  type CharacterKnowledgeReader
} from '../../shared/character-knowledge.js';

export { characterKnowledgeBundleSchema } from '../../shared/character-knowledge.js';

export class CharacterKnowledgeStore implements CharacterKnowledgeReader {
  private readonly byId: ReadonlyMap<string, CharacterKnowledgeBundle['characters'][number]>;

  private constructor(private readonly bundle: CharacterKnowledgeBundle) {
    this.byId = new Map(bundle.characters.map((entry) => [entry.id, entry]));
  }

  static fromUnknown(input: unknown): CharacterKnowledgeStore {
    return new CharacterKnowledgeStore(characterKnowledgeBundleSchema.parse(input));
  }

  static async load(
    filePath: string,
    readFile: (filePath: string, encoding: 'utf8') => Promise<string> = nodeReadFile
  ): Promise<CharacterKnowledgeStore> {
    return CharacterKnowledgeStore.fromUnknown(JSON.parse(await readFile(filePath, 'utf8')));
  }

  get version(): string {
    return this.bundle.knowledgeVersion;
  }

  get coverage(): CharacterKnowledgeBundle['coverage'] {
    return { ...this.bundle.coverage };
  }

  lookup(characterId: string): CharacterKnowledgeLookup {
    const known = this.byId.get(characterId);
    if (!known) {
      return {
        status: 'unknown',
        id: characterId,
        knowledgeVersion: this.version,
        unknownFields: [...ALL_CHARACTER_KNOWLEDGE_FIELDS]
      };
    }
    return structuredClone({ status: 'known' as const, knowledgeVersion: this.version, ...known });
  }

  coverageFor(characterIds: string[]) {
    const ids = Array.from(new Set(characterIds));
    const unknownCharacterIds = ids.filter((id) => !this.byId.has(id));
    return {
      knowledgeVersion: this.version,
      requested: ids.length,
      known: ids.length - unknownCharacterIds.length,
      unknownCharacterIds
    };
  }
}
