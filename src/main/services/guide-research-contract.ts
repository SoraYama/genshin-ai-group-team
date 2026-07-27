import { z } from 'zod';

import { elementalTypeSchema } from '../../shared/scenario-v2.js';
import type { EphemeralGuideCacheValue } from './guide-research-cache.js';
import type { GuideResearchTask } from './knowledge-coverage-gate.js';
import type {
  AgentTurnErrorCode,
  AgentUsage,
  AuditedAgentTurn
} from './agent-turn-audit.js';

export type GuideResearchGapCode =
  | 'SEARCH_UNAVAILABLE'
  | 'SEARCH_BUDGET_EXCEEDED'
  | 'SEARCH_OUTPUT_INVALID'
  | 'SEARCH_NO_VALID_RESULTS'
  | 'SEARCH_CACHE_UNAVAILABLE';

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
      trust: 'trusted-local';
    }>;
  };
}

export type GuideResearchCanonicalElement = z.infer<typeof elementalTypeSchema> | 'unknown';

export interface GuideResearchCanonicalCharacterIdentity {
  readonly name: string;
  readonly element: GuideResearchCanonicalElement;
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
  searchExecuted?: boolean;
  usage?: AgentUsage;
  audit?: AuditedAgentTurn;
  directSearchAudit?: {
    provider: 'zhipu-web-search';
    attempts: Array<{
      query: string;
      status: 'resolved' | 'error';
      urls: string[];
    }>;
  };
  failure?: {
    sdkCode: AgentTurnErrorCode;
    httpStatus?: number;
  };
}

export interface SanitizedResearchTask {
  taskRef: string;
  reason: GuideResearchTask['reason'];
  character?: NonNullable<GuideResearchTask['character']>;
  scenarioTags: string[];
}

export interface PendingResearchTask {
  task: GuideResearchTask;
  projected: SanitizedResearchTask;
}

export type GuideResearchSourcesByHost = ReadonlyMap<string, { id: string }>;
