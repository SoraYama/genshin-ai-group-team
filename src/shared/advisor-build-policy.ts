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

export interface ReviewedArchetypePolicyResult {
  matches: ReviewedArchetypePolicyMatch[];
  overlappingCandidates: boolean;
}

type ReviewedArchetype = Extract<CommittedBuildArchetypeV2, { coverage: 'reviewed' }>;

export function evaluateReviewedArchetypes(
  archetypes: readonly CommittedBuildArchetypeV2[],
  build: ReviewedBuildSignalInput
): ReviewedArchetypePolicyResult {
  const matches = archetypes
    .filter((archetype): archetype is ReviewedArchetype => archetype.coverage === 'reviewed')
    .map((archetype) => evaluateReviewedArchetype(archetype, build))
    .filter((result): result is ReviewedArchetypePolicyMatch => result !== undefined);
  return { matches, overlappingCandidates: matches.length > 1 };
}

function evaluateReviewedArchetype(
  archetype: ReviewedArchetype,
  build: ReviewedBuildSignalInput
): ReviewedArchetypePolicyMatch | undefined {
  const matchedSignals = archetype.signals.filter((signal) => signalMatches(signal, build));
  const matchedSignalIds = matchedSignals.map(({ id }) => id);
  const matchedIds = new Set(matchedSignalIds);
  const requiredSatisfied = archetype.signals
    .filter(({ required }) => required)
    .every(({ id }) => matchedIds.has(id));
  const supportingWeight = matchedSignals
    .filter(({ required }) => !required)
    .reduce((total, { weight }) => total + weight, 0);

  if (!requiredSatisfied || supportingWeight < archetype.minimumSupportingWeight) {
    return undefined;
  }
  return { archetypeId: archetype.id, matchedSignalIds, supportingWeight };
}

function signalMatches(signal: SignalPredicate, build: ReviewedBuildSignalInput): boolean {
  switch (signal.field) {
    case 'sandsMainStat':
      return build.mainStats?.sands === signal.value;
    case 'gobletMainStat':
      return build.mainStats?.goblet === signal.value;
    case 'circletMainStat':
      return build.mainStats?.circlet === signal.value;
    default: {
      const actual = build.stats?.[signal.field];
      if (actual === undefined) return false;
      switch (signal.operator) {
        case 'eq':
          return actual === signal.value;
        case 'gte':
          return actual >= signal.value;
        case 'lte':
          return actual <= signal.value;
      }
    }
  }
}
