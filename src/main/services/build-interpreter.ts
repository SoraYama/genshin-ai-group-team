import {
  evaluateReviewedArchetypes,
  type ReviewedBuildSignalInput
} from '../../shared/advisor-build-policy.js';
import type {
  AdvisorKnowledgeReader,
  BuildInterpretation,
  CommittedBuildArchetypeV2,
  SignalPredicate
} from '../../shared/advisor-knowledge.js';
import type { AdvisorCharacterInput } from './advisor-profile-serializer.js';

type ReviewedArchetype = Extract<CommittedBuildArchetypeV2, { coverage: 'reviewed' }>;
type ReviewedRole = ReviewedArchetype['role'];

export interface BuildInterpretationOptions {
  allowRequiredAdjustment?: boolean;
  roleHint?: ReviewedRole;
  teamContextHint?: { role?: ReviewedRole };
  now?: Date;
}

export class BuildInterpreter {
  constructor(
    private readonly knowledge: AdvisorKnowledgeReader,
    private readonly now: () => Date = () => new Date()
  ) {}

  interpret(
    character: AdvisorCharacterInput,
    options: BuildInterpretationOptions = {}
  ): BuildInterpretation {
    const characterId = String(character.id);
    const strategyResult = this.knowledge.getCharacterStrategy(characterId);
    if (strategyResult.status === 'unknown') {
      return unresolved(characterId, {}, [`character-knowledge-unknown:${characterId}`]);
    }
    if (strategyResult.status === 'gap') {
      return unresolved(characterId, {}, [`character-review-gap:${characterId}`]);
    }

    const now = options.now ?? this.now();
    if (!Number.isFinite(now.getTime())) {
      return unresolved(characterId, {}, ['knowledge-review-time-invalid']);
    }
    const coverage = this.knowledge.coverageFor({
      characterIds: [characterId],
      now
    });
    if (!coverage.trustedCharacterIds.includes(characterId)) {
      return unresolved(characterId, {}, ['knowledge-review-stale']);
    }

    const build = completeSignalInput(character);
    if (build === undefined) {
      const missingEntireBuild =
        character.completeness === 'basic' ||
        character.artifactSummary === undefined ||
        character.stats === undefined;
      return unresolved(characterId, {}, [
        missingEntireBuild ? 'build-data-missing' : 'build-signal-coverage-incomplete'
      ]);
    }

    const archetypes = strategyResult.strategy.archetypes.filter(
      (archetype): archetype is ReviewedArchetype => archetype.coverage === 'reviewed'
    );
    const policy = evaluateReviewedArchetypes(archetypes, build);
    if (policy.matches.length === 0) {
      const closest = [...policy.evaluations].sort(
        (left, right) =>
          right.supportingWeight - left.supportingWeight ||
          right.matchedSignalIds.length - left.matchedSignalIds.length
      )[0];
      return {
        ...unresolved(characterId, options, ['no-compatible-reviewed-archetype']),
        candidateArchetypeIds: closest === undefined ? [] : [closest.archetypeId],
        matchedSignals: uniqueBounded(closest?.matchedSignalIds ?? []),
        conflictingSignals: uniqueBounded([
          ...(closest?.conflictingSignalIds.map((id) => `conflict:${id}`) ?? []),
          ...(closest?.missingSignalIds.map((id) => `missing:${id}`) ?? [])
        ]),
        ...(closest === undefined
          ? {}
          : {
              closestCandidate: {
                archetypeId: closest.archetypeId,
                supportingWeight: closest.supportingWeight,
                minimumSupportingWeight: closest.minimumSupportingWeight,
                matchedSignals: closest.matchedSignals,
                missingSignals: closest.missingSignals,
                conflictingSignals: closest.conflictingSignals
              }
            })
      };
    }

    const candidateArchetypeIds = policy.matches.map(({ archetypeId }) => archetypeId);
    if (policy.overlappingCandidates) {
      const roleHint = options.roleHint ?? options.teamContextHint?.role;
      const resolved = policy.matches.filter(({ archetypeId }) => {
        const archetype = archetypes.find(({ id }) => id === archetypeId);
        return roleHint !== undefined && archetype?.role === roleHint;
      });
      if (resolved.length !== 1) {
        return {
          characterId,
          archetypeId: null,
          confidence: 'low',
          candidateArchetypeIds,
          contextRequired: true,
          matchedSignals: uniqueBounded(
            policy.matches.flatMap(({ matchedSignalIds }) => matchedSignalIds)
          ),
          conflictingSignals: [],
          currentBuildUsable: true,
          adjustment: 'none',
          unknowns: withArtifactSetLimitation(character, ['multiple-compatible-archetypes'])
        };
      }
      return resolvedInterpretation(
        character,
        characterId,
        archetypes,
        resolved[0]!,
        candidateArchetypeIds,
        'medium'
      );
    }

    const onlyMatch = policy.matches[0]!;
    const archetype = archetypes.find(({ id }) => id === onlyMatch.archetypeId)!;
    return resolvedInterpretation(
      character,
      characterId,
      archetypes,
      onlyMatch,
      candidateArchetypeIds,
      confidenceFor(archetype, onlyMatch.matchedSignalIds, onlyMatch.supportingWeight)
    );
  }
}

function completeSignalInput(
  character: AdvisorCharacterInput
): ReviewedBuildSignalInput | undefined {
  const mainStats = character.artifactSummary?.mainStats;
  const stats = character.stats;
  const mainStatValues = [mainStats?.sands, mainStats?.goblet, mainStats?.circlet];
  const numericStatValues = [
    stats?.hp,
    stats?.atk,
    stats?.def,
    stats?.critRate,
    stats?.critDmg,
    stats?.energyRecharge,
    stats?.elementalMastery
  ];
  if (
    character.completeness === 'basic' ||
    character.missingFields?.includes('artifacts') ||
    character.missingFields?.includes('stats') ||
    mainStatValues.some((value) => value === undefined || value === 'unknown') ||
    numericStatValues.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    return undefined;
  }
  return { mainStats, stats };
}

function resolvedInterpretation(
  character: AdvisorCharacterInput,
  characterId: string,
  archetypes: readonly ReviewedArchetype[],
  match: { archetypeId: string; matchedSignalIds: string[]; supportingWeight: number },
  candidateArchetypeIds: string[],
  initialConfidence: BuildInterpretation['confidence']
): BuildInterpretation {
  const archetype = archetypes.find(({ id }) => id === match.archetypeId)!;
  const { confidence, provenanceUnknown } = applyProvenanceConfidence(initialConfidence, character);
  return {
    characterId,
    archetypeId: match.archetypeId,
    confidence,
    candidateArchetypeIds,
    contextRequired: false,
    matchedSignals: uniqueBounded(match.matchedSignalIds),
    conflictingSignals: requiredConflicts(archetype, character),
    currentBuildUsable: true,
    adjustment: 'none',
    unknowns: withArtifactSetLimitation(character, [
      ...archetype.unknowns.map(({ description }) => description),
      ...(provenanceUnknown === undefined ? [] : [provenanceUnknown])
    ])
  };
}

function confidenceFor(
  archetype: ReviewedArchetype,
  matchedSignalIds: readonly string[],
  supportingWeight: number
): BuildInterpretation['confidence'] {
  const totalSupportingWeight = archetype.signals
    .filter(({ required }) => !required)
    .reduce((total, { weight }) => total + weight, 0);
  const strength = totalSupportingWeight === 0 ? 0 : supportingWeight / totalSupportingWeight;
  return matchedSignalIds.length >= 2 && strength >= 0.7 ? 'high' : 'medium';
}

function applyProvenanceConfidence(
  confidence: BuildInterpretation['confidence'],
  character: AdvisorCharacterInput
): {
  confidence: BuildInterpretation['confidence'];
  provenanceUnknown?: string;
} {
  if (
    character.provenanceSummary.build === undefined ||
    character.provenanceSummary.stats === undefined
  ) {
    return { confidence: 'low', provenanceUnknown: 'build-provenance-missing' };
  }
  if (
    character.provenanceSummary.staleFields?.some((field) => field === 'build' || field === 'stats')
  ) {
    return {
      confidence: confidence === 'high' ? 'medium' : 'low',
      provenanceUnknown: 'build-provenance-stale'
    };
  }
  return { confidence };
}

function unresolved(
  characterId: string,
  options: BuildInterpretationOptions,
  unknowns: string[]
): BuildInterpretation {
  return {
    characterId,
    archetypeId: null,
    confidence: 'low',
    candidateArchetypeIds: [],
    contextRequired: false,
    matchedSignals: [],
    conflictingSignals: [],
    currentBuildUsable: false,
    adjustment: options.allowRequiredAdjustment === true ? 'required' : 'optional',
    unknowns
  };
}

function withArtifactSetLimitation(
  character: AdvisorCharacterInput,
  unknowns: readonly string[]
): string[] {
  return uniqueBounded([
    ...unknowns,
    ...(character.artifactSummary?.sets.length ? ['artifact-set-identity-unverified'] : [])
  ]);
}

function requiredConflicts(
  archetype: ReviewedArchetype,
  character: AdvisorCharacterInput
): string[] {
  const build = {
    mainStats: character.artifactSummary?.mainStats,
    stats: character.stats
  };
  return uniqueBounded(
    archetype.signals
      .filter(({ required }) => required)
      .filter((signal) => signalStatus(signal, build) === 'conflict')
      .map(({ id }) => id)
  );
}

function signalStatus(
  signal: SignalPredicate,
  build: ReviewedBuildSignalInput
): 'match' | 'missing' | 'conflict' {
  const actual =
    signal.field === 'sandsMainStat'
      ? build.mainStats?.sands
      : signal.field === 'gobletMainStat'
        ? build.mainStats?.goblet
        : signal.field === 'circletMainStat'
          ? build.mainStats?.circlet
          : build.stats?.[signal.field];
  if (actual === undefined || actual === 'unknown') return 'missing';
  if (signal.operator === 'eq') return actual === signal.value ? 'match' : 'conflict';
  if (typeof actual !== 'number') return 'conflict';
  return signal.operator === 'gte'
    ? actual >= signal.value
      ? 'match'
      : 'conflict'
    : actual <= signal.value
      ? 'match'
      : 'conflict';
}

function uniqueBounded(values: readonly string[]): string[] {
  return Array.from(new Set(values)).slice(0, 12);
}
