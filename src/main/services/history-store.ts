import { randomUUID } from 'node:crypto';
import Store from 'electron-store';
import { z } from 'zod';
import type {
  AbyssPlanHistoryEntry,
  StygianPlanHistoryEntry,
  HistoryQueryOptions,
  HistoryQueryResult,
  RecommendationHistoryEntry
} from '../../shared/domain.js';
import {
  canonicalCharacterIdSchema,
  stygianAdvisorPlanSchema,
  stygianRewardTargetSchema
} from '../../shared/stygian-advisor.js';
import { crossPartyReusePolicySchema, playerPreferencesSchema } from '../../shared/scenario-v2.js';

interface HistoryStoreSchema {
  entries: RecommendationHistoryEntry[];
  abyssPlans: AbyssPlanHistoryEntry[];
  stygianPlans: StygianPlanHistoryEntry[];
}

const MAX_ENTRIES = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const DEFAULTS: HistoryStoreSchema = {
  entries: [],
  abyssPlans: [],
  stygianPlans: []
};

const stygianHistoryEntrySchema = z
  .object({
    id: z.string().trim().min(8),
    createdAt: z.iso.datetime({ offset: true }),
    uid: z.string().regex(/^\d{9}$/),
    scenarioId: z.string().trim().min(1),
    schemaVersion: z.literal(2),
    dataVersion: z.string().trim().min(1),
    mode: z.literal('stygian-onslaught'),
    difficultyId: z.string().trim().min(1),
    difficultyName: z.string().trim().min(1),
    phase: z.number().int().min(1).max(3).optional(),
    target: stygianRewardTargetSchema,
    reusePolicy: crossPartyReusePolicySchema,
    source: z.enum(['smart-service', 'local-rules']),
    scenarioTrust: z.enum(['production', 'development-sample']),
    scenarioFreshness: z.enum(['fresh', 'expiring', 'stale', 'unknown']),
    scenarioNotCurrent: z.boolean(),
    interventions: z
      .object({
        lockedCharacterIds: z.array(canonicalCharacterIdSchema),
        excludedCharacterIds: z.array(canonicalCharacterIdSchema),
        target: stygianRewardTargetSchema,
        difficultyId: z.string().trim().min(1),
        preferences: playerPreferencesSchema
      })
      .strict(),
    characters: z
      .array(
        z
          .object({
            id: canonicalCharacterIdSchema,
            name: z.string().trim().min(1),
            element: z.string().trim().min(1),
            level: z.number().int().nonnegative().optional()
          })
          .strict()
      )
      .min(1),
    plan: stygianAdvisorPlanSchema
  })
  .strict()
  .superRefine((entry, context) => {
    const characterIds = entry.characters.map(({ id }) => id);
    const plannedTeams = entry.plan.phases.map(({ team }) => team.characterIds);
    const plannedIds = plannedTeams.flat();
    const plannedUniqueIds = new Set(plannedIds);
    if (new Set(characterIds).size !== characterIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'History character IDs must be unique',
        path: ['characters']
      });
    }
    const names = new Set(characterIds);
    const missingNames = plannedIds.filter((id) => !names.has(id));
    if (missingNames.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Every planned character requires a stored display name',
        path: ['characters']
      });
    }
    if (characterIds.some((id) => !plannedUniqueIds.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'History character snapshots must match the planned roster exactly',
        path: ['characters']
      });
    }
    plannedTeams.forEach((ids, index) => {
      if (ids.length !== 4 || new Set(ids).size !== 4) {
        context.addIssue({
          code: 'custom',
          message: 'Every stored Stygian team must contain four unique characters',
          path: ['plan', 'phases', index, 'team', 'characterIds']
        });
      }
    });
    if (
      entry.plan.scenarioId !== entry.scenarioId ||
      entry.plan.dataVersion !== entry.dataVersion
    ) {
      context.addIssue({
        code: 'custom',
        message: 'History plan identity must match its envelope',
        path: ['plan']
      });
    }
    if (entry.plan.reusePolicyAcknowledgement !== entry.reusePolicy.rule) {
      context.addIssue({
        code: 'custom',
        message: 'History reuse acknowledgement must match its envelope',
        path: ['reusePolicy']
      });
    }
    const appearances = new Map<string, number>();
    plannedTeams.forEach((ids) => {
      new Set(ids).forEach((id) => appearances.set(id, (appearances.get(id) ?? 0) + 1));
    });
    const maximumAppearances =
      entry.reusePolicy.rule === 'forbidden'
        ? 1
        : entry.reusePolicy.rule === 'limited'
          ? entry.reusePolicy.maxPartyAppearancesPerCharacter
          : 3;
    if ([...appearances.values()].some((count) => count > maximumAppearances)) {
      context.addIssue({
        code: 'custom',
        message: 'Stored team appearances violate the recorded reuse policy',
        path: ['plan', 'phases']
      });
    }
    const excluded = new Set(entry.interventions.excludedCharacterIds);
    if (entry.interventions.lockedCharacterIds.some((id) => excluded.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'History interventions cannot lock and exclude the same character',
        path: ['interventions']
      });
    }
    if (entry.interventions.lockedCharacterIds.some((id) => !plannedUniqueIds.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'Every stored locked character must appear in the plan',
        path: ['interventions', 'lockedCharacterIds']
      });
    }
    if (entry.interventions.excludedCharacterIds.some((id) => plannedUniqueIds.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'Stored excluded characters cannot appear in the plan',
        path: ['interventions', 'excludedCharacterIds']
      });
    }
    if (
      entry.interventions.target !== entry.target ||
      entry.interventions.difficultyId !== entry.difficultyId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Stored intervention target must match the history envelope',
        path: ['interventions']
      });
    }
  });

export class HistoryStore {
  private readonly store: Store<HistoryStoreSchema>;

  constructor() {
    this.store = new Store<HistoryStoreSchema>({
      name: 'history',
      defaults: DEFAULTS
    });
    this.migrateAbyssPlans();
  }

  append(input: Omit<RecommendationHistoryEntry, 'id' | 'createdAt'>): RecommendationHistoryEntry {
    const entry: RecommendationHistoryEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };

    const next = [entry, ...this.store.get('entries')].slice(0, MAX_ENTRIES);
    this.store.set('entries', next);
    return entry;
  }

  appendAbyss(input: Omit<AbyssPlanHistoryEntry, 'id' | 'createdAt'>): AbyssPlanHistoryEntry {
    const entry: AbyssPlanHistoryEntry = structuredClone({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    });
    const next = [entry, ...this.readAbyssPlans()].slice(0, MAX_ENTRIES);
    this.store.set('abyssPlans', next);
    return structuredClone(entry);
  }

  queryAbyss(options: { uid?: string } = {}): AbyssPlanHistoryEntry[] {
    return structuredClone(
      this.readAbyssPlans().filter(
        (entry) => options.uid === undefined || entry.uid === options.uid
      )
    );
  }

  removeAbyssById(id: string): boolean {
    const entries = this.readAbyssPlans();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    this.store.set('abyssPlans', next);
    return true;
  }

  appendStygian(input: Omit<StygianPlanHistoryEntry, 'id' | 'createdAt'>): StygianPlanHistoryEntry {
    const entry = stygianHistoryEntrySchema.parse(
      structuredClone({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...input
      })
    ) as StygianPlanHistoryEntry;
    const next = [entry, ...this.readStygianPlans()].slice(0, MAX_ENTRIES);
    this.store.set('stygianPlans', next);
    return structuredClone(entry);
  }

  queryStygian(options: { uid?: string } = {}): StygianPlanHistoryEntry[] {
    return structuredClone(
      this.readStygianPlans().filter(
        (entry) => options.uid === undefined || entry.uid === options.uid
      )
    );
  }

  removeStygianById(id: string): boolean {
    const entries = this.readStygianPlans();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    this.store.set('stygianPlans', next);
    return true;
  }

  private readStygianPlans(): StygianPlanHistoryEntry[] {
    const stored = this.store.get('stygianPlans') as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((entry) => {
      const parsed = stygianHistoryEntrySchema.safeParse(entry);
      return parsed.success ? [structuredClone(parsed.data) as StygianPlanHistoryEntry] : [];
    });
  }

  private readAbyssPlans(): AbyssPlanHistoryEntry[] {
    const stored = this.store.get('abyssPlans') as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((entry) => {
      const normalized = normalizeAbyssPlanHistoryEntry(entry);
      return normalized ? [normalized] : [];
    });
  }

  private migrateAbyssPlans(): void {
    const stored = this.store.get('abyssPlans') as unknown;
    if (!Array.isArray(stored)) {
      this.store.set('abyssPlans', []);
      return;
    }
    const needsMigration = stored.some(
      (entry) =>
        !isRecord(entry) ||
        !Array.isArray(entry.characters) ||
        !isScenarioTrust(entry.scenarioTrust) ||
        !isScenarioFreshness(entry.scenarioFreshness) ||
        typeof entry.scenarioNotCurrent !== 'boolean'
    );
    if (needsMigration) this.store.set('abyssPlans', this.readAbyssPlans());
  }

  query(options: HistoryQueryOptions = {}): HistoryQueryResult {
    const offset = options.offset && options.offset > 0 ? options.offset : 0;
    const limit =
      options.limit && options.limit > 0 ? Math.min(options.limit, MAX_LIMIT) : DEFAULT_LIMIT;
    const enemyKeyword = options.enemyKeyword?.trim().toLowerCase() ?? '';
    const fromTs = options.fromDate ? Date.parse(options.fromDate) : Number.NEGATIVE_INFINITY;
    const toTs = options.toDate ? Date.parse(options.toDate) : Number.POSITIVE_INFINITY;

    const filtered = this.store.get('entries').filter((entry) => {
      if (options.uid && entry.uid !== options.uid) {
        return false;
      }
      if (options.source && entry.result.source !== options.source) {
        return false;
      }
      if (enemyKeyword) {
        const hay = entry.enemyNames.join(' ').toLowerCase();
        if (!hay.includes(enemyKeyword)) {
          return false;
        }
      }
      const ts = Date.parse(entry.createdAt);
      if (Number.isFinite(fromTs) && ts < fromTs) {
        return false;
      }
      if (Number.isFinite(toTs) && ts > toTs) {
        return false;
      }
      return true;
    });

    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + limit < filtered.length
    };
  }

  removeById(id: string): boolean {
    const before = this.store.get('entries');
    const next = before.filter((entry) => entry.id !== id);
    if (next.length === before.length) {
      return false;
    }
    this.store.set('entries', next);
    return true;
  }

  removeMany(filter: { uid?: string; source?: 'llm' | 'fallback'; enemyKeyword?: string }): number {
    if (!filter.uid && !filter.source && !filter.enemyKeyword) {
      throw new Error(
        'removeMany requires at least one filter (uid / source / enemyKeyword) to prevent accidental clear'
      );
    }
    const keyword = filter.enemyKeyword?.trim().toLowerCase();
    const before = this.store.get('entries');
    const next = before.filter((entry) => {
      if (filter.uid && entry.uid !== filter.uid) {
        return true;
      }
      if (filter.source && entry.result.source !== filter.source) {
        return true;
      }
      if (keyword) {
        const hay = entry.enemyNames.join(' ').toLowerCase();
        if (!hay.includes(keyword)) {
          return true;
        }
      }
      return false;
    });
    this.store.set('entries', next);
    return before.length - next.length;
  }
}

function normalizeAbyssPlanHistoryEntry(value: unknown): AbyssPlanHistoryEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.uid !== 'string' ||
    typeof value.scenarioId !== 'string' ||
    typeof value.dataVersion !== 'string' ||
    !isRecord(value.plan)
  ) {
    return undefined;
  }
  const inferredDevelopment =
    value.scenarioId.startsWith('development.') || value.dataVersion.startsWith('development.');
  const characters = Array.isArray(value.characters)
    ? value.characters.flatMap((character) => {
        if (
          !isRecord(character) ||
          typeof character.id !== 'string' ||
          typeof character.name !== 'string' ||
          typeof character.element !== 'string'
        ) {
          return [];
        }
        return [
          {
            id: character.id,
            name: character.name,
            element: character.element,
            ...(typeof character.level === 'number' ? { level: character.level } : {})
          }
        ];
      })
    : [];
  return structuredClone({
    ...value,
    characters,
    scenarioTrust: isScenarioTrust(value.scenarioTrust)
      ? value.scenarioTrust
      : inferredDevelopment
        ? 'development-sample'
        : 'production',
    scenarioFreshness: isScenarioFreshness(value.scenarioFreshness)
      ? value.scenarioFreshness
      : 'unknown',
    scenarioNotCurrent:
      typeof value.scenarioNotCurrent === 'boolean' ? value.scenarioNotCurrent : true
  }) as AbyssPlanHistoryEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScenarioTrust(value: unknown): value is AbyssPlanHistoryEntry['scenarioTrust'] {
  return value === 'production' || value === 'development-sample';
}

function isScenarioFreshness(value: unknown): value is AbyssPlanHistoryEntry['scenarioFreshness'] {
  return value === 'fresh' || value === 'expiring' || value === 'stale' || value === 'unknown';
}
