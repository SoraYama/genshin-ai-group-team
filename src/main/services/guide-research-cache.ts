import { createHash, randomUUID } from 'node:crypto';
import { promises as nodeFileSystem } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { ephemeralGuideMatchSchema, sourceCitationSchema } from '../../shared/advisor-knowledge.js';
import { guideResearchTaskSchema, type GuideResearchTask } from './knowledge-coverage-gate.js';

export const GUIDE_RESEARCH_CACHE_FILENAME = 'guide-research.json';
export const GUIDE_RESEARCH_CACHE_SCHEMA_VERSION = 1;
export const GUIDE_RESEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const GUIDE_RESEARCH_CACHE_MAX_ENTRIES = 100;
export const GUIDE_RESEARCH_CACHE_MAX_BYTES = 2 * 1024 * 1024;

const cacheKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const knowledgeVersionSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: true }).max(40);
const boundedTextSchema = z.string().trim().min(1).max(500);

const ephemeralCitationSchema = sourceCitationSchema.extend({
  trust: z.literal('ephemeral-web')
});

export const ephemeralGuideCacheValueSchema = z
  .object({
    trust: z.literal('ephemeral-web'),
    matches: z.array(ephemeralGuideMatchSchema).min(1).max(256),
    citations: z.array(ephemeralCitationSchema).min(1).max(512),
    applicability: z
      .object({
        characterNames: z.array(z.string().trim().min(1).max(80)).max(32),
        scenarioTags: z.array(z.string().trim().min(1).max(80)).max(32),
        buildSignals: z.array(z.string().trim().min(1).max(120)).max(32)
      })
      .strict(),
    conflicts: z.array(boundedTextSchema).max(64),
    researchedAt: timestampSchema,
    contentObservedAt: timestampSchema.optional(),
    validUntil: timestampSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.matches.map(({ id }) => id),
      ['matches'],
      context
    );
    addDuplicateIssues(
      value.citations.map(({ id }) => id),
      ['citations'],
      context
    );
    const citationIds = new Set(value.citations.map(({ id }) => id));
    value.matches.forEach((match, matchIndex) => {
      match.citationIds.forEach((citationId, citationIndex) => {
        if (!citationIds.has(citationId)) {
          context.addIssue({
            code: 'custom',
            path: ['matches', matchIndex, 'citationIds', citationIndex],
            message: 'Ephemeral match citation IDs must resolve in this cache value'
          });
        }
      });
    });
    if (containsForbiddenSensitiveText(value)) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Guide research values cannot contain account or credential material'
      });
    }
  });

export type EphemeralGuideCacheValue = z.infer<typeof ephemeralGuideCacheValueSchema>;

const cacheEntrySchema = z
  .object({
    key: cacheKeySchema,
    knowledgeVersion: knowledgeVersionSchema,
    trust: z.literal('ephemeral-web'),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    value: ephemeralGuideCacheValueSchema
  })
  .strict()
  .superRefine(({ createdAt, expiresAt }, context) => {
    const createdTime = Date.parse(createdAt);
    const expiryTime = Date.parse(expiresAt);
    if (expiryTime - createdTime !== GUIDE_RESEARCH_CACHE_TTL_MS) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Guide research entries must use the fixed 24-hour TTL'
      });
    }
  });

const cacheDocumentSchema = z
  .object({
    schemaVersion: z.literal(GUIDE_RESEARCH_CACHE_SCHEMA_VERSION),
    entries: z.array(cacheEntrySchema).max(GUIDE_RESEARCH_CACHE_MAX_ENTRIES)
  })
  .strict()
  .superRefine(({ entries }, context) => {
    addDuplicateIssues(
      entries.map(({ key }) => key),
      ['entries'],
      context
    );
  });

type CacheDocument = z.infer<typeof cacheDocumentSchema>;
type CacheEntry = CacheDocument['entries'][number];

export interface GuideResearchCacheFileSystem {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  writeFile(filePath: string, contents: string, encoding: 'utf8'): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  lstat(filePath: string): Promise<{
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
  realpath(filePath: string): Promise<string>;
}

export type GuideResearchCacheDiagnosticCode =
  | 'GUIDE_RESEARCH_CACHE_INVALID'
  | 'GUIDE_RESEARCH_CACHE_UNREADABLE';

export interface GuideResearchCacheDiagnostic {
  code: GuideResearchCacheDiagnosticCode;
  file: typeof GUIDE_RESEARCH_CACHE_FILENAME;
}

export type GuideResearchCacheErrorCode =
  | 'GUIDE_RESEARCH_CLOCK_INVALID'
  | 'GUIDE_RESEARCH_ENTRY_TOO_LARGE'
  | 'GUIDE_RESEARCH_PATH_UNSAFE'
  | 'GUIDE_RESEARCH_SELECTION_CHANGED'
  | 'GUIDE_RESEARCH_WRITE_FAILED';

export class GuideResearchCacheError extends Error {
  override readonly name = 'GuideResearchCacheError';

  constructor(
    readonly code: GuideResearchCacheErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface GuideResearchCacheOptions {
  userDataDirectory: string;
  fileSystem?: GuideResearchCacheFileSystem;
  now?: () => number;
  onDiagnostic?: (diagnostic: GuideResearchCacheDiagnostic) => void;
}

export interface GuideResearchCacheLookup {
  task: GuideResearchTask;
  knowledgeVersion: string;
}

export interface GuideResearchCachePut extends GuideResearchCacheLookup {
  value: EphemeralGuideCacheValue;
}

export interface GuideResearchCacheSnapshot {
  count: number;
  clearableCount: number;
  sizeBytes?: number;
  updatedAt?: string;
  fingerprint: string;
}

interface LoadedCache {
  document: CacheDocument;
  selectionCount: number;
  sizeBytes?: number;
  fingerprint: string;
}

const MISSING_FINGERPRINT = createHash('sha256')
  .update('guide-research-cache:missing')
  .digest('hex');
const UNREADABLE_FINGERPRINT = createHash('sha256')
  .update('guide-research-cache:unreadable')
  .digest('hex');

export function resolveGuideResearchCachePath(userDataDirectory: string): string {
  if (!path.isAbsolute(userDataDirectory)) {
    throw new Error('Guide research userData directory must be absolute');
  }
  const normalized = path.normalize(userDataDirectory);
  if (isTrustedKnowledgePath(normalized)) {
    throw new Error('Trusted knowledge resources cannot be a userData authority');
  }
  return path.join(normalized, 'cache', GUIDE_RESEARCH_CACHE_FILENAME);
}

export function computeGuideResearchCacheKey(task: unknown, knowledgeVersion: unknown): string {
  const parsedTask = guideResearchTaskSchema.parse(task);
  const parsedKnowledgeVersion = knowledgeVersionSchema.parse(knowledgeVersion);
  return createHash('sha256')
    .update(canonicalJson({ task: parsedTask, knowledgeVersion: parsedKnowledgeVersion }))
    .digest('hex');
}

export class GuideResearchCache {
  readonly filePath: string;

  private readonly userDataDirectory: string;
  private readonly fileSystem: GuideResearchCacheFileSystem;
  private readonly now: () => number;
  private readonly onDiagnostic?: (diagnostic: GuideResearchCacheDiagnostic) => void;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: GuideResearchCacheOptions) {
    if ('filePath' in options) {
      throw new Error('Guide research cache accepts only a userData directory authority');
    }
    this.userDataDirectory = path.normalize(options.userDataDirectory);
    this.filePath = resolveGuideResearchCachePath(this.userDataDirectory);
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.now = options.now ?? Date.now;
    this.onDiagnostic = options.onDiagnostic;
  }

  async get(input: GuideResearchCacheLookup): Promise<EphemeralGuideCacheValue | undefined> {
    const lookup = parseLookup(input);
    await this.writeQueue;
    const now = this.currentTime();
    const loaded = await this.load(now);
    const key = computeGuideResearchCacheKey(lookup.task, lookup.knowledgeVersion);
    const entry = loaded.document.entries.find((candidate) => candidate.key === key);
    return entry === undefined ? undefined : cloneValue(entry.value);
  }

  async put(input: GuideResearchCachePut): Promise<EphemeralGuideCacheValue> {
    const lookup = parseLookup(input);
    const value = ephemeralGuideCacheValueSchema.parse(input.value);
    return this.enqueueWrite(async () => {
      const now = this.currentTime();
      const createdAt = new Date(now).toISOString();
      const key = computeGuideResearchCacheKey(lookup.task, lookup.knowledgeVersion);
      const entry = cacheEntrySchema.parse({
        key,
        knowledgeVersion: lookup.knowledgeVersion,
        trust: 'ephemeral-web',
        createdAt,
        expiresAt: new Date(now + GUIDE_RESEARCH_CACHE_TTL_MS).toISOString(),
        value
      });
      const singleEntryDocument = documentWith([entry]);
      if (documentBytes(singleEntryDocument) > GUIDE_RESEARCH_CACHE_MAX_BYTES) {
        throw new GuideResearchCacheError(
          'GUIDE_RESEARCH_ENTRY_TOO_LARGE',
          'Ephemeral guide research entry exceeds the cache file limit'
        );
      }

      const loaded = await this.load(now);
      const entries = loaded.document.entries.filter(
        ({ key: candidateKey }) => candidateKey !== key
      );
      entries.push(entry);
      const bounded = enforceLimits(entries);
      await this.atomicWrite(documentWith(bounded));
      return cloneValue(value);
    });
  }

  async getSummary(): Promise<{
    count: number;
    sizeBytes?: number;
    updatedAt?: string;
  }> {
    const snapshot = await this.getDataManagementSnapshot();
    return {
      count: snapshot.count,
      ...(snapshot.sizeBytes === undefined ? {} : { sizeBytes: snapshot.sizeBytes }),
      ...(snapshot.updatedAt === undefined ? {} : { updatedAt: snapshot.updatedAt })
    };
  }

  async getDataManagementSnapshot(): Promise<GuideResearchCacheSnapshot> {
    await this.writeQueue;
    const now = this.currentTime();
    const loaded = await this.load(now);
    const updatedAt = newestCreatedAt(loaded.document.entries);
    return {
      count: loaded.document.entries.length,
      clearableCount: loaded.selectionCount,
      ...(loaded.sizeBytes === undefined ? {} : { sizeBytes: loaded.sizeBytes }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      fingerprint: loaded.fingerprint
    };
  }

  async clearAll(expected: { clearableCount: number; fingerprint: string }): Promise<number> {
    return this.enqueueWrite(async () => {
      const now = this.currentTime();
      const loaded = await this.load(now);
      if (
        expected.clearableCount !== loaded.selectionCount ||
        expected.fingerprint !== loaded.fingerprint
      ) {
        throw new GuideResearchCacheError(
          'GUIDE_RESEARCH_SELECTION_CHANGED',
          'Ephemeral guide research cache changed; confirm again'
        );
      }
      await this.assertSafePath();
      try {
        await this.fileSystem.unlink(this.filePath);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw new GuideResearchCacheError(
            'GUIDE_RESEARCH_WRITE_FAILED',
            'Ephemeral guide research cache could not be cleared'
          );
        }
      }
      return loaded.selectionCount;
    });
  }

  private currentTime(): number {
    const value = this.now();
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > 8_640_000_000_000_000 - GUIDE_RESEARCH_CACHE_TTL_MS
    ) {
      throw new GuideResearchCacheError(
        'GUIDE_RESEARCH_CLOCK_INVALID',
        'Guide research cache clock is invalid'
      );
    }
    return value;
  }

  private async load(now: number): Promise<LoadedCache> {
    await this.assertSafePath();
    let raw: string;
    try {
      raw = await this.fileSystem.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return {
          document: documentWith([]),
          selectionCount: 0,
          sizeBytes: 0,
          fingerprint: MISSING_FINGERPRINT
        };
      }
      this.diagnostic('GUIDE_RESEARCH_CACHE_UNREADABLE');
      return {
        document: documentWith([]),
        selectionCount: 1,
        fingerprint: UNREADABLE_FINGERPRINT
      };
    }

    const sizeBytes = Buffer.byteLength(raw, 'utf8');
    const fingerprint = createHash('sha256').update(raw).digest('hex');
    if (sizeBytes > GUIDE_RESEARCH_CACHE_MAX_BYTES) {
      this.diagnostic('GUIDE_RESEARCH_CACHE_INVALID');
      return { document: documentWith([]), selectionCount: 1, sizeBytes, fingerprint };
    }
    try {
      const parsed = cacheDocumentSchema.parse(JSON.parse(raw));
      const entries = parsed.entries.filter((entry) => isEntryCurrent(entry, now));
      return {
        document: documentWith(entries),
        selectionCount: Math.max(1, parsed.entries.length),
        sizeBytes,
        fingerprint
      };
    } catch {
      this.diagnostic('GUIDE_RESEARCH_CACHE_INVALID');
      return { document: documentWith([]), selectionCount: 1, sizeBytes, fingerprint };
    }
  }

  private async atomicWrite(document: CacheDocument): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(
      directory,
      `.${GUIDE_RESEARCH_CACHE_FILENAME}.${randomUUID()}.tmp`
    );
    const contents = JSON.stringify(document);
    try {
      await this.assertSafePath();
      await this.fileSystem.mkdir(directory, { recursive: true });
      await this.assertSafePath();
      await this.fileSystem.writeFile(temporaryPath, contents, 'utf8');
      await this.assertSafeTemporaryFile(temporaryPath);
      await this.assertSafePath();
      await this.fileSystem.rename(temporaryPath, this.filePath);
    } catch (error) {
      try {
        await this.fileSystem.unlink(temporaryPath);
      } catch {
        // Cleanup is best-effort; errors remain redacted behind the stable write error below.
      }
      if (error instanceof GuideResearchCacheError && error.code === 'GUIDE_RESEARCH_PATH_UNSAFE') {
        throw error;
      }
      throw new GuideResearchCacheError(
        'GUIDE_RESEARCH_WRITE_FAILED',
        'Ephemeral guide research cache could not be written'
      );
    }
  }

  private diagnostic(code: GuideResearchCacheDiagnosticCode): void {
    this.onDiagnostic?.({ code, file: GUIDE_RESEARCH_CACHE_FILENAME });
  }

  private async assertSafePath(): Promise<void> {
    let realRoot: string;
    try {
      realRoot = path.normalize(await this.fileSystem.realpath(this.userDataDirectory));
    } catch {
      throw unsafePathError();
    }
    if (isTrustedKnowledgePath(realRoot)) throw unsafePathError();

    const cacheDirectory = path.dirname(this.filePath);
    const cacheStat = await this.safeLstat(cacheDirectory);
    if (cacheStat === undefined) return;
    if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) throw unsafePathError();

    let realCacheDirectory: string;
    try {
      realCacheDirectory = path.normalize(await this.fileSystem.realpath(cacheDirectory));
    } catch {
      throw unsafePathError();
    }
    if (realCacheDirectory !== path.join(realRoot, 'cache')) throw unsafePathError();

    const targetStat = await this.safeLstat(this.filePath);
    if (targetStat === undefined) return;
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw unsafePathError();

    let realTarget: string;
    try {
      realTarget = path.normalize(await this.fileSystem.realpath(this.filePath));
    } catch {
      throw unsafePathError();
    }
    if (realTarget !== path.join(realRoot, 'cache', GUIDE_RESEARCH_CACHE_FILENAME)) {
      throw unsafePathError();
    }
  }

  private async assertSafeTemporaryFile(temporaryPath: string): Promise<void> {
    const temporaryStat = await this.safeLstat(temporaryPath);
    if (temporaryStat === undefined || temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) {
      throw unsafePathError();
    }
    let realTemporaryPath: string;
    let realRoot: string;
    try {
      [realTemporaryPath, realRoot] = await Promise.all([
        this.fileSystem.realpath(temporaryPath),
        this.fileSystem.realpath(this.userDataDirectory)
      ]);
    } catch {
      throw unsafePathError();
    }
    if (
      path.dirname(path.normalize(realTemporaryPath)) !==
      path.join(path.normalize(realRoot), 'cache')
    ) {
      throw unsafePathError();
    }
  }

  private async safeLstat(targetPath: string): Promise<
    | {
        isSymbolicLink(): boolean;
        isDirectory(): boolean;
        isFile(): boolean;
      }
    | undefined
  > {
    try {
      return await this.fileSystem.lstat(targetPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw unsafePathError();
    }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function parseLookup(input: GuideResearchCacheLookup): GuideResearchCacheLookup {
  return {
    task: guideResearchTaskSchema.parse(input.task),
    knowledgeVersion: knowledgeVersionSchema.parse(input.knowledgeVersion)
  };
}

function documentWith(entries: CacheEntry[]): CacheDocument {
  return cacheDocumentSchema.parse({
    schemaVersion: GUIDE_RESEARCH_CACHE_SCHEMA_VERSION,
    entries
  });
}

function enforceLimits(entries: CacheEntry[]): CacheEntry[] {
  const bounded = [...entries];
  while (
    bounded.length > GUIDE_RESEARCH_CACHE_MAX_ENTRIES ||
    documentBytes(documentWith(bounded)) > GUIDE_RESEARCH_CACHE_MAX_BYTES
  ) {
    const oldest = [...bounded].sort(compareOldest)[0];
    if (oldest === undefined) break;
    bounded.splice(
      bounded.findIndex(({ key }) => key === oldest.key),
      1
    );
  }
  return bounded;
}

function compareOldest(left: CacheEntry, right: CacheEntry): number {
  const createdDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return createdDifference === 0 ? left.key.localeCompare(right.key) : createdDifference;
}

function documentBytes(document: CacheDocument): number {
  return Buffer.byteLength(JSON.stringify(document), 'utf8');
}

function isEntryCurrent(entry: CacheEntry, now: number): boolean {
  const createdAt = Date.parse(entry.createdAt);
  const expiresAt = Date.parse(entry.expiresAt);
  return createdAt <= now && now <= expiresAt;
}

function newestCreatedAt(entries: CacheEntry[]): string | undefined {
  return entries.reduce<string | undefined>(
    (newest, { createdAt }) =>
      newest === undefined || Date.parse(createdAt) > Date.parse(newest) ? createdAt : newest,
    undefined
  );
}

function cloneValue(value: EphemeralGuideCacheValue): EphemeralGuideCacheValue {
  return ephemeralGuideCacheValueSchema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot encode non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Canonical JSON supports only JSON-compatible values');
}

function isTrustedKnowledgePath(targetPath: string): boolean {
  const normalized = path.normalize(targetPath);
  const pathSegments = normalized.split(path.sep).map((segment) => segment.toLocaleLowerCase('en'));
  return pathSegments.some(
    (segment, index) => segment === 'resources' && pathSegments[index + 1] === 'knowledge'
  );
}

function unsafePathError(): GuideResearchCacheError {
  return new GuideResearchCacheError(
    'GUIDE_RESEARCH_PATH_UNSAFE',
    'Guide research cache path is unsafe'
  );
}

function addDuplicateIssues(
  values: readonly string[],
  pathPrefix: Array<string | number>,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [...pathPrefix, index],
        message: 'IDs must be unique'
      });
    }
    seen.add(value);
  });
}

function containsForbiddenSensitiveText(value: EphemeralGuideCacheValue): boolean {
  const privateText = [
    ...value.matches.flatMap(({ id, subjectId, summary }) => [id, subjectId, summary]),
    ...value.citations.flatMap(({ id, sourceId, title }) => [id, sourceId, title]),
    ...value.applicability.characterNames,
    ...value.applicability.scenarioTags,
    ...value.applicability.buildSignals,
    ...value.conflicts
  ];
  if (privateText.some(isSensitiveFreeText)) return true;
  return value.citations.some(({ url }) => {
    const parsed = new URL(url);
    if (parsed.username.length > 0 || parsed.password.length > 0) return true;
    if (
      Array.from(parsed.searchParams.entries()).some(
        ([key, parameterValue]) =>
          isSensitiveFreeText(key) ||
          isSensitiveFreeText(safelyDecode(parameterValue)) ||
          /^(?:user|users|account|player|profile)(?:[-_]?id)?$/iu.test(key)
      )
    ) {
      return true;
    }
    const decodedPath = safelyDecode(parsed.pathname);
    if (
      isSensitiveFreeText(decodedPath) ||
      /\/(?:uid|user|users|account|player|profile)(?:\/|$)/iu.test(decodedPath)
    ) {
      return true;
    }
    const decodedFragment = safelyDecode(parsed.hash.slice(1));
    return (
      isSensitiveFreeText(decodedFragment) ||
      /(?:^|[/#&])(?:uid|user|users|account|player|profile)(?:[=/:]|$)/iu.test(decodedFragment)
    );
  });
}

function isSensitiveFreeText(text: string): boolean {
  return [
    /private[-_ ]nickname/iu,
    /(?:玩家|用户)\s*uid/iu,
    /(?:^|[^\p{L}\p{N}_])uid(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])nickname(?:[^\p{L}\p{N}_]|$)/iu,
    /昵称|玩家名/iu,
    /(?:^|[^\p{L}\p{N}_])cookie(?:[^\p{L}\p{N}_]|$)|ltoken(?:_v\d+)?|ltuid(?:_v\d+)?/iu,
    /(?:^|[^\p{L}\p{N}_])authorization(?:[^\p{L}\p{N}_]|$)|(?:^|[^\p{L}\p{N}_])bearer(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])api[-_ ]?key(?:[^\p{L}\p{N}_]|$)|(?:^|[^\p{L}\p{N}_])token(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])prompt(?:[^\p{L}\p{N}_]|$)|system[-_ ]prompt/iu,
    /raw[-_ ]sdk[-_ ]message|sdk[-_ ]message|tool[-_ ]payload/iu,
    /full[-_ ]stats|完整面板/iu
  ].some((pattern) => pattern.test(text));
}

function safelyDecode(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    } catch {
      return decoded;
    }
  }
  return decoded;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code?: unknown }).code) === code
  );
}
