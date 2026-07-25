import { GUIDE_RESEARCH_PROMPT_V1 } from '../agents/research/prompt.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import {
  AgentTurnError,
  runAuditedAgentTurn,
  safeAgentTurnFailureDetails,
  type AgentUsage,
  type AuditedAgentTurn,
  type AuditedAgentRunner
} from './agent-turn-audit.js';
import {
  cacheValueForResearchCandidates,
  combineGuideResearchResult
} from './guide-research-cache-coordinator.js';
import type { EphemeralGuideCacheValue, GuideResearchCache } from './guide-research-cache.js';
import {
  GuideResearchAgentError,
  type GuideResearchAgentResult,
  type GuideResearchCanonicalCharacterIdentity,
  type GuideResearchCanonicalElement,
  type GuideResearchGapCode,
  type GuideResearchSourceRegistryReader,
  type PendingResearchTask
} from './guide-research-contract.js';
import {
  candidateApplicabilityForTask,
  parseResearchOutput,
  type ResearchCandidate
} from './guide-research-output-policy.js';
import {
  buildProjectedResearchQueries,
  canonicalCharacterCatalogSnapshot,
  parseGuideResearchInput,
  projectResearchTask
} from './guide-research-projection.js';
import {
  canonicalGuideSource,
  trustedSourcesByCanonicalHost
} from './guide-research-source-policy.js';
import type { GuideResearchTask } from './knowledge-coverage-gate.js';
import { privacySafeResearchText } from './research-privacy.js';

export { GuideResearchAgentError } from './guide-research-contract.js';
export type {
  GuideResearchAgentErrorCode,
  GuideResearchAgentResult,
  GuideResearchCanonicalCharacterIdentity,
  GuideResearchCanonicalElement,
  GuideResearchEntry,
  GuideResearchGap,
  GuideResearchGapCode,
  GuideResearchSourceRegistryReader
} from './guide-research-contract.js';
export { buildGuideResearchQueries } from './guide-research-projection.js';

export interface GuideResearchAgentOptions {
  runner: AuditedAgentRunner;
  cache: Pick<GuideResearchCache, 'get' | 'put'>;
  sourceRegistry: GuideResearchSourceRegistryReader;
  sdkOptions: AgentSdkRunOptions;
  canonicalCharacterCatalog: readonly GuideResearchCanonicalCharacterIdentity[];
  onUsageDelta?: (usage: AgentUsage) => void;
  now?: () => number;
}

export class GuideResearchAgent {
  private readonly runner: AuditedAgentRunner;
  private readonly cache: Pick<GuideResearchCache, 'get' | 'put'>;
  private readonly sourceRegistry: GuideResearchSourceRegistryReader;
  private readonly sdkOptions: AgentSdkRunOptions;
  private readonly canonicalCharacterCatalog: ReadonlyMap<string, GuideResearchCanonicalElement>;
  private readonly onUsageDelta: ((usage: AgentUsage) => void) | undefined;
  private readonly now: () => number;

  constructor(options: GuideResearchAgentOptions) {
    this.runner = options.runner;
    this.cache = options.cache;
    this.sourceRegistry = options.sourceRegistry;
    this.sdkOptions = options.sdkOptions;
    this.canonicalCharacterCatalog = canonicalCharacterCatalogSnapshot(
      options.canonicalCharacterCatalog
    );
    this.onUsageDelta = options.onUsageDelta;
    this.now = options.now ?? Date.now;
  }

  async research(input: {
    tasks: readonly GuideResearchTask[];
    knowledgeVersion: string;
  }): Promise<GuideResearchAgentResult> {
    const parsed = parseGuideResearchInput(input);
    const safeTasks = parsed.tasks.map((task, index) => {
      const projected = projectResearchTask(
        task,
        `ref-${index + 1}`,
        this.canonicalCharacterCatalog
      );
      if (projected === undefined) {
        throw new GuideResearchAgentError(
          'RESEARCH_TASK_INVALID',
          'Guide research input is not an anonymous coverage-gate task'
        );
      }
      return { task, projected };
    });

    const cachedByKey = new Map<string, EphemeralGuideCacheValue>();
    const misses: PendingResearchTask[] = [];
    for (const pending of safeTasks) {
      const { task } = pending;
      const cached = await this.cache.get({
        task,
        knowledgeVersion: parsed.knowledgeVersion
      });
      if (cached === undefined) misses.push(pending);
      else cachedByKey.set(task.key, cached);
    }
    if (misses.length === 0) {
      return {
        entries: parsed.tasks.map((task) => ({
          taskKey: task.key,
          origin: 'cache',
          value: cachedByKey.get(task.key)!
        })),
        gaps: [],
        searchExecuted: false,
        usage: EMPTY_RESEARCH_USAGE
      };
    }

    const sourcesByHost = trustedSourcesByCanonicalHost(this.sourceRegistry.getSourceRegistry());
    const runtimeMisses = misses.map(({ task, projected }, index) => ({
      task,
      projected: { ...projected, taskRef: `ref-${index + 1}` }
    }));
    const queries = buildProjectedResearchQueries(runtimeMisses.map(({ projected }) => projected));
    const prompt = JSON.stringify({
      searchQueries: queries,
      allowedSourceHosts: [...sourcesByHost.keys()],
      tasks: runtimeMisses.map(({ projected }) => projected)
    });
    if (privacySafeResearchText(prompt) === undefined) {
      throw new GuideResearchAgentError(
        'RESEARCH_TASK_INVALID',
        'Guide research prompt projection failed privacy validation'
      );
    }

    let rawOutput: string;
    let searchedUrls: ReadonlySet<string>;
    let auditedTurn: AuditedAgentTurn;
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
          researchAllowedQueries: queries,
          maxTurns: 4
        },
        systemPrompt: GUIDE_RESEARCH_PROMPT_V1,
        onUsageDelta: this.onUsageDelta,
        normalizeResearchUrl: (url) => canonicalGuideSource(url, sourcesByHost)?.url
      });
      auditedTurn = turn;
      if (turn.toolsTruncated === true) {
        return liveResearchResult(
          combineGuideResearchResult(
            parsed.tasks,
            cachedByKey,
            new Map(),
            gapsFor(runtimeMisses, 'SEARCH_OUTPUT_INVALID')
          ),
          turn
        );
      }
      const resolvedUrls = resolvedSearchUrls(turn.webSearchEvidence, queries, turn.tools);
      if (resolvedUrls === undefined) {
        return liveResearchResult(
          combineGuideResearchResult(
            parsed.tasks,
            cachedByKey,
            new Map(),
            gapsFor(runtimeMisses, 'SEARCH_OUTPUT_INVALID')
          ),
          turn
        );
      }
      searchedUrls = resolvedUrls;
      rawOutput = turn.finalRawText;
    } catch (error) {
      const details = safeAgentTurnFailureDetails(error);
      const safePartialAudit =
        error instanceof AgentTurnError && error.partialTurn !== undefined
          ? privacySafeAudit(error.partialTurn)
          : undefined;
      return {
        ...combineGuideResearchResult(
          parsed.tasks,
          cachedByKey,
          new Map(),
          gapsFor(runtimeMisses, searchFailureCode(error))
        ),
        searchExecuted: true,
        usage:
          safePartialAudit !== undefined
            ? safePartialAudit.usage
            : error instanceof AgentTurnError && error.usage !== undefined
            ? error.usage
            : EMPTY_RESEARCH_USAGE,
        ...(safePartialAudit === undefined ? {} : { audit: safePartialAudit }),
        ...(details.sdkCode === undefined
          ? {}
          : {
              failure: {
                sdkCode: details.sdkCode,
                ...(details.httpStatus === undefined
                  ? {}
                  : { httpStatus: details.httpStatus })
              }
            })
      };
    }

    const decoded = parseResearchOutput(rawOutput);
    if (decoded === undefined) {
      return liveResearchResult(
        combineGuideResearchResult(
          parsed.tasks,
          cachedByKey,
          new Map(),
          gapsFor(runtimeMisses, 'SEARCH_OUTPUT_INVALID')
        ),
        auditedTurn
      );
    }

    const missingByRef = new Map(
      runtimeMisses.map((pending) => [pending.projected.taskRef, pending])
    );
    const seenRefs = new Set<string>();
    if (
      decoded.results.some(({ taskRef }) => {
        if (!missingByRef.has(taskRef) || seenRefs.has(taskRef)) return true;
        seenRefs.add(taskRef);
        return false;
      })
    ) {
      return liveResearchResult(
        combineGuideResearchResult(
          parsed.tasks,
          cachedByKey,
          new Map(),
          gapsFor(runtimeMisses, 'SEARCH_OUTPUT_INVALID')
        ),
        auditedTurn
      );
    }

    const acceptedByKey = new Map<string, ResearchCandidate[]>();
    for (const candidate of decoded.results) {
      const pending = missingByRef.get(candidate.taskRef);
      if (pending === undefined) continue;
      const applicability = candidateApplicabilityForTask(candidate, pending.projected);
      if (applicability === undefined) continue;
      const source = canonicalGuideSource(candidate.source.url, sourcesByHost);
      if (source === undefined || !searchedUrls.has(source.url)) continue;
      const accepted = acceptedByKey.get(pending.task.key) ?? [];
      accepted.push({
        ...candidate,
        applicability,
        source: {
          ...candidate.source,
          url: source.url
        }
      });
      acceptedByKey.set(pending.task.key, accepted);
    }

    const researchedByKey = new Map<string, EphemeralGuideCacheValue>();
    const gapsByKey = new Map<string, GuideResearchGapCode>();
    for (const { task } of runtimeMisses) {
      const candidates = acceptedByKey.get(task.key) ?? [];
      if (candidates.length === 0) {
        gapsByKey.set(task.key, 'SEARCH_NO_VALID_RESULTS');
        continue;
      }
      const value = cacheValueForResearchCandidates(
        task,
        candidates,
        sourcesByHost,
        this.currentIsoTime()
      );
      if (value === undefined) {
        gapsByKey.set(task.key, 'SEARCH_NO_VALID_RESULTS');
        continue;
      }
      try {
        await this.cache.put({
          task,
          knowledgeVersion: parsed.knowledgeVersion,
          value
        });
        researchedByKey.set(task.key, value);
      } catch {
        gapsByKey.set(task.key, 'SEARCH_CACHE_UNAVAILABLE');
      }
    }
    return liveResearchResult(
      combineGuideResearchResult(parsed.tasks, cachedByKey, researchedByKey, gapsByKey),
      auditedTurn
    );
  }

  private currentIsoTime(): string {
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new GuideResearchAgentError('RESEARCH_TASK_INVALID', 'Guide research clock is invalid');
    }
    return new Date(now).toISOString();
  }
}

const EMPTY_RESEARCH_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0
};

function liveResearchResult(
  result: Pick<GuideResearchAgentResult, 'entries' | 'gaps'>,
  audit: AuditedAgentTurn
): GuideResearchAgentResult {
  const safeAudit = privacySafeAudit(audit);
  return {
    ...result,
    searchExecuted: true,
    usage: safeAudit.usage,
    audit: safeAudit
  };
}

function privacySafeAudit(audit: AuditedAgentTurn): AuditedAgentTurn {
  const finalRawText = safeAuditText(audit.finalRawText);
  return {
    ...structuredClone(audit),
    text: finalRawText,
    finalRawText,
    rawMessagesSummary: {
      ...structuredClone(audit.rawMessagesSummary),
      messages: audit.rawMessagesSummary.messages.map((message) => ({
        ...structuredClone(message),
        ...(message.textPreview === undefined
          ? {}
          : { textPreview: safeAuditText(message.textPreview) }),
        textTruncated:
          message.textTruncated ||
          (message.textPreview !== undefined &&
            privacySafeResearchText(message.textPreview) === undefined)
      }))
    }
  };
}

function safeAuditText(value: string): string {
  return privacySafeResearchText(value) ?? '[REDACTED]';
}

function gapsFor(
  misses: readonly PendingResearchTask[],
  code: GuideResearchGapCode
): Map<string, GuideResearchGapCode> {
  return new Map(misses.map(({ task }) => [task.key, code]));
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

function resolvedSearchUrls(
  evidence: {
    attempts: ReadonlyArray<{
      toolUseId: string;
      query?: string;
      status: string;
      urls: readonly string[];
    }>;
    truncated: boolean;
  },
  allowedQueries: readonly string[],
  tools: ReadonlyArray<{
    id: string;
    name: string;
    input: Readonly<Record<string, unknown>>;
    succeeded: boolean;
  }>
): ReadonlySet<string> | undefined {
  if (
    evidence.truncated ||
    evidence.attempts.length < 1 ||
    evidence.attempts.length > 3 ||
    tools.length !== evidence.attempts.length
  ) {
    return undefined;
  }
  const allowed = new Set(allowedQueries);
  const evidenceById = new Map(evidence.attempts.map((attempt) => [attempt.toolUseId, attempt]));
  if (evidenceById.size !== evidence.attempts.length) return undefined;
  for (const tool of tools) {
    const attempt = evidenceById.get(tool.id);
    const inputKeys = Object.keys(tool.input);
    const query =
      typeof tool.input['query'] === 'string'
        ? privacySafeResearchText(tool.input['query'])
        : undefined;
    if (
      tool.name !== 'WebSearch' ||
      !tool.succeeded ||
      inputKeys.length !== 1 ||
      inputKeys[0] !== 'query' ||
      attempt === undefined ||
      query === undefined ||
      query !== attempt.query
    ) {
      return undefined;
    }
  }
  const urls = new Set<string>();
  for (const attempt of evidence.attempts) {
    if (
      attempt.status !== 'resolved' ||
      attempt.query === undefined ||
      !allowed.has(attempt.query) ||
      attempt.urls.length === 0
    ) {
      return undefined;
    }
    attempt.urls.forEach((url) => urls.add(url));
  }
  return urls.size === 0 ? undefined : urls;
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
