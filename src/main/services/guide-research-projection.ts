import { z } from 'zod';

import { scenarioMechanicTagSchema } from '../../shared/advisor-scenario-taxonomy.js';
import { elementalTypeSchema } from '../../shared/scenario-v2.js';
import {
  GuideResearchAgentError,
  type GuideResearchCanonicalCharacterIdentity,
  type GuideResearchCanonicalElement,
  type SanitizedResearchTask
} from './guide-research-contract.js';
import { guideResearchTaskSchema, type GuideResearchTask } from './knowledge-coverage-gate.js';
import { privacySafeResearchText } from './research-privacy.js';

const knowledgeVersionSchema = z.string().trim().min(1).max(128);
const canonicalCatalogElementSchema = elementalTypeSchema.or(z.literal('unknown'));
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
    });
  });

export function parseGuideResearchInput(input: unknown): {
  tasks: GuideResearchTask[];
  knowledgeVersion: string;
} {
  const parsed = researchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new GuideResearchAgentError(
      'RESEARCH_TASK_INVALID',
      'Guide research input is not an anonymous coverage-gate task',
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

export function buildGuideResearchQueries(tasks: readonly GuideResearchTask[]): string[] {
  return buildQueries(
    tasks.map((task) => ({
      character: task.character,
      scenarioTags: task.scenarioTags
    }))
  );
}

export function buildProjectedResearchQueries(tasks: readonly SanitizedResearchTask[]): string[] {
  return buildQueries(tasks);
}

function buildQueries(
  tasks: ReadonlyArray<{
    character?: GuideResearchTask['character'];
    scenarioTags: readonly string[];
  }>
): string[] {
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

function safeQueryTerm(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = privacySafeResearchText(value);
  if (safe === undefined) return undefined;
  const normalized = safe
    .replace(/\p{Number}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  return normalized.length === 0 ? undefined : normalized;
}

export function canonicalCharacterCatalogSnapshot(
  catalog: readonly GuideResearchCanonicalCharacterIdentity[]
): ReadonlyMap<string, GuideResearchCanonicalElement> {
  if (!Array.isArray(catalog)) {
    throw new GuideResearchAgentError(
      'RESEARCH_TASK_INVALID',
      'Guide research requires canonical character identity entries'
    );
  }
  const snapshot = new Map<string, GuideResearchCanonicalElement>();
  for (const identity of catalog) {
    if (
      typeof identity !== 'object' ||
      identity === null ||
      typeof identity.name !== 'string' ||
      typeof identity.element !== 'string'
    ) {
      throw new GuideResearchAgentError(
        'RESEARCH_TASK_INVALID',
        'Canonical character identity entries are invalid'
      );
    }
    const name = privacySafeResearchText(identity.name);
    const element = canonicalCatalogElementSchema.safeParse(
      privacySafeResearchText(identity.element)
    );
    if (name === undefined || name.length === 0 || !element.success) {
      throw new GuideResearchAgentError(
        'RESEARCH_TASK_INVALID',
        'Canonical character identities failed validation'
      );
    }
    const existingElement = snapshot.get(name);
    if (existingElement !== undefined) {
      if (existingElement !== element.data) {
        throw new GuideResearchAgentError(
          'RESEARCH_TASK_INVALID',
          'Canonical character name maps to conflicting elements'
        );
      }
      continue;
    }
    snapshot.set(name, element.data);
  }
  return snapshot;
}

export function projectResearchTask(
  task: GuideResearchTask,
  taskRef: string,
  canonicalCharacterCatalog: ReadonlyMap<string, GuideResearchCanonicalElement>
): SanitizedResearchTask | undefined {
  const scenarioTags = task.scenarioTags.map(privacySafeResearchText);
  if (
    scenarioTags.some((tag) => tag === undefined) ||
    !scenarioTags.every((tag) => scenarioMechanicTagSchema.safeParse(tag).success)
  ) {
    return undefined;
  }
  if (task.character === undefined) {
    return {
      taskRef,
      reason: task.reason,
      scenarioTags: scenarioTags as string[]
    };
  }
  const name = privacySafeResearchText(task.character.name);
  const element = canonicalCatalogElementSchema.safeParse(
    privacySafeResearchText(task.character.element)
  );
  const buildSignals = task.character.buildSignals.map(privacySafeResearchText);
  if (
    name === undefined ||
    !element.success ||
    canonicalCharacterCatalog.get(name) !== element.data ||
    buildSignals.some((signal) => signal === undefined) ||
    !(buildSignals as string[]).every((signal) =>
      ['build-match-present', 'build-conflict-present', 'build-unknown-present'].includes(signal)
    )
  ) {
    return undefined;
  }
  return {
    taskRef,
    reason: task.reason,
    character: {
      name,
      element: element.data,
      ...(task.character.weaponType === undefined ? {} : { weaponType: task.character.weaponType }),
      buildSignals: buildSignals as string[]
    },
    scenarioTags: scenarioTags as string[]
  };
}
