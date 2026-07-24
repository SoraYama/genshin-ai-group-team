import { createHash } from 'node:crypto';

import {
  type GuideResearchAgentResult,
  type GuideResearchGapCode,
  type GuideResearchSourcesByHost
} from './guide-research-contract.js';
import {
  ephemeralGuideCacheValueSchema,
  type EphemeralGuideCacheValue
} from './guide-research-cache.js';
import type { ResearchCandidate } from './guide-research-output-policy.js';
import { canonicalGuideSource } from './guide-research-source-policy.js';
import type { GuideResearchTask } from './knowledge-coverage-gate.js';

export function combineGuideResearchResult(
  tasks: readonly GuideResearchTask[],
  cachedByKey: ReadonlyMap<string, EphemeralGuideCacheValue>,
  researchedByKey: ReadonlyMap<string, EphemeralGuideCacheValue>,
  gapsByKey: ReadonlyMap<string, GuideResearchGapCode>
): GuideResearchAgentResult {
  const entries: GuideResearchAgentResult['entries'] = [];
  const gaps: GuideResearchAgentResult['gaps'] = [];
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

export function cacheValueForResearchCandidates(
  task: GuideResearchTask,
  candidates: readonly ResearchCandidate[],
  sourcesByHost: GuideResearchSourcesByHost,
  researchedAt: string
): EphemeralGuideCacheValue | undefined {
  const records = candidates.flatMap((candidate, index) => {
    const source = canonicalGuideSource(candidate.source.url, sourcesByHost);
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
