import { z } from 'zod';

import type {
  KnowledgeContextPacket,
  KnowledgeGap,
  SourceCitation,
  TrustedKnowledgeMatch
} from '../../shared/advisor-knowledge.js';
import {
  canonicalCharacterIdSchema,
  knowledgeContextPacketSchema
} from '../../shared/advisor-knowledge.js';
import type { PersistedProfile } from '../../shared/domain.js';
import { playerPreferencesSchema, type PlayerPreferences } from '../../shared/scenario-v2.js';
import { toAdvisorCharacter } from './advisor-profile-serializer.js';
import { scenarioMechanicTagsForTarget } from './advisor-scenario-taxonomy.js';
import { BuildInterpreter } from './build-interpreter.js';
import { KnowledgeBundleStore } from './knowledge-bundle-store.js';

const boundedScenarioTagSchema = z.string().trim().min(1).max(80);

export const advisorScenarioTargetSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    tags: z
      .array(boundedScenarioTagSchema)
      .max(24)
      .refine((tags) => new Set(tags).size === tags.length, 'Scenario tags must be unique'),
    shields: z
      .array(
        z
          .object({
            element: z.string().trim().min(1).max(32)
          })
          .strict()
      )
      .max(16)
      .default([]),
    resistances: z
      .array(
        z
          .object({
            damageType: z.string().trim().min(1).max(80),
            percent: z.number().min(-100).max(1_000)
          })
          .strict()
      )
      .max(32)
      .default([]),
    immunities: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
    waveCount: z.number().int().min(1).max(64).optional(),
    enemyCount: z.number().int().min(1).max(256).optional()
  })
  .strict();

const candidateIdsSchema = z
  .array(canonicalCharacterIdSchema)
  .max(128)
  .refine((ids) => new Set(ids).size === ids.length, 'Candidate IDs must be unique');

export type AdvisorScenarioTarget = z.infer<typeof advisorScenarioTargetSchema>;

export interface AdvisorKnowledgePacketInput {
  profile: PersistedProfile;
  scenarioTarget: z.input<typeof advisorScenarioTargetSchema>;
  candidateIds: string[];
  preferences: PlayerPreferences;
}

export class AdvisorKnowledgeService {
  private readonly interpreter: BuildInterpreter;

  constructor(
    private readonly knowledge: KnowledgeBundleStore,
    private readonly now: () => Date = () => new Date()
  ) {
    this.interpreter = new BuildInterpreter(knowledge, now);
  }

  buildPacket(input: AdvisorKnowledgePacketInput): KnowledgeContextPacket {
    const scenarioTarget = advisorScenarioTargetSchema.parse(input.scenarioTarget);
    const candidateIds = candidateIdsSchema.parse(input.candidateIds);
    playerPreferencesSchema.parse(input.preferences);
    const evaluatedAt = this.now();
    const trustedMatches: TrustedKnowledgeMatch[] = [];
    const unknowns: KnowledgeGap[] = [];
    const citationIds = new Set<string>();
    const characterById = new Map(
      input.profile.characters.map((character) => [String(character.id), character])
    );

    const buildInterpretations = candidateIds.flatMap((characterId) => {
      const character = characterById.get(characterId);
      if (character === undefined) {
        unknowns.push(
          gap(
            `gap-character-${characterId}`,
            characterId,
            'missing',
            'Candidate character is absent from the validated local profile.'
          )
        );
        return [];
      }

      const interpretation = this.interpreter.interpret(toAdvisorCharacter(character), {
        allowRequiredAdjustment: false,
        now: evaluatedAt
      });
      const gapKind = interpretationGapKind(interpretation);
      if (gapKind !== undefined) {
        unknowns.push(
          gap(
            `gap-character-${characterId}`,
            characterId,
            gapKind,
            interpretationGapReason(gapKind)
          )
        );
        return [interpretation];
      }

      const archetypeId = interpretation.archetypeId;
      const archetype =
        archetypeId === null ? undefined : this.knowledge.getArchetype(characterId, archetypeId);
      if (archetype === undefined) {
        unknowns.push(
          gap(
            `gap-character-${characterId}`,
            characterId,
            'missing',
            'The interpreted build has no validated local archetype policy.'
          )
        );
        return [interpretation];
      }
      if (archetype.role === 'unclassified') {
        unknowns.push(
          gap(
            `gap-character-${characterId}`,
            characterId,
            'missing',
            'The interpreted build only has an unclassified knowledge gap.'
          )
        );
        return [interpretation];
      }

      const archetypeCitationIds = unique(
        archetype.facts.flatMap(({ citationIds: factCitationIds }) => factCitationIds)
      );
      archetypeCitationIds.forEach((citationId) => citationIds.add(citationId));
      trustedMatches.push({
        id: `trusted-character-${characterId}`,
        characterId,
        archetypeId,
        role: archetype.role,
        summary: boundedKnowledgeSummary(archetype.facts.map(({ statement }) => statement)),
        factStatements: archetype.facts.map(({ statement }) => statement),
        citationIds: archetypeCitationIds
      });
      return [interpretation];
    });

    const normalizedTags = scenarioMechanicTagsForTarget(scenarioTarget);
    const mechanicAnalysis = this.knowledge.analyzeMechanics(normalizedTags);
    const mechanicMatches = mechanicAnalysis.matched;
    const mechanicCoverage = this.knowledge.mechanicCoverageFor({
      mechanicIds: mechanicMatches.map(({ id }) => id),
      now: evaluatedAt
    });
    const trustedMechanicIds = new Set(mechanicCoverage.trustedMechanicIds);

    mechanicAnalysis.conflicts.forEach(({ mechanicId }) => {
      unknowns.push(
        gap(
          `gap-mechanic-conflict-${mechanicId}`,
          `mechanic:${mechanicId}`,
          'conflict',
          'The scenario contains contradictory tags for this reviewed mechanic policy.'
        )
      );
    });

    mechanicMatches.forEach((mechanic) => {
      const subjectId = `mechanic:${mechanic.id}`;
      if (!trustedMechanicIds.has(mechanic.id)) {
        unknowns.push(
          gap(
            `gap-mechanic-${mechanic.id}`,
            subjectId,
            'stale',
            'The local mechanic policy is outside its reviewed source cadence.'
          )
        );
        return;
      }
      const mechanicCitationIds = unique(
        mechanic.facts.flatMap(({ citationIds: factCitationIds }) => factCitationIds)
      );
      mechanicCitationIds.forEach((citationId) => citationIds.add(citationId));
      trustedMatches.push({
        id: `trusted-mechanic-${mechanic.id}`,
        mechanicId: mechanic.id,
        summary: boundedKnowledgeSummary(mechanic.facts.map(({ statement }) => statement)),
        factStatements: mechanic.facts.map(({ statement }) => statement),
        requiredCapabilities: mechanic.requiredCapabilities,
        preferredArchetypes: mechanic.preferredArchetypes,
        teamSkeletonHints: mechanic.teamSkeletonHints,
        citationIds: mechanicCitationIds
      });
    });

    mechanicAnalysis.unknownTags.forEach((tag, index) => {
      unknowns.push(
        gap(
          `gap-scenario-${index + 1}`,
          `scenario:${safeIdFragment(tag)}`,
          'missing',
          'No reviewed local mechanic policy matches this scenario tag.'
        )
      );
    });

    const citations = this.knowledge.citations(Array.from(citationIds)).map(toContextCitation);
    return knowledgeContextPacketSchema.parse({
      knowledgeVersion: this.knowledge.version,
      buildInterpretations,
      trustedMatches,
      ephemeralMatches: [],
      unknowns,
      coverage: {
        requested: trustedMatches.length + unknowns.length,
        trusted: trustedMatches.length,
        ephemeral: 0,
        unknown: unknowns.length
      },
      citations
    });
  }
}

function interpretationGapKind(
  interpretation: KnowledgeContextPacket['buildInterpretations'][number]
): KnowledgeGap['kind'] | undefined {
  if (interpretation.unknowns.includes('knowledge-review-stale')) return 'stale';
  if (
    interpretation.contextRequired ||
    interpretation.unknowns.includes('multiple-compatible-archetypes')
  ) {
    return 'conflict';
  }
  if (interpretation.archetypeId !== null) return undefined;
  if (interpretation.unknowns.includes('no-compatible-reviewed-archetype')) {
    return 'build-unmatched';
  }
  return 'missing';
}

function interpretationGapReason(kind: KnowledgeGap['kind']): string {
  switch (kind) {
    case 'stale':
      return 'The reviewed character strategy is outside its source cadence.';
    case 'conflict':
      return 'Multiple reviewed build interpretations remain compatible and need team context.';
    case 'build-unmatched':
      return 'The current build does not match a reviewed local archetype.';
    case 'payload-truncated':
      return 'The knowledge payload was truncated.';
    case 'missing':
      return 'No reviewed local character strategy covers the current candidate build.';
  }
}

function gap(
  id: string,
  subjectId: string,
  kind: KnowledgeGap['kind'],
  reason: string
): KnowledgeGap {
  return { id, subjectId, kind, reason };
}

function toContextCitation(citation: {
  id: string;
  sourceId: string;
  url: string;
  title: string;
  reviewedAt: string;
  trust: SourceCitation['trust'];
}): SourceCitation {
  return {
    id: citation.id,
    sourceId: citation.sourceId,
    url: citation.url,
    title: citation.title,
    reviewedAt: citation.reviewedAt,
    trust: citation.trust
  };
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

export function boundedKnowledgeSummary(statements: readonly string[]): string {
  const combined = statements.join(' ');
  if (combined.length <= 1_000) return combined;
  return `${combined.slice(0, 999).trimEnd()}…`;
}

function safeIdFragment(value: string): string {
  const fragment = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (fragment || 'unknown').slice(0, 100);
}
