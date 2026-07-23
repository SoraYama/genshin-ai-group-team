import { randomUUID } from 'node:crypto';
import Store from 'electron-store';
import { z } from 'zod';
import type {
  AbyssPlanHistoryEntry,
  StygianPlanHistoryEntry,
  TheaterPlanHistoryEntry,
  HistoryQueryOptions,
  HistoryQueryResult,
  RecommendationHistoryEntry
} from '../../shared/domain.js';
import {
  canonicalCharacterIdSchema,
  stygianAdvisorPlanSchema,
  stygianRewardTargetSchema
} from '../../shared/stygian-advisor.js';
import {
  theaterAdvisorPlanInputSchema,
  theaterEligibilityReportSchema,
  theaterObjectiveSchema
} from '../../shared/theater-advisor.js';
import {
  crossPartyReusePolicySchema,
  playerPreferencesSchema,
  theaterPlanSchema
} from '../../shared/scenario-v2.js';

interface HistoryStoreSchema {
  entries: RecommendationHistoryEntry[];
  abyssPlans: AbyssPlanHistoryEntry[];
  stygianPlans: StygianPlanHistoryEntry[];
  theaterPlans: TheaterPlanHistoryEntry[];
}

const MAX_ENTRIES = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const DEFAULTS: HistoryStoreSchema = {
  entries: [],
  abyssPlans: [],
  stygianPlans: [],
  theaterPlans: []
};

const theaterHistoryEntrySchema = z
  .object({
    id: z.string().trim().min(8),
    createdAt: z.iso.datetime({ offset: true }),
    uid: z.string().regex(/^\d{9}$/),
    scenarioId: z.string().trim().min(1),
    schemaVersion: z.literal(2),
    dataVersion: z.string().trim().min(1),
    mode: z.literal('imaginarium-theater'),
    act: z.number().int().min(1).max(10).optional(),
    target: theaterObjectiveSchema,
    source: z.enum(['smart-service', 'local-rules']),
    scenarioTrust: z.enum(['production', 'development-sample']),
    scenarioFreshness: z.enum(['fresh', 'expiring', 'stale', 'unknown']),
    scenarioNotCurrent: z.boolean(),
    interventions: theaterAdvisorPlanInputSchema,
    eligibility: theaterEligibilityReportSchema,
    cast: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            name: z.string().trim().min(1),
            element: z.string().trim().min(1).optional(),
            level: z.number().int().nonnegative().optional(),
            source: z.enum(['owned', 'opening', 'trial', 'special-guest', 'support']),
            poolSources: z
              .array(z.enum(['opening', 'trial', 'special-guest', 'support']))
              .optional()
          })
          .strict()
      )
      .min(1),
    vigorBudget: z.array(
      z
        .object({
          act: z.number().int().min(1).max(10),
          characterId: z.string().trim().min(1),
          before: z.number().int().nonnegative(),
          spent: z.number().int().nonnegative(),
          after: z.number().int().nonnegative()
        })
        .strict()
    ),
    nodeBudget: z
      .array(
        z
          .object({
            nodeId: z.string().trim().min(1),
            cost: z.number().int().nonnegative()
          })
          .strict()
      )
      .default([]),
    routeGuidance: z
      .object({
        preserveCharacterIds: z.array(canonicalCharacterIdSchema),
        arcanaPriorityIds: z.array(z.string().trim().min(1)),
        arcanaPriorities: z
          .array(
            z
              .object({
                nodeId: z.string().trim().min(1),
                name: z.string().trim().min(1),
                condition: z.string().trim().min(1),
                reason: z.string().trim().min(1)
              })
              .strict()
          )
          .default([]),
        notes: z.array(z.string().trim().min(1)).min(1)
      })
      .strict(),
    plan: theaterPlanSchema
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.scenarioId !== entry.plan.scenarioId ||
      entry.dataVersion !== entry.plan.dataVersion ||
      entry.interventions.scenarioId !== entry.scenarioId ||
      entry.interventions.dataVersion !== entry.dataVersion
    ) {
      context.addIssue({
        code: 'custom',
        path: ['plan'],
        message: 'Theater history identity must remain immutable'
      });
    }
    if (
      entry.interventions.uid !== entry.uid ||
      entry.interventions.target !== entry.target ||
      entry.interventions.act !== entry.act
    ) {
      context.addIssue({
        code: 'custom',
        path: ['interventions'],
        message: 'Theater history target must match its envelope'
      });
    }
    const ids = entry.cast.map(({ id }) => id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['cast'],
        message: 'Theater history cast IDs must be unique'
      });
    const byId = new Map(entry.cast.map((item) => [item.id, item]));
    const plannedCastSources = [
      ['owned', entry.plan.cast.selectedCharacterIds],
      ['opening', entry.plan.cast.openingCharacterIds],
      ['trial', entry.plan.cast.trialCharacterIds],
      ['special-guest', entry.plan.cast.specialGuestCharacterIds],
      ['support', entry.plan.cast.supportCharacterIds]
    ] as const;
    const expectedSourceById = new Map<string, (typeof plannedCastSources)[number][0]>();
    for (const [source, sourceIds] of plannedCastSources) {
      sourceIds.forEach((id) => {
        const previous = expectedSourceById.get(id);
        if (previous && previous !== source)
          context.addIssue({
            code: 'custom',
            path: ['plan', 'cast'],
            message: 'Theater history plan cannot assign one actor to multiple sources'
          });
        else expectedSourceById.set(id, source);
      });
    }
    entry.cast.forEach(({ id, source }, index) => {
      if (expectedSourceById.get(id) !== source)
        context.addIssue({
          code: 'custom',
          path: ['cast', index, 'source'],
          message: 'Theater history actor source must exactly match the plan'
        });
    });
    entry.plan.cast.selectedCharacterIds.forEach((id) => {
      if (byId.get(id)?.source !== 'owned')
        context.addIssue({
          code: 'custom',
          path: ['cast'],
          message: 'Selected owned cast cannot be stored as an external source'
        });
    });
    const allPlanIds = new Set([
      ...entry.plan.cast.selectedCharacterIds,
      ...entry.plan.cast.openingCharacterIds,
      ...entry.plan.cast.trialCharacterIds,
      ...entry.plan.cast.specialGuestCharacterIds,
      ...entry.plan.cast.supportCharacterIds,
      ...entry.plan.acts.flatMap(({ candidateCharacterIds }) => candidateCharacterIds)
    ]);
    if ([...allPlanIds].some((id) => !byId.has(id)) || ids.some((id) => !allPlanIds.has(id))) {
      context.addIssue({
        code: 'custom',
        path: ['cast'],
        message: 'Theater history cast snapshots must exactly cover the plan'
      });
    }
    const uniqueLedgerKeys = new Set(
      entry.vigorBudget.map(({ act, characterId }) => `${act}:${characterId}`)
    );
    if (uniqueLedgerKeys.size !== entry.vigorBudget.length) {
      context.addIssue({
        code: 'custom',
        path: ['vigorBudget'],
        message: 'Theater history vigor ledger entries must be unique per act and actor'
      });
    }
    const budgetByAct = new Map<number, typeof entry.vigorBudget>();
    entry.vigorBudget.forEach((item) =>
      budgetByAct.set(item.act, [...(budgetByAct.get(item.act) ?? []), item])
    );
    entry.plan.acts.forEach((actPlan) => {
      const expected = new Set(actPlan.plannedVigorSpend.map(({ characterId }) => characterId));
      const actual = new Set(
        (budgetByAct.get(actPlan.act) ?? []).map(({ characterId }) => characterId)
      );
      if (
        expected.size !== actual.size ||
        [...expected].some((characterId) => !actual.has(characterId))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['vigorBudget'],
          message: 'Theater history vigor ledger must cover every planned actor spend'
        });
      }
    });
    const ledgerByCharacter = new Map<string, typeof entry.vigorBudget>();
    entry.vigorBudget.forEach((item) =>
      ledgerByCharacter.set(item.characterId, [
        ...(ledgerByCharacter.get(item.characterId) ?? []),
        item
      ])
    );
    entry.vigorBudget.forEach(({ act, characterId, before, spent, after }, index) => {
      const plannedSpend = entry.plan.acts
        .find((item) => item.act === act)
        ?.plannedVigorSpend.find((item) => item.characterId === characterId)?.cost;
      if (before - spent !== after || plannedSpend !== spent)
        context.addIssue({
          code: 'custom',
          path: ['vigorBudget', index],
          message: 'Theater history vigor ledger entry is invalid'
        });
    });
    for (const ledger of ledgerByCharacter.values()) {
      const sorted = ledger.slice().sort((left, right) => left.act - right.act);
      sorted.forEach((item, index) => {
        if (index > 0 && item.before !== sorted[index - 1]?.after)
          context.addIssue({
            code: 'custom',
            path: ['vigorBudget'],
            message: 'Theater history per-actor vigor chain is invalid'
          });
      });
    }
    if (entry.routeGuidance.preserveCharacterIds.some((id) => byId.get(id)?.source !== 'owned')) {
      context.addIssue({
        code: 'custom',
        path: ['routeGuidance', 'preserveCharacterIds'],
        message: 'Only owned actors can be preserved by canonical ID'
      });
    }
    const priorityIds = entry.routeGuidance.arcanaPriorityIds;
    const detailIds = entry.routeGuidance.arcanaPriorities.map(({ nodeId }) => nodeId);
    const budgetIds = entry.nodeBudget.map(({ nodeId }) => nodeId);
    if (
      new Set(priorityIds).size !== priorityIds.length ||
      priorityIds.length !== detailIds.length ||
      priorityIds.some((id, index) => id !== detailIds[index]) ||
      priorityIds.length !== budgetIds.length ||
      priorityIds.some((id, index) => id !== budgetIds[index])
    )
      context.addIssue({
        code: 'custom',
        path: ['nodeBudget'],
        message: 'Theater history Arcana details and node resource budget must match priority order'
      });
  });

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

  appendTheater(input: Omit<TheaterPlanHistoryEntry, 'id' | 'createdAt'>): TheaterPlanHistoryEntry {
    const entry = theaterHistoryEntrySchema.parse(
      structuredClone({ id: randomUUID(), createdAt: new Date().toISOString(), ...input })
    ) as TheaterPlanHistoryEntry;
    this.store.set('theaterPlans', [entry, ...this.readTheaterPlans()].slice(0, MAX_ENTRIES));
    return structuredClone(entry);
  }

  queryTheater(options: { uid?: string } = {}): TheaterPlanHistoryEntry[] {
    return structuredClone(
      this.readTheaterPlans().filter(
        (entry) => options.uid === undefined || entry.uid === options.uid
      )
    );
  }

  removeTheaterById(id: string): boolean {
    const entries = this.readTheaterPlans();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    this.store.set('theaterPlans', next);
    return true;
  }

  private readTheaterPlans(): TheaterPlanHistoryEntry[] {
    const stored = this.store.get('theaterPlans') as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((entry) => {
      const parsed = theaterHistoryEntrySchema.safeParse(entry);
      return parsed.success ? [structuredClone(parsed.data) as TheaterPlanHistoryEntry] : [];
    });
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
