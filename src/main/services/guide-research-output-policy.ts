import { z } from 'zod';

import type { SanitizedResearchTask } from './guide-research-contract.js';
import { privacySafeResearchText } from './research-privacy.js';

const boundedTextSchema = z.string().trim().min(1).max(700);
const boundedListTextSchema = z.string().trim().min(1).max(160);
const researchOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    results: z
      .array(
        z
          .object({
            taskRef: z.string().trim().min(1).max(80),
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

export type ResearchCandidate = z.infer<typeof researchOutputSchema>['results'][number];

export function parseResearchOutput(
  value: string
): z.infer<typeof researchOutputSchema> | undefined {
  try {
    const decoded: unknown = JSON.parse(value);
    const parsed = researchOutputSchema.safeParse(decoded);
    if (!parsed.success) return undefined;
    const results = parsed.data.results.map(sanitizeProviderCandidate);
    if (results.some((candidate) => candidate === undefined)) return undefined;
    return {
      schemaVersion: 1,
      results: results as ResearchCandidate[]
    };
  } catch {
    return undefined;
  }
}

function sanitizeProviderCandidate(candidate: ResearchCandidate): ResearchCandidate | undefined {
  const summary = privacySafeResearchText(candidate.summary);
  const title = privacySafeResearchText(candidate.source.title);
  const timelineClue = privacySafeResearchText(candidate.source.timelineClue);
  const conflicts = candidate.conflicts.map(privacySafeResearchText);
  // The durable cache owns its own schema. This stricter provider boundary rejects
  // account-shaped material before any cache write is attempted.
  if (
    summary === undefined ||
    title === undefined ||
    timelineClue === undefined ||
    privacySafeResearchText(candidate.source.url) === undefined ||
    conflicts.some((conflict) => conflict === undefined)
  ) {
    return undefined;
  }
  return {
    ...candidate,
    summary,
    source: {
      url: candidate.source.url,
      title,
      timelineClue
    },
    conflicts: conflicts as string[]
  };
}

export function candidateApplicabilityForTask(
  candidate: ResearchCandidate,
  task: SanitizedResearchTask
): ResearchCandidate['applicability'] | undefined {
  const characterNames = normalizedUniqueList(candidate.applicability.characterNames);
  const scenarioTags = normalizedUniqueList(candidate.applicability.scenarioTags);
  const buildSignals = normalizedUniqueList(candidate.applicability.buildSignals);
  const expectedCharacterNames = task.character === undefined ? [] : [task.character.name];
  const expectedBuildSignals = task.character?.buildSignals ?? [];
  if (
    characterNames === undefined ||
    scenarioTags === undefined ||
    buildSignals === undefined ||
    !sameStringSet(characterNames, expectedCharacterNames) ||
    !sameStringSet(scenarioTags, task.scenarioTags) ||
    !sameStringSet(buildSignals, expectedBuildSignals)
  ) {
    return undefined;
  }
  return { characterNames, scenarioTags, buildSignals };
}

function normalizedUniqueList(values: readonly string[]): string[] | undefined {
  const normalized = values.map(privacySafeResearchText);
  if (
    normalized.some((value) => value === undefined) ||
    new Set(normalized).size !== normalized.length
  ) {
    return undefined;
  }
  return normalized as string[];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
