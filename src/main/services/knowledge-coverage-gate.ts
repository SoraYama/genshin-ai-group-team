import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  CommittedCharacterCatalogEntry,
  EnemyMechanicStrategy,
  KnowledgeContextPacket,
  KnowledgeGap
} from '../../shared/advisor-knowledge.js';
import { weaponTypeSchema } from '../../shared/character-knowledge.js';
import { safeScenarioMechanicTags } from './advisor-scenario-taxonomy.js';

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
  targetKey?: string;
}

export interface KnowledgeCoverageEvaluation {
  required: boolean;
  tasks: GuideResearchTask[];
  bindings: Array<{
    taskKey: string;
    unknownIndexes: number[];
    unknownIds?: string[];
    targetKeys?: string[];
  }>;
}

export interface KnowledgeCoverageKnowledge {
  getCatalogEntry(characterId: string): CommittedCharacterCatalogEntry | undefined;
  getMechanicStrategy(mechanicId: string): EnemyMechanicStrategy | undefined;
}

export class KnowledgeCoverageGate {
  private readonly knowledge: KnowledgeCoverageKnowledge;

  constructor(knowledge: KnowledgeCoverageKnowledge) {
    if (
      knowledge === undefined ||
      typeof knowledge.getCatalogEntry !== 'function' ||
      typeof knowledge.getMechanicStrategy !== 'function'
    ) {
      throw new Error('KnowledgeCoverageGate requires an explicit trusted knowledge resolver');
    }
    this.knowledge = knowledge;
  }

  evaluate(
    packet: KnowledgeContextPacket,
    context: KnowledgeResearchContext
  ): KnowledgeCoverageEvaluation {
    const { tasks, bindings } = this.buildTasks(packet, context);
    return { required: tasks.length > 0, tasks, bindings };
  }

  plan(packet: KnowledgeContextPacket, context: KnowledgeResearchContext): GuideResearchTask[] {
    return this.evaluate(packet, context).tasks;
  }

  private buildTasks(
    packet: KnowledgeContextPacket,
    context: KnowledgeResearchContext
  ): Pick<KnowledgeCoverageEvaluation, 'tasks' | 'bindings'> {
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
    const contextScenarioTags = safeScenarioMechanicTags(context.scenarioTags);
    const tasksByKey = new Map<string, GuideResearchTask>();
    const unknownIndexesByTaskKey = new Map<string, number[]>();

    for (const [unknownIndex, knowledgeGap] of packet.unknowns.entries()) {
      if (!isResearchReason(knowledgeGap.kind)) continue;
      const catalogCharacter = this.catalogCharacter(knowledgeGap.subjectId, candidateIds);
      const mechanic = this.mechanicForGap(knowledgeGap.subjectId);
      const interpretation =
        catalogCharacter === undefined ? undefined : interpretationsById.get(catalogCharacter.id);
      const character =
        catalogCharacter === undefined
          ? undefined
          : safeCharacterContext(catalogCharacter, interpretation);
      const scenarioTags = safeScenarioMechanicTags([
        ...contextScenarioTags,
        ...(mechanic?.matchTags ?? [])
      ]);
      const key = anonymousTaskKey({
        reason: knowledgeGap.kind,
        characterId: catalogCharacter?.id,
        mechanicId: mechanic?.id,
        character,
        scenarioTags,
        targetKey: context.targetKey
      });
      const task = guideResearchTaskSchema.parse({
        key,
        reason: knowledgeGap.kind,
        ...(character === undefined ? {} : { character }),
        scenarioTags
      });
      tasksByKey.set(key, task);
      const unknownIndexes = unknownIndexesByTaskKey.get(key) ?? [];
      unknownIndexes.push(unknownIndex);
      unknownIndexesByTaskKey.set(key, unknownIndexes);
    }

    const tasks = Array.from(tasksByKey.values());
    return {
      tasks,
      bindings: tasks.map(({ key }) => ({
        taskKey: key,
        unknownIndexes: unknownIndexesByTaskKey.get(key) ?? [],
        ...(context.targetKey === undefined ? {} : { targetKeys: [context.targetKey] })
      }))
    };
  }

  private catalogCharacter(
    subjectId: string,
    candidateIds: ReadonlySet<string>
  ): CommittedCharacterCatalogEntry | undefined {
    if (!candidateIds.has(subjectId) || !isCanonicalCharacterId(subjectId)) return undefined;
    const entry = this.knowledge.getCatalogEntry(subjectId);
    if (entry === undefined || entry.id !== subjectId) return undefined;
    return entry;
  }

  private mechanicForGap(subjectId: string): EnemyMechanicStrategy | undefined {
    const match = /^mechanic:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(subjectId);
    if (match === null) return undefined;
    const mechanic = this.knowledge.getMechanicStrategy(match[1]!);
    return mechanic?.id === match[1] ? mechanic : undefined;
  }
}

function isResearchReason(kind: KnowledgeGap['kind']): kind is GuideResearchTask['reason'] {
  return researchReasonSchema.safeParse(kind).success;
}

function isCanonicalCharacterId(value: string): boolean {
  return /^1\d{7}$/.test(value);
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
  mechanicId?: string;
  character?: GuideResearchTask['character'];
  scenarioTags: readonly string[];
  targetKey?: string;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        reason: input.reason,
        characterId: input.characterId ?? null,
        mechanicId: input.mechanicId ?? null,
        buildSignals: input.character?.buildSignals ?? [],
        scenarioTags: input.scenarioTags,
        targetKey: input.targetKey ?? null
      })
    )
    .digest('hex')
    .slice(0, 24);
  return `guide-${input.reason}-${digest}`;
}
