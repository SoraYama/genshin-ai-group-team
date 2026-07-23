import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
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
import type { ScenarioMode } from '../../shared/domain.js';
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

type HistoryCollectionKey = keyof HistoryStoreSchema;

interface RawHistoryCollection {
  key: HistoryCollectionKey;
  mode?: ScenarioMode;
}

interface RawChallengeSelection {
  rawByCollection: Map<HistoryCollectionKey, unknown[]>;
  selectedIndexes: Map<HistoryCollectionKey, Set<number>>;
  descriptors: string[];
}

export type HistoryStoreErrorCode =
  | 'HISTORY_CONFIRMATION_EXPIRED'
  | 'HISTORY_SELECTION_CHANGED'
  | 'HISTORY_IDENTITY_UNKNOWN';

export class HistoryStoreError extends Error {
  override readonly name = 'HistoryStoreError';

  constructor(
    readonly code: HistoryStoreErrorCode,
    message: string
  ) {
    super(message);
  }
}

type ChallengeScope =
  | {
      scope: 'group';
      uid: string;
      mode: ScenarioMode;
      scenarioId: string;
    }
  | { scope: 'uid'; uid: string }
  | { scope: 'all' };

type ConfirmedChallengeScope = ChallengeScope & {
  expectedCount: number;
  confirmationToken: string;
};

const MAX_ENTRIES = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const DEFAULTS: HistoryStoreSchema = {
  entries: [],
  abyssPlans: [],
  stygianPlans: [],
  theaterPlans: []
};

const RAW_HISTORY_COLLECTIONS: RawHistoryCollection[] = [
  { key: 'entries' },
  { key: 'abyssPlans', mode: 'spiral-abyss' },
  { key: 'stygianPlans', mode: 'stygian-onslaught' },
  { key: 'theaterPlans', mode: 'imaginarium-theater' }
];

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
  private readonly challengeConfirmations = new Map<
    string,
    { scopeKey: string; count: number; fingerprint: string; expiresAt: number }
  >();

  constructor(private readonly now: () => number = Date.now) {
    this.store = new Store<HistoryStoreSchema>({
      name: 'history',
      defaults: DEFAULTS
    });
  }

  append(input: Omit<RecommendationHistoryEntry, 'id' | 'createdAt'>): RecommendationHistoryEntry {
    const entry: RecommendationHistoryEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };

    this.appendRaw('entries', entry, isRecommendationHistoryEntry);
    return entry;
  }

  appendAbyss(input: Omit<AbyssPlanHistoryEntry, 'id' | 'createdAt'>): AbyssPlanHistoryEntry {
    const entry: AbyssPlanHistoryEntry = structuredClone({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    });
    this.appendRaw(
      'abyssPlans',
      entry,
      (value) => normalizeAbyssPlanHistoryEntry(value) !== undefined
    );
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
    return this.removeRawById('abyssPlans', id);
  }

  appendStygian(input: Omit<StygianPlanHistoryEntry, 'id' | 'createdAt'>): StygianPlanHistoryEntry {
    const entry = stygianHistoryEntrySchema.parse(
      structuredClone({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...input
      })
    ) as StygianPlanHistoryEntry;
    this.appendRaw(
      'stygianPlans',
      entry,
      (value) => stygianHistoryEntrySchema.safeParse(value).success
    );
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
    return this.removeRawById('stygianPlans', id);
  }

  appendTheater(input: Omit<TheaterPlanHistoryEntry, 'id' | 'createdAt'>): TheaterPlanHistoryEntry {
    const entry = theaterHistoryEntrySchema.parse(
      structuredClone({ id: randomUUID(), createdAt: new Date().toISOString(), ...input })
    ) as TheaterPlanHistoryEntry;
    this.appendRaw(
      'theaterPlans',
      entry,
      (value) => theaterHistoryEntrySchema.safeParse(value).success
    );
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
    return this.removeRawById('theaterPlans', id);
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

  query(options: HistoryQueryOptions = {}): HistoryQueryResult {
    const offset = options.offset && options.offset > 0 ? options.offset : 0;
    const limit =
      options.limit && options.limit > 0 ? Math.min(options.limit, MAX_LIMIT) : DEFAULT_LIMIT;
    const enemyKeyword = options.enemyKeyword?.trim().toLowerCase() ?? '';
    const fromTs = options.fromDate ? Date.parse(options.fromDate) : Number.NEGATIVE_INFINITY;
    const toTs = options.toDate ? Date.parse(options.toDate) : Number.POSITIVE_INFINITY;

    const rawEntries = this.rawCollectionForRead('entries');
    const filtered = rawEntries
      .flatMap((value) => (isRecommendationHistoryEntry(value) ? [value] : []))
      .filter((entry) => {
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
    return this.removeRawById('entries', id);
  }

  removeMany(filter: { uid?: string; source?: 'llm' | 'fallback'; enemyKeyword?: string }): number {
    if (!filter.uid && !filter.source && !filter.enemyKeyword) {
      throw new Error(
        'removeMany requires at least one filter (uid / source / enemyKeyword) to prevent accidental clear'
      );
    }
    const keyword = filter.enemyKeyword?.trim().toLowerCase();
    const before = this.requireRawCollection('entries');
    const selected = new Set<number>();
    before.forEach((value, index) => {
      if (!isRecord(value)) {
        throw unknownHistoryIdentity('entries');
      }
      if (filter.uid) {
        if (typeof value.uid !== 'string') throw unknownHistoryIdentity('entries');
        if (value.uid !== filter.uid) return;
      }
      if (filter.source) {
        if (!isRecord(value.result) || typeof value.result.source !== 'string') {
          throw unknownHistoryIdentity('entries');
        }
        if (value.result.source !== filter.source) return;
      }
      if (keyword) {
        if (
          !Array.isArray(value.enemyNames) ||
          value.enemyNames.some((name) => typeof name !== 'string')
        ) {
          throw unknownHistoryIdentity('entries');
        }
        if (!value.enemyNames.join(' ').toLowerCase().includes(keyword)) return;
      }
      if (typeof value.id !== 'string' || value.id.length === 0) {
        throw unknownHistoryIdentity('entries');
      }
      selected.add(index);
    });
    if (selected.size > 0) {
      this.store.set(
        'entries',
        before.filter((_entry, index) => !selected.has(index)) as RecommendationHistoryEntry[]
      );
    }
    return selected.size;
  }

  getSummary(): { count: number; sizeBytes?: number; updatedAt?: string } {
    const rawCollections = RAW_HISTORY_COLLECTIONS.map(({ key }) => this.rawCollectionForRead(key));
    const allCreatedAt = rawCollections
      .flat()
      .flatMap((value) =>
        isRecord(value) && typeof value.createdAt === 'string' ? [value.createdAt] : []
      );
    let sizeBytes: number | undefined;
    try {
      if (this.store.path) sizeBytes = statSync(this.store.path).size;
    } catch {
      sizeBytes = undefined;
    }
    return {
      count: rawCollections.reduce((total, entries) => total + entries.length, 0),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(allCreatedAt.length === 0
        ? {}
        : { updatedAt: allCreatedAt.sort((left, right) => right.localeCompare(left))[0] })
    };
  }

  getChallengeScopeConfirmation(scope: ChallengeScope): {
    count: number;
    confirmationToken: string;
  } {
    const snapshot = this.getChallengeScopeSnapshot(scope);
    const confirmationToken = randomUUID();
    this.challengeConfirmations.set(confirmationToken, {
      scopeKey: challengeScopeKey(scope),
      count: snapshot.count,
      fingerprint: snapshot.fingerprint,
      expiresAt: this.now() + 5 * 60_000
    });
    return {
      count: snapshot.count,
      confirmationToken
    };
  }

  getChallengeScopeSnapshot(scope: ChallengeScope): { count: number; fingerprint: string } {
    const snapshot = this.challengeScopeSnapshot(scope);
    return {
      count: snapshot.descriptors.length,
      fingerprint: createHistorySelectionFingerprint(snapshot.descriptors)
    };
  }

  removeChallengeScope(scope: ConfirmedChallengeScope): number {
    const confirmation = this.challengeConfirmations.get(scope.confirmationToken);
    this.challengeConfirmations.delete(scope.confirmationToken);
    if (!confirmation || confirmation.expiresAt < this.now()) {
      throw new HistoryStoreError(
        'HISTORY_CONFIRMATION_EXPIRED',
        'History confirmation expired; confirm again'
      );
    }
    const snapshot = this.challengeScopeSnapshot(scope);
    const fingerprint = createHistorySelectionFingerprint(snapshot.descriptors);
    if (
      confirmation.scopeKey !== challengeScopeKey(scope) ||
      confirmation.count !== scope.expectedCount ||
      snapshot.descriptors.length !== confirmation.count ||
      fingerprint !== confirmation.fingerprint
    ) {
      throw new HistoryStoreError(
        'HISTORY_SELECTION_CHANGED',
        `History selection changed: expected ${scope.expectedCount}, found ${snapshot.descriptors.length}`
      );
    }
    const updates: Partial<HistoryStoreSchema> = {};
    for (const { key } of RAW_HISTORY_COLLECTIONS) {
      const selected = snapshot.selectedIndexes.get(key);
      if (!selected || selected.size === 0) continue;
      const raw = snapshot.rawByCollection.get(key) ?? [];
      updates[key] = raw.filter((_entry, index) => !selected.has(index)) as never;
    }
    if (Object.keys(updates).length > 0) this.store.set(updates);
    return snapshot.descriptors.length;
  }

  private challengeScopeSnapshot(scope: ChallengeScope): RawChallengeSelection {
    const rawByCollection = new Map<HistoryCollectionKey, unknown[]>();
    const selectedIndexes = new Map<HistoryCollectionKey, Set<number>>();
    const descriptors: string[] = [];
    for (const collection of RAW_HISTORY_COLLECTIONS) {
      const raw = this.requireRawCollection(collection.key);
      rawByCollection.set(collection.key, raw);
      const selected = new Set<number>();
      raw.forEach((value, index) => {
        const decision = rawScopeDecision(value, collection, scope);
        if (decision === 'ambiguous') throw unknownHistoryIdentity(collection.key);
        if (decision === 'outside') return;
        selected.add(index);
        const id = rawIdentityPart(value, 'id')!;
        descriptors.push(
          `${collection.key}:${id}:${createHash('sha256').update(rawFingerprintValue(value)).digest('hex')}`
        );
      });
      selectedIndexes.set(collection.key, selected);
    }
    descriptors.sort();
    return { rawByCollection, selectedIndexes, descriptors };
  }

  private appendRaw(
    key: HistoryCollectionKey,
    entry: HistoryStoreSchema[HistoryCollectionKey][number],
    isParseable: (value: unknown) => boolean
  ): void {
    const raw = this.requireRawCollection(key);
    const next: unknown[] = [entry];
    let parseableCount = 1;
    for (const value of raw) {
      if (isParseable(value)) {
        if (parseableCount >= MAX_ENTRIES) continue;
        parseableCount += 1;
      }
      next.push(value);
    }
    this.store.set(key, next as never);
  }

  private removeRawById(key: HistoryCollectionKey, id: string): boolean {
    const raw = this.requireRawCollection(key);
    const next = raw.filter((value) => rawIdentityPart(value, 'id') !== id);
    if (next.length === raw.length) return false;
    this.store.set(key, next as never);
    return true;
  }

  private requireRawCollection(key: HistoryCollectionKey): unknown[] {
    const stored = this.store.get(key) as unknown;
    if (!Array.isArray(stored)) throw unknownHistoryIdentity(key);
    return stored;
  }

  private rawCollectionForRead(key: HistoryCollectionKey): unknown[] {
    const stored = this.store.get(key) as unknown;
    return Array.isArray(stored) ? stored : [];
  }
}

function createHistorySelectionFingerprint(descriptors: string[]): string {
  return createHash('sha256').update(JSON.stringify(descriptors)).digest('hex');
}

function rawScopeDecision(
  value: unknown,
  collection: RawHistoryCollection,
  scope: ChallengeScope
): 'selected' | 'outside' | 'ambiguous' {
  if (scope.scope === 'all') {
    return rawIdentityPart(value, 'id') ? 'selected' : 'ambiguous';
  }
  if (scope.scope === 'group' && collection.mode !== scope.mode) return 'outside';
  const uid = rawIdentityPart(value, 'uid');
  if (!uid) return 'ambiguous';
  if (uid !== scope.uid) return 'outside';
  if (scope.scope === 'uid') {
    return rawIdentityPart(value, 'id') ? 'selected' : 'ambiguous';
  }
  const recordedMode = rawIdentityPart(value, 'mode');
  if (recordedMode && recordedMode !== collection.mode) return 'ambiguous';
  const scenarioId = rawIdentityPart(value, 'scenarioId');
  if (!scenarioId) return 'ambiguous';
  if (scenarioId !== scope.scenarioId) return 'outside';
  return rawIdentityPart(value, 'id') ? 'selected' : 'ambiguous';
}

function rawIdentityPart(
  value: unknown,
  key: 'id' | 'uid' | 'mode' | 'scenarioId'
): string | undefined {
  if (!isRecord(value)) return undefined;
  const part = value[key];
  return typeof part === 'string' && part.length > 0 ? part : undefined;
}

function rawFingerprintValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new HistoryStoreError(
      'HISTORY_IDENTITY_UNKNOWN',
      'History record cannot be fingerprinted safely'
    );
  }
  return serialized;
}

function unknownHistoryIdentity(collection: HistoryCollectionKey): HistoryStoreError {
  return new HistoryStoreError(
    'HISTORY_IDENTITY_UNKNOWN',
    `History record identity is unknown in ${collection}; nothing was changed`
  );
}

function isRecommendationHistoryEntry(value: unknown): value is RecommendationHistoryEntry {
  if (!isRecord(value) || !isRecord(value.result)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.uid === 'string' &&
    typeof value.createdAt === 'string' &&
    Array.isArray(value.enemyNames) &&
    value.enemyNames.every((name) => typeof name === 'string') &&
    (value.side === 'single' || value.side === 'left' || value.side === 'right') &&
    (value.result.source === 'llm' || value.result.source === 'fallback') &&
    typeof value.result.summary === 'string' &&
    Array.isArray(value.result.teams)
  );
}

function challengeScopeKey(scope: ChallengeScope): string {
  return JSON.stringify(
    scope.scope === 'group'
      ? [scope.scope, scope.uid, scope.mode, scope.scenarioId]
      : scope.scope === 'uid'
        ? [scope.scope, scope.uid]
        : [scope.scope]
  );
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
