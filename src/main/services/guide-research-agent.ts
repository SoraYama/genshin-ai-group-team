import { createHash } from 'node:crypto';

import { z } from 'zod';

import { GUIDE_RESEARCH_PROMPT_V1 } from '../agents/research/prompt.js';
import { scenarioMechanicTagSchema } from '../../shared/advisor-scenario-taxonomy.js';
import {
  ephemeralGuideCacheValueSchema,
  type EphemeralGuideCacheValue,
  type GuideResearchCache
} from './guide-research-cache.js';
import { guideResearchTaskSchema, type GuideResearchTask } from './knowledge-coverage-gate.js';
import {
  AgentTurnError,
  runAuditedAgentTurn,
  type AuditedAgentRunner
} from './agent-turn-audit.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';

const knowledgeVersionSchema = z.string().trim().min(1).max(128);
const boundedTextSchema = z.string().trim().min(1).max(700);
const boundedListTextSchema = z.string().trim().min(1).max(160);
const sourceRegistryResultSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            id: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
            host: z.string().trim().min(1).max(253)
          })
          .passthrough()
      )
      .min(1)
      .max(128)
  })
  .passthrough();
const researchOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    results: z
      .array(
        z
          .object({
            taskKey: z.string().trim().min(1).max(160),
            summary: boundedTextSchema,
            applicability: z
              .object({
                characterNames: z.array(boundedListTextSchema).max(32),
                scenarioTags: z.array(boundedListTextSchema).max(32),
                buildSignals: z.array(boundedListTextSchema).max(32)
              })
              .strict(),
            source: z
              .object({
                url: z.string().trim().min(1).max(2_048),
                title: z.string().trim().min(1).max(200),
                timelineClue: z.string().trim().min(1).max(240)
              })
              .strict(),
            conflicts: z.array(z.string().trim().min(1).max(500)).max(32)
          })
          .strict()
      )
      .max(48)
  })
  .strict();

const researchInputSchema = z
  .object({
    tasks: z.array(guideResearchTaskSchema).min(1).max(256),
    knowledgeVersion: knowledgeVersionSchema
  })
  .strict()
  .superRefine(({ tasks }, context) => {
    const keys = new Set<string>();
    tasks.forEach((task, index) => {
      if (keys.has(task.key)) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', index, 'key'],
          message: 'Guide research task keys must be unique'
        });
      }
      keys.add(task.key);
      if (!isAnonymousTask(task)) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', index],
          message: 'Guide research tasks must use the anonymous coverage-gate shape'
        });
      }
    });
  });

type ResearchCandidate = z.infer<typeof researchOutputSchema>['results'][number];
type SourceRegistryResult = z.infer<typeof sourceRegistryResultSchema>;

export type GuideResearchGapCode =
  | 'SEARCH_UNAVAILABLE'
  | 'SEARCH_BUDGET_EXCEEDED'
  | 'SEARCH_OUTPUT_INVALID'
  | 'SEARCH_NO_VALID_RESULTS';

export type GuideResearchAgentErrorCode = 'RESEARCH_TASK_INVALID';

export class GuideResearchAgentError extends Error {
  override readonly name = 'GuideResearchAgentError';

  constructor(
    readonly code: GuideResearchAgentErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

export interface GuideResearchSourceRegistryReader {
  getSourceRegistry(): {
    sources: ReadonlyArray<{
      id: string;
      host: string;
    }>;
  };
}

export interface GuideResearchAgentOptions {
  runner: AuditedAgentRunner;
  cache: Pick<GuideResearchCache, 'get' | 'put'>;
  sourceRegistry: GuideResearchSourceRegistryReader;
  sdkOptions: AgentSdkRunOptions;
  now?: () => number;
}

export interface GuideResearchEntry {
  taskKey: string;
  origin: 'cache' | 'research';
  value: EphemeralGuideCacheValue;
}

export interface GuideResearchGap {
  taskKey: string;
  code: GuideResearchGapCode;
}

export interface GuideResearchAgentResult {
  entries: GuideResearchEntry[];
  gaps: GuideResearchGap[];
}

export function buildGuideResearchQueries(tasks: readonly GuideResearchTask[]): string[] {
  if (tasks.length === 0) return [];
  const bucketCount = Math.min(3, tasks.length);
  const buckets = Array.from({ length: bucketCount }, () => new Set<string>());
  tasks.forEach((task, index) => {
    const bucket = buckets[index % bucketCount]!;
    const terms = [
      task.character?.name,
      task.character?.element,
      task.character?.weaponType,
      ...(task.character?.buildSignals ?? []),
      ...task.scenarioTags
    ];
    terms.forEach((term) => {
      const safe = safeQueryTerm(term);
      if (safe !== undefined) bucket.add(safe);
    });
  });
  return buckets.map((terms) => ['原神', '配队', '攻略', ...terms].join(' ').slice(0, 300).trim());
}

export class GuideResearchAgent {
  private readonly runner: AuditedAgentRunner;
  private readonly cache: Pick<GuideResearchCache, 'get' | 'put'>;
  private readonly sourceRegistry: GuideResearchSourceRegistryReader;
  private readonly sdkOptions: AgentSdkRunOptions;
  private readonly now: () => number;

  constructor(options: GuideResearchAgentOptions) {
    this.runner = options.runner;
    this.cache = options.cache;
    this.sourceRegistry = options.sourceRegistry;
    this.sdkOptions = options.sdkOptions;
    this.now = options.now ?? Date.now;
  }

  async research(input: {
    tasks: readonly GuideResearchTask[];
    knowledgeVersion: string;
  }): Promise<GuideResearchAgentResult> {
    const parsed = researchInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new GuideResearchAgentError(
        'RESEARCH_TASK_INVALID',
        'Guide research input is not an anonymous coverage-gate task',
        { cause: parsed.error }
      );
    }

    const cachedByKey = new Map<string, EphemeralGuideCacheValue>();
    const misses: GuideResearchTask[] = [];
    for (const task of parsed.data.tasks) {
      const cached = await this.cache.get({
        task,
        knowledgeVersion: parsed.data.knowledgeVersion
      });
      if (cached === undefined) misses.push(task);
      else cachedByKey.set(task.key, cached);
    }
    if (misses.length === 0) {
      return {
        entries: parsed.data.tasks.map((task) => ({
          taskKey: task.key,
          origin: 'cache',
          value: cachedByKey.get(task.key)!
        })),
        gaps: []
      };
    }

    const registry = sourceRegistryResultSchema.parse(this.sourceRegistry.getSourceRegistry());
    const sourcesByHost = sourcesByCanonicalHost(registry);
    const queries = buildGuideResearchQueries(misses);
    const prompt = JSON.stringify({
      searchQueries: queries,
      allowedSourceHosts: [...sourcesByHost.keys()],
      tasks: misses
    });

    let rawOutput: string;
    try {
      const turn = await runAuditedAgentTurn({
        runner: this.runner,
        prompt,
        sdkOptions: {
          ...this.sdkOptions,
          systemPrompt: GUIDE_RESEARCH_PROMPT_V1,
          mcpServers: undefined,
          allowedBusinessTools: [],
          nativeToolPolicy: {
            purpose: 'research',
            allowed: ['WebSearch'],
            maxSearches: 3
          },
          maxTurns: 4
        },
        systemPrompt: GUIDE_RESEARCH_PROMPT_V1
      });
      rawOutput = turn.finalRawText;
    } catch (error) {
      const code = searchFailureCode(error);
      return combineResult(
        parsed.data.tasks,
        cachedByKey,
        new Map(),
        new Map(misses.map((task) => [task.key, code]))
      );
    }

    const decoded = parseResearchOutput(rawOutput);
    if (decoded === undefined) {
      return combineResult(
        parsed.data.tasks,
        cachedByKey,
        new Map(),
        new Map(misses.map((task) => [task.key, 'SEARCH_OUTPUT_INVALID' as const]))
      );
    }

    const missingByKey = new Map(misses.map((task) => [task.key, task]));
    const acceptedByKey = new Map<string, ResearchCandidate[]>();
    for (const candidate of decoded.results) {
      const task = missingByKey.get(candidate.taskKey);
      if (task === undefined || !candidateAppliesToTask(candidate, task)) continue;
      const source = canonicalSource(candidate.source.url, sourcesByHost);
      if (source === undefined) continue;
      const accepted = acceptedByKey.get(task.key) ?? [];
      accepted.push({
        ...candidate,
        source: {
          ...candidate.source,
          url: source.url
        }
      });
      acceptedByKey.set(task.key, accepted);
    }

    const researchedByKey = new Map<string, EphemeralGuideCacheValue>();
    const gapsByKey = new Map<string, GuideResearchGapCode>();
    for (const task of misses) {
      const candidates = acceptedByKey.get(task.key) ?? [];
      if (candidates.length === 0) {
        gapsByKey.set(task.key, 'SEARCH_NO_VALID_RESULTS');
        continue;
      }
      const value = cacheValueFor(task, candidates, sourcesByHost, this.currentIsoTime());
      if (value === undefined) {
        gapsByKey.set(task.key, 'SEARCH_NO_VALID_RESULTS');
        continue;
      }
      await this.cache.put({
        task,
        knowledgeVersion: parsed.data.knowledgeVersion,
        value
      });
      researchedByKey.set(task.key, value);
    }
    return combineResult(parsed.data.tasks, cachedByKey, researchedByKey, gapsByKey);
  }

  private currentIsoTime(): string {
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new GuideResearchAgentError('RESEARCH_TASK_INVALID', 'Guide research clock is invalid');
    }
    return new Date(now).toISOString();
  }
}

function combineResult(
  tasks: readonly GuideResearchTask[],
  cachedByKey: ReadonlyMap<string, EphemeralGuideCacheValue>,
  researchedByKey: ReadonlyMap<string, EphemeralGuideCacheValue>,
  gapsByKey: ReadonlyMap<string, GuideResearchGapCode>
): GuideResearchAgentResult {
  const entries: GuideResearchEntry[] = [];
  const gaps: GuideResearchGap[] = [];
  tasks.forEach((task) => {
    const cached = cachedByKey.get(task.key);
    const researched = researchedByKey.get(task.key);
    if (cached !== undefined) {
      entries.push({ taskKey: task.key, origin: 'cache', value: cached });
    } else if (researched !== undefined) {
      entries.push({ taskKey: task.key, origin: 'research', value: researched });
    } else {
      gaps.push({
        taskKey: task.key,
        code: gapsByKey.get(task.key) ?? 'SEARCH_NO_VALID_RESULTS'
      });
    }
  });
  return { entries, gaps };
}

function parseResearchOutput(value: string): z.infer<typeof researchOutputSchema> | undefined {
  try {
    const decoded: unknown = JSON.parse(value);
    const parsed = researchOutputSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function sourcesByCanonicalHost(registry: SourceRegistryResult): Map<string, { id: string }> {
  const sources = new Map<string, { id: string }>();
  registry.sources.forEach((source) => {
    const host = canonicalHostname(source.host);
    if (host === undefined || sources.has(host)) {
      throw new GuideResearchAgentError(
        'RESEARCH_TASK_INVALID',
        'Trusted source registry contains an invalid or duplicate host'
      );
    }
    sources.set(host, { id: source.id });
  });
  return sources;
}

function canonicalSource(
  value: string,
  sourcesByHost: ReadonlyMap<string, { id: string }>
): { sourceId: string; url: string } | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0
  ) {
    return undefined;
  }
  const hostname = canonicalHostname(url.hostname);
  if (hostname === undefined) return undefined;
  const source = sourcesByHost.get(hostname);
  if (source === undefined) return undefined;
  url.hostname = hostname;
  return { sourceId: source.id, url: url.href };
}

function canonicalHostname(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/\.$/u, '');
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      normalized
    )
  ) {
    return undefined;
  }
  return normalized;
}

function candidateAppliesToTask(candidate: ResearchCandidate, task: GuideResearchTask): boolean {
  if (
    task.character !== undefined &&
    !candidate.applicability.characterNames.includes(task.character.name)
  ) {
    return false;
  }
  return (
    task.scenarioTags.length === 0 ||
    candidate.applicability.scenarioTags.some((tag) => task.scenarioTags.includes(tag))
  );
}

function cacheValueFor(
  task: GuideResearchTask,
  candidates: readonly ResearchCandidate[],
  sourcesByHost: ReadonlyMap<string, { id: string }>,
  researchedAt: string
): EphemeralGuideCacheValue | undefined {
  const records = candidates.flatMap((candidate, index) => {
    const source = canonicalSource(candidate.source.url, sourcesByHost);
    if (source === undefined) return [];
    const digest = createHash('sha256')
      .update(`${task.key}\n${index}\n${source.url}\n${candidate.summary}`)
      .digest('hex')
      .slice(0, 24);
    const citationId = `web-citation-${digest}`;
    return [
      {
        match: {
          id: `web-match-${digest}`,
          subjectId: `guide-subject-${taskDigest(task.key)}`,
          summary: `${candidate.summary}\n页面时间线索：${candidate.source.timelineClue}`.slice(
            0,
            1_000
          ),
          citationIds: [citationId]
        },
        citation: {
          id: citationId,
          sourceId: source.sourceId,
          url: source.url,
          title: candidate.source.title,
          reviewedAt: researchedAt,
          trust: 'ephemeral-web' as const
        }
      }
    ];
  });
  const parsed = ephemeralGuideCacheValueSchema.safeParse({
    trust: 'ephemeral-web',
    matches: records.map(({ match }) => match),
    citations: records.map(({ citation }) => citation),
    applicability: {
      characterNames: uniqueBounded(
        candidates.flatMap(({ applicability }) => applicability.characterNames)
      ),
      scenarioTags: uniqueBounded(
        candidates.flatMap(({ applicability }) => applicability.scenarioTags)
      ),
      buildSignals: uniqueBounded(
        candidates.flatMap(({ applicability }) => applicability.buildSignals)
      )
    },
    conflicts: uniqueBounded(
      candidates.flatMap(({ conflicts }) => conflicts),
      64
    ),
    researchedAt
  });
  return parsed.success ? parsed.data : undefined;
}

function uniqueBounded(values: readonly string[], max = 32): string[] {
  return Array.from(new Set(values)).slice(0, max);
}

function taskDigest(taskKey: string): string {
  return createHash('sha256').update(taskKey).digest('hex').slice(0, 24);
}

function safeQueryTerm(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Number}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  if (normalized.length === 0 || containsSensitiveLabel(normalized)) return undefined;
  return normalized;
}

function isAnonymousTask(task: GuideResearchTask): boolean {
  if (
    !task.scenarioTags.every((tag) => scenarioMechanicTagSchema.safeParse(tag).success) ||
    !(task.character?.buildSignals ?? []).every((signal) =>
      ['build-match-present', 'build-conflict-present', 'build-unknown-present'].includes(signal)
    )
  ) {
    return false;
  }
  const visibleText = [
    task.key,
    task.character?.name,
    task.character?.element,
    task.character?.weaponType,
    ...(task.character?.buildSignals ?? []),
    ...task.scenarioTags
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');
  return !containsSensitiveLabel(visibleText);
}

function containsSensitiveLabel(value: string): boolean {
  return /(?:\buid\b|昵称|cookie|authorization|api[-_ ]?key|bearer\s|ltoken|ltuid|ltmid|sk-[a-z0-9_-]+|crit(?:ical)?[-_ ]?(?:rate|dmg)|暴击(?:率|伤害)?|攻击力|生命值|防御力)/iu.test(
    value
  );
}

function searchFailureCode(error: unknown): GuideResearchGapCode {
  const diagnostic = errorDiagnosticText(error);
  if (/SEARCH_BUDGET_EXCEEDED/iu.test(diagnostic)) return 'SEARCH_BUDGET_EXCEEDED';
  if (
    /WebSearch/iu.test(diagnostic) &&
    /(?:not supported|unsupported|unavailable|unknown tool|not available)/iu.test(diagnostic)
  ) {
    return 'SEARCH_UNAVAILABLE';
  }
  if (error instanceof AgentTurnError && error.code === 'AGENT_TURN_RESULT_ERROR') {
    return 'SEARCH_UNAVAILABLE';
  }
  return 'SEARCH_UNAVAILABLE';
}

function errorDiagnosticText(error: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (error instanceof Error) {
    return `${error.message} ${errorDiagnosticText(error.cause, depth + 1)}`;
  }
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error).slice(0, 8_000);
    } catch {
      return '';
    }
  }
  return '';
}
