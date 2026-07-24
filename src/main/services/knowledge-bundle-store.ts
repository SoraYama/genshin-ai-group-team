import { readFile as nodeReadFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  AdvisorKnowledgeCoverage,
  AdvisorKnowledgeReader,
  CharacterStrategyResult,
  CommittedBuildArchetypeV2,
  CommittedCharacterCatalogEntry,
  CommittedSourceRegistry,
  EnemyMechanicStrategy
} from '../../shared/advisor-knowledge.js';
import { committedAdvisorKnowledgeSetSchema } from './committed-advisor-knowledge.js';

type ReadFile = (filePath: string, encoding: 'utf8') => Promise<string>;
type CommittedCitation = CommittedSourceRegistry['citations'][number];

const COMMITTED_FILE_NAMES = {
  sources: 'sources.v1.json',
  catalog: 'character-catalog.v1.json',
  strategies: 'character-strategies.v2.json',
  mechanics: 'enemy-mechanic-strategies.v1.json',
  evidence: 'review-evidence.v1.json'
} as const;

type KnowledgeBundleFileName = (typeof COMMITTED_FILE_NAMES)[keyof typeof COMMITTED_FILE_NAMES];

export interface MechanicConflict {
  mechanicId: string;
  matchTags: string[];
  avoidTags: string[];
}

export interface MechanicAnalysis {
  matched: EnemyMechanicStrategy[];
  recognizedNeutralTags: string[];
  conflicts: MechanicConflict[];
  unknownTags: string[];
}

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
  private readonly mechanicsById: ReadonlyMap<string, EnemyMechanicStrategy>;
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
    this.mechanicsById = new Map(
      bundle.mechanics.mechanics.map((mechanic) => [mechanic.id, mechanic])
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

  getMechanicStrategy(mechanicId: string): EnemyMechanicStrategy | undefined {
    const mechanic = this.mechanicsById.get(mechanicId);
    return mechanic === undefined ? undefined : structuredClone(mechanic);
  }

  matchMechanics(tags: readonly string[]): EnemyMechanicStrategy[] {
    return this.analyzeMechanics(tags).matched;
  }

  analyzeMechanics(tags: readonly string[]): MechanicAnalysis {
    const requestedTags = new Set(tags);
    const matched: EnemyMechanicStrategy[] = [];
    const conflicts: MechanicConflict[] = [];
    const recognizedTags = new Set<string>();
    const consumedTags = new Set<string>();

    for (const mechanic of this.bundle.mechanics.mechanics) {
      mechanic.matchTags.forEach((tag) => recognizedTags.add(tag));
      mechanic.avoidTags.forEach((tag) => recognizedTags.add(tag));
      const matchTags = mechanic.matchTags.filter((tag) => requestedTags.has(tag));
      const avoidTags = mechanic.avoidTags.filter((tag) => requestedTags.has(tag));
      if (matchTags.length > 0 && avoidTags.length > 0) {
        matchTags.forEach((tag) => consumedTags.add(tag));
        avoidTags.forEach((tag) => consumedTags.add(tag));
        conflicts.push({ mechanicId: mechanic.id, matchTags, avoidTags });
      } else if (matchTags.length > 0) {
        matchTags.forEach((tag) => consumedTags.add(tag));
        matched.push(structuredClone(mechanic));
      }
    }

    const uniqueTags = Array.from(requestedTags);
    return {
      matched,
      recognizedNeutralTags: uniqueTags.filter(
        (tag) => recognizedTags.has(tag) && !consumedTags.has(tag)
      ),
      conflicts,
      unknownTags: uniqueTags.filter((tag) => !recognizedTags.has(tag))
    };
  }

  mechanicCoverageFor(input: { mechanicIds: readonly string[]; now: Date }): {
    requestedMechanicIds: string[];
    trustedMechanicIds: string[];
    unknownMechanicIds: string[];
  } {
    const requestedMechanicIds = Array.from(new Set(input.mechanicIds));
    const trustedMechanicIds = requestedMechanicIds.filter((mechanicId) => {
      const mechanic = this.mechanicsById.get(mechanicId);
      return (
        mechanic !== undefined &&
        this.areCitationsWithinReviewCadence(
          mechanic.facts.flatMap(({ citationIds }) => citationIds),
          input.now
        )
      );
    });
    const trusted = new Set(trustedMechanicIds);
    return {
      requestedMechanicIds,
      trustedMechanicIds,
      unknownMechanicIds: requestedMechanicIds.filter((mechanicId) => !trusted.has(mechanicId))
    };
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
    return this.areCitationsWithinReviewCadence(
      strategy.archetypes.flatMap(({ facts }) => facts.flatMap(({ citationIds }) => citationIds)),
      now
    );
  }

  private areCitationsWithinReviewCadence(citationIds: readonly string[], now: Date): boolean {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) return false;
    const uniqueCitationIds = new Set(citationIds);
    if (uniqueCitationIds.size === 0) return false;
    return Array.from(uniqueCitationIds).every((citationId) => {
      const citation = this.citationsById.get(citationId);
      const source = citation === undefined ? undefined : this.sourcesById.get(citation.sourceId);
      if (citation === undefined || source === undefined) return false;
      const reviewedAtMs = Date.parse(citation.reviewedAt);
      const expiresAtMs = reviewedAtMs + source.reviewCadenceDays * 24 * 60 * 60 * 1_000;
      return Number.isFinite(reviewedAtMs) && reviewedAtMs <= nowMs && nowMs <= expiresAtMs;
    });
  }
}
