import type {
  ArtifactMainStatKey,
  CommittedBuildArchetypeV2,
  SignalPredicate
} from './advisor-knowledge.js';

export interface ReviewedBuildSignalInput {
  mainStats?: Partial<Record<'sands' | 'goblet' | 'circlet', ArtifactMainStatKey | 'unknown'>>;
  stats?: Partial<
    Record<
      'hp' | 'atk' | 'def' | 'critRate' | 'critDmg' | 'energyRecharge' | 'elementalMastery',
      number
    >
  >;
}

export interface ReviewedArchetypePolicyMatch {
  archetypeId: string;
  matchedSignalIds: string[];
  supportingWeight: number;
}

export interface ReviewedSignalPolicyDiagnostic {
  id: string;
  weight: number;
  required: boolean;
}

export interface ReviewedArchetypePolicyEvaluation extends ReviewedArchetypePolicyMatch {
  compatible: boolean;
  matchedSignals: ReviewedSignalPolicyDiagnostic[];
  missingSignalIds: string[];
  missingSignals: ReviewedSignalPolicyDiagnostic[];
  conflictingSignalIds: string[];
  conflictingSignals: ReviewedSignalPolicyDiagnostic[];
  minimumSupportingWeight: number;
}

export interface ReviewedArchetypePolicyResult {
  evaluations: ReviewedArchetypePolicyEvaluation[];
  matches: ReviewedArchetypePolicyMatch[];
  overlappingCandidates: boolean;
}

type ReviewedArchetype = Extract<CommittedBuildArchetypeV2, { coverage: 'reviewed' }>;

export function evaluateReviewedArchetypes(
  archetypes: readonly CommittedBuildArchetypeV2[],
  build: ReviewedBuildSignalInput
): ReviewedArchetypePolicyResult {
  const evaluations = archetypes
    .filter((archetype): archetype is ReviewedArchetype => archetype.coverage === 'reviewed')
    .map((archetype) => evaluateReviewedArchetype(archetype, build));
  const matches = evaluations
    .filter(({ compatible }) => compatible)
    .map(({ archetypeId, matchedSignalIds, supportingWeight }) => ({
      archetypeId,
      matchedSignalIds,
      supportingWeight
    }));
  return { evaluations, matches, overlappingCandidates: matches.length > 1 };
}

function evaluateReviewedArchetype(
  archetype: ReviewedArchetype,
  build: ReviewedBuildSignalInput
): ReviewedArchetypePolicyEvaluation {
  const signalEvaluations = archetype.signals.map((signal) => ({
    signal,
    status: signalStatus(signal, build)
  }));
  const matchedSignals = signalEvaluations
    .filter(({ status }) => status === 'match')
    .map(({ signal }) => signal);
  const missingSignals = signalEvaluations
    .filter(({ status }) => status === 'missing')
    .map(({ signal }) => signal);
  const conflictingSignals = signalEvaluations
    .filter(({ status }) => status === 'conflict')
    .map(({ signal }) => signal);
  const matchedSignalIds = matchedSignals.map(({ id }) => id);
  const requiredSatisfied = signalEvaluations
    .filter(({ signal }) => signal.required)
    .every(({ status }) => status === 'match');
  const supportingWeight = matchedSignals
    .filter(({ required }) => !required)
    .reduce((total, { weight }) => total + weight, 0);
  return {
    archetypeId: archetype.id,
    compatible: requiredSatisfied && supportingWeight >= archetype.minimumSupportingWeight,
    matchedSignalIds,
    matchedSignals: matchedSignals.map(signalDiagnostic),
    missingSignalIds: missingSignals.map(({ id }) => id),
    missingSignals: missingSignals.map(signalDiagnostic),
    conflictingSignalIds: conflictingSignals.map(({ id }) => id),
    conflictingSignals: conflictingSignals.map(signalDiagnostic),
    supportingWeight,
    minimumSupportingWeight: archetype.minimumSupportingWeight
  };
}

function signalDiagnostic({
  id,
  weight,
  required
}: SignalPredicate): ReviewedSignalPolicyDiagnostic {
  return { id, weight, required };
}

function signalStatus(
  signal: SignalPredicate,
  build: ReviewedBuildSignalInput
): 'match' | 'missing' | 'conflict' {
  switch (signal.field) {
    case 'sandsMainStat':
      return compareSignalValue(build.mainStats?.sands, signal);
    case 'gobletMainStat':
      return compareSignalValue(build.mainStats?.goblet, signal);
    case 'circletMainStat':
      return compareSignalValue(build.mainStats?.circlet, signal);
    default: {
      const actual = build.stats?.[signal.field];
      if (actual === undefined) return 'missing';
      switch (signal.operator) {
        case 'eq':
          return actual === signal.value ? 'match' : 'conflict';
        case 'gte':
          return actual >= signal.value ? 'match' : 'conflict';
        case 'lte':
          return actual <= signal.value ? 'match' : 'conflict';
      }
    }
  }
}

function compareSignalValue(
  actual: ArtifactMainStatKey | 'unknown' | undefined,
  signal: SignalPredicate
): 'match' | 'missing' | 'conflict' {
  if (actual === undefined || actual === 'unknown') return 'missing';
  return actual === signal.value ? 'match' : 'conflict';
}
