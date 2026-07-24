import { z } from 'zod';

import type { KnowledgeContextPacket, KnowledgeGap } from '../../shared/advisor-knowledge.js';
import { sanitizeTraceText } from '../../shared/agent-run-trace.js';

const researchReasonSchema = z.enum(['missing', 'stale', 'conflict', 'build-unmatched']);
const boundedResearchTextSchema = z.string().trim().min(1).max(160);

export const knowledgeResearchTaskSchema = z
  .object({
    key: z.string().trim().min(1).max(128),
    reason: researchReasonSchema,
    character: z
      .object({
        name: z.string().trim().min(1).max(120),
        element: z.string().trim().min(1).max(32),
        weaponType: z.string().trim().min(1).max(32).optional(),
        buildSignals: z.array(boundedResearchTextSchema).max(12)
      })
      .strict()
      .optional(),
    scenarioTags: z.array(z.string().trim().min(1).max(80)).max(24)
  })
  .strict();

export type KnowledgeResearchTask = z.infer<typeof knowledgeResearchTaskSchema>;

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

export class KnowledgeCoverageGate {
  plan(packet: KnowledgeContextPacket, context: KnowledgeResearchContext): KnowledgeResearchTask[] {
    const charactersById = new Map(
      context.characters.map((character) => [character.id, character])
    );
    const interpretationsById = new Map(
      packet.buildInterpretations.map((interpretation) => [
        interpretation.characterId,
        interpretation
      ])
    );
    const scenarioTags = uniqueSafeStrings(context.scenarioTags, 24, 80);

    return packet.unknowns.flatMap((knowledgeGap) => {
      if (!isResearchReason(knowledgeGap.kind)) return [];
      const character = charactersById.get(knowledgeGap.subjectId);
      const interpretation = interpretationsById.get(knowledgeGap.subjectId);
      const buildSignals = uniqueSafeStrings(
        [
          ...(character?.buildSignals ?? []),
          ...(interpretation?.matchedSignals ?? []),
          ...(interpretation?.conflictingSignals ?? []),
          ...(interpretation?.unknowns ?? [])
        ],
        12,
        160
      );
      const task = {
        key: knowledgeGap.id,
        reason: knowledgeGap.kind,
        ...(character === undefined
          ? {}
          : {
              character: {
                name: safeText(character.name, 120),
                element: safeText(character.element, 32),
                ...(character.weaponType === undefined
                  ? {}
                  : { weaponType: safeText(character.weaponType, 32) }),
                buildSignals
              }
            }),
        scenarioTags
      };
      return [knowledgeResearchTaskSchema.parse(task)];
    });
  }
}

function isResearchReason(kind: KnowledgeGap['kind']): kind is KnowledgeResearchTask['reason'] {
  return researchReasonSchema.safeParse(kind).success;
}

function uniqueSafeStrings(values: readonly string[], limit: number, maxBytes: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const sanitized = safeText(value, maxBytes);
    if (sanitized.length === 0 || seen.has(sanitized)) continue;
    seen.add(sanitized);
    result.push(sanitized);
    if (result.length === limit) break;
  }
  return result;
}

function safeText(value: string, maxBytes: number): string {
  return sanitizeTraceText(value.trim(), { maxBytes }).text.trim();
}
