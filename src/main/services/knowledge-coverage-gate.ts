import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  CommittedCharacterCatalogEntry,
  KnowledgeContextPacket,
  KnowledgeGap
} from '../../shared/advisor-knowledge.js';
import { weaponTypeSchema } from '../../shared/character-knowledge.js';

const researchReasonSchema = z.enum(['missing', 'stale', 'conflict', 'build-unmatched']);
const guideResearchTextSchema = z.string().trim().min(1).max(120);

const guideResearchCharacterSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    element: z.string().trim().min(1).max(24),
    weaponType: weaponTypeSchema.optional(),
    buildSignals: z.array(guideResearchTextSchema).max(12)
  })
  .strict();

export const guideResearchTaskSchema = z
  .object({
    key: z.string().trim().min(1).max(160),
    reason: researchReasonSchema,
    character: guideResearchCharacterSchema.optional(),
    scenarioTags: z.array(z.string().trim().min(1).max(80)).max(24)
  })
  .strict();

export const knowledgeResearchTaskSchema = guideResearchTaskSchema;

export type GuideResearchTask = z.infer<typeof guideResearchTaskSchema>;
export type KnowledgeResearchTask = GuideResearchTask;

export interface KnowledgeResearchContext {
  characters: ReadonlyArray<{
    id: string;
    name: string;
    element: string;
    weaponType?: string;
    buildSignals?: readonly string[];
  }>;
  scenarioTags: readonly string[];
}

export interface KnowledgeCoverageEvaluation {
  required: boolean;
  tasks: GuideResearchTask[];
}

export interface KnowledgeCoverageCatalog {
  getCatalogEntry(characterId: string): CommittedCharacterCatalogEntry | undefined;
}

const NO_CATALOG: KnowledgeCoverageCatalog = {
  getCatalogEntry: () => undefined
};

const SAFE_SCENARIO_TAGS = new Set([
  'elemental-shield',
  'elemental-armor',
  'shield-absent',
  'high-resistance',
  'elemental-immunity',
  'multi-wave',
  'single-wave-only',
  'groupable',
  'multi-target',
  'ungroupable',
  'heavy-target',
  'single-target',
  'boss',
  'dense-multi-target',
  'survival-pressure',
  'interrupt-pressure',
  'high-incoming-damage',
  'mobile-enemy',
  'burrow',
  'short-damage-window',
  'stationary-target',
  'elemental-aura',
  'reaction-restricted',
  'freeze-immune'
]);

export class KnowledgeCoverageGate {
  constructor(private readonly catalog: KnowledgeCoverageCatalog = NO_CATALOG) {}

  evaluate(
    packet: KnowledgeContextPacket,
    context: KnowledgeResearchContext
  ): KnowledgeCoverageEvaluation {
    const tasks = this.buildTasks(packet, context);
    return { required: tasks.length > 0, tasks };
  }

  plan(packet: KnowledgeContextPacket, context: KnowledgeResearchContext): GuideResearchTask[] {
    return this.evaluate(packet, context).tasks;
  }

  private buildTasks(
    packet: KnowledgeContextPacket,
    context: KnowledgeResearchContext
  ): GuideResearchTask[] {
    const candidateIds = new Set(
      context.characters
        .map(({ id }) => id)
        .filter((id): id is string => typeof id === 'string' && isCanonicalCharacterId(id))
    );
    const interpretationsById = new Map(
      packet.buildInterpretations.map((interpretation) => [
        interpretation.characterId,
        interpretation
      ])
    );
    const scenarioTags = safeScenarioTags(context.scenarioTags);
    const tasksByKey = new Map<string, GuideResearchTask>();

    for (const knowledgeGap of packet.unknowns) {
      if (!isResearchReason(knowledgeGap.kind)) continue;
      const catalogCharacter = this.catalogCharacter(knowledgeGap.subjectId, candidateIds);
      const interpretation =
        catalogCharacter === undefined ? undefined : interpretationsById.get(catalogCharacter.id);
      const character =
        catalogCharacter === undefined
          ? undefined
          : safeCharacterContext(catalogCharacter, interpretation);
      const key = anonymousTaskKey({
        reason: knowledgeGap.kind,
        characterId: catalogCharacter?.id,
        character,
        scenarioTags
      });
      const task = guideResearchTaskSchema.parse({
        key,
        reason: knowledgeGap.kind,
        ...(character === undefined ? {} : { character }),
        scenarioTags
      });
      tasksByKey.set(key, task);
    }

    return Array.from(tasksByKey.values());
  }

  private catalogCharacter(
    subjectId: string,
    candidateIds: ReadonlySet<string>
  ): CommittedCharacterCatalogEntry | undefined {
    if (!candidateIds.has(subjectId) || !isCanonicalCharacterId(subjectId)) return undefined;
    const entry = this.catalog.getCatalogEntry(subjectId);
    if (entry === undefined || entry.id !== subjectId) return undefined;
    return entry;
  }
}

function isResearchReason(kind: KnowledgeGap['kind']): kind is GuideResearchTask['reason'] {
  return researchReasonSchema.safeParse(kind).success;
}

function isCanonicalCharacterId(value: string): boolean {
  return /^1\d{7}$/.test(value);
}

function safeScenarioTags(values: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !SAFE_SCENARIO_TAGS.has(value)) continue;
    tags.add(value);
    if (tags.size === 24) break;
  }
  return Array.from(tags).sort();
}

function safeCharacterContext(
  character: CommittedCharacterCatalogEntry,
  interpretation: KnowledgeContextPacket['buildInterpretations'][number] | undefined
): GuideResearchTask['character'] | undefined {
  const candidate = {
    name: character.name,
    element: character.element,
    ...(weaponTypeSchema.safeParse(character.weaponType).success
      ? { weaponType: weaponTypeSchema.parse(character.weaponType) }
      : {}),
    buildSignals: buildSignalSummary(interpretation)
  };
  const parsed = guideResearchCharacterSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function buildSignalSummary(
  interpretation: KnowledgeContextPacket['buildInterpretations'][number] | undefined
): string[] {
  if (interpretation === undefined) return [];
  return [
    ...(interpretation.matchedSignals.length > 0 ? ['build-match-present'] : []),
    ...(interpretation.conflictingSignals.length > 0 ? ['build-conflict-present'] : []),
    ...(interpretation.unknowns.length > 0 ? ['build-unknown-present'] : [])
  ];
}

function anonymousTaskKey(input: {
  reason: GuideResearchTask['reason'];
  characterId?: string;
  character?: GuideResearchTask['character'];
  scenarioTags: readonly string[];
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        reason: input.reason,
        characterId: input.characterId ?? null,
        buildSignals: input.character?.buildSignals ?? [],
        scenarioTags: input.scenarioTags
      })
    )
    .digest('hex')
    .slice(0, 24);
  return `guide-${input.reason}-${digest}`;
}
