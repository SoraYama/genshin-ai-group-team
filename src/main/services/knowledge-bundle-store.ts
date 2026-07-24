import { readFile as nodeReadFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  AdvisorKnowledgeCoverage,
  AdvisorKnowledgeReader,
  CharacterStrategyResult,
  CommittedBuildArchetypeV2,
  CommittedCharacterCatalogEntry,
  CommittedSourceRegistry
} from '../../shared/advisor-knowledge.js';
import { committedAdvisorKnowledgeSetSchema } from './committed-advisor-knowledge.js';

type ReadFile = (filePath: string, encoding: 'utf8') => Promise<string>;
type CommittedCitation = CommittedSourceRegistry['citations'][number];

const COMMITTED_FILE_NAMES = {
  sources: 'sources.v1.json',
  catalog: 'character-catalog.v1.json',
  strategies: 'character-strategies.v2.json',
  evidence: 'review-evidence.v1.json'
} as const;

type KnowledgeBundleFileName = (typeof COMMITTED_FILE_NAMES)[keyof typeof COMMITTED_FILE_NAMES];

export class KnowledgeBundleLoadError extends Error {
  override readonly name = 'KnowledgeBundleLoadError';

  constructor(
    readonly stage: 'read' | 'parse' | 'validation',
    readonly fileName: KnowledgeBundleFileName | undefined
  ) {
    super(
      stage === 'validation'
        ? 'Trusted knowledge bundle validation failed'
        : `${stage === 'read' ? 'Unable to read' : 'Malformed JSON in'} trusted knowledge file ${
            fileName ?? 'unknown'
          }`
    );
  }
}

export class KnowledgeBundleStore implements AdvisorKnowledgeReader {
  private readonly catalogById: ReadonlyMap<string, CommittedCharacterCatalogEntry>;
  private readonly strategiesById: ReadonlyMap<
    string,
    ReturnType<typeof committedAdvisorKnowledgeSetSchema.parse>['strategies']['characters'][number]
  >;
  private readonly citationsById: ReadonlyMap<string, CommittedCitation>;
  private readonly sourcesById: ReadonlyMap<
    string,
    ReturnType<typeof committedAdvisorKnowledgeSetSchema.parse>['sources']['sources'][number]
  >;

  private constructor(
    private readonly bundle: ReturnType<typeof committedAdvisorKnowledgeSetSchema.parse>
  ) {
    this.catalogById = new Map(bundle.catalog.characters.map((entry) => [entry.id, entry]));
    this.strategiesById = new Map(
      bundle.strategies.characters.map((strategy) => [strategy.id, strategy])
    );
    this.citationsById = new Map(
      bundle.sources.citations.map((citation) => [citation.id, citation])
    );
    this.sourcesById = new Map(bundle.sources.sources.map((source) => [source.id, source]));
  }

  static fromUnknown(input: unknown): KnowledgeBundleStore {
    return new KnowledgeBundleStore(committedAdvisorKnowledgeSetSchema.parse(input));
  }

  static async load(
    directory: string,
    readFile: ReadFile = nodeReadFile
  ): Promise<KnowledgeBundleStore> {
    const entries = await Promise.all(
      Object.entries(COMMITTED_FILE_NAMES).map(async ([key, fileName]) => {
        let serialized: string;
        try {
          serialized = await readFile(resolve(directory, fileName), 'utf8');
        } catch {
          throw new KnowledgeBundleLoadError('read', fileName);
        }

        try {
          return [key, JSON.parse(serialized) as unknown];
        } catch {
          throw new KnowledgeBundleLoadError('parse', fileName);
        }
      })
    );
    try {
      return KnowledgeBundleStore.fromUnknown(Object.fromEntries(entries));
    } catch {
      throw new KnowledgeBundleLoadError('validation', undefined);
    }
  }

  get version(): string {
    return this.bundle.strategies.knowledgeVersion;
  }

  get catalogVersion(): string {
    return this.bundle.catalog.catalogVersion;
  }

  getCatalogEntry(characterId: string): CommittedCharacterCatalogEntry | undefined {
    const entry = this.catalogById.get(characterId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  getCharacterStrategy(characterId: string): CharacterStrategyResult {
    const strategy = this.strategiesById.get(characterId);
    if (strategy === undefined) {
      return {
        status: 'unknown',
        characterId,
        knowledgeVersion: this.version
      };
    }
    return {
      status: strategy.reviewState === 'reviewed' ? 'reviewed' : 'gap',
      characterId,
      knowledgeVersion: this.version,
      strategy: structuredClone(strategy)
    };
  }

  getArchetype(characterId: string, archetypeId: string): CommittedBuildArchetypeV2 | undefined {
    const archetype = this.strategiesById
      .get(characterId)
      ?.archetypes.find(({ id }) => id === archetypeId);
    return archetype === undefined ? undefined : structuredClone(archetype);
  }

  citations(ids: readonly string[]): CommittedCitation[] {
    const requestedIds = new Set(ids);
    return Array.from(requestedIds).flatMap((id) => {
      const citation = this.citationsById.get(id);
      return citation === undefined ? [] : [structuredClone(citation)];
    });
  }

  coverageFor(input: { characterIds: readonly string[]; now: Date }): AdvisorKnowledgeCoverage {
    const requestedCharacterIds = Array.from(new Set(input.characterIds));
    const trustedCharacterIds = requestedCharacterIds.filter((characterId) => {
      const strategy = this.strategiesById.get(characterId);
      return (
        strategy?.reviewState === 'reviewed' && this.isWithinReviewCadence(strategy, input.now)
      );
    });
    const trusted = new Set(trustedCharacterIds);
    return {
      knowledgeVersion: this.version,
      catalogVersion: this.catalogVersion,
      requestedCharacterIds,
      trustedCharacterIds,
      unknownCharacterIds: requestedCharacterIds.filter((characterId) => !trusted.has(characterId))
    };
  }

  private isWithinReviewCadence(
    strategy: ReturnType<
      typeof committedAdvisorKnowledgeSetSchema.parse
    >['strategies']['characters'][number],
    now: Date
  ): boolean {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) return false;
    const citationIds = new Set(
      strategy.archetypes.flatMap(({ facts }) => facts.flatMap(({ citationIds }) => citationIds))
    );
    return Array.from(citationIds).every((citationId) => {
      const citation = this.citationsById.get(citationId);
      const source = citation === undefined ? undefined : this.sourcesById.get(citation.sourceId);
      if (citation === undefined || source === undefined) return false;
      const reviewedAtMs = Date.parse(citation.reviewedAt);
      const expiresAtMs = reviewedAtMs + source.reviewCadenceDays * 24 * 60 * 60 * 1_000;
      return Number.isFinite(reviewedAtMs) && reviewedAtMs <= nowMs && nowMs <= expiresAtMs;
    });
  }
}
