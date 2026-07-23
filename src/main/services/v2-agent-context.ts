import type { PersistedProfile } from '../../shared/domain.js';
import type { RecommendationPlan } from '../../shared/scenario-v2.js';
import { v2PipelineContextSchema, type V2PipelineContext } from '../agents/contracts.js';
import { buildAdvisorProfileView } from './advisor-profile-serializer.js';

export interface BuildV2PipelineContextOptions {
  correlationId: string;
  profile: PersistedProfile;
  feasibleBaseline: RecommendationPlan;
  eligibleCharacterIds: string[];
  mechanics: V2PipelineContext['mechanics'];
  interventions: Record<string, unknown>;
  knowledge: V2PipelineContext['knowledge'];
}

export function buildV2PipelineContext(options: BuildV2PipelineContextOptions): V2PipelineContext {
  const baseline = options.feasibleBaseline;
  return v2PipelineContextSchema.parse({
    mode: baseline.mode,
    correlationId: options.correlationId,
    scenarioId: baseline.scenarioId,
    dataVersion: baseline.dataVersion,
    profile: buildAdvisorProfileView(options.profile),
    candidate: {
      kind: 'feasibleBaseline',
      feasibleBaseline: baseline,
      eligibleCharacterIds: [...new Set(options.eligibleCharacterIds)]
    },
    mechanics: options.mechanics,
    interventions: options.interventions,
    knowledge: {
      version: options.knowledge.version,
      unknownCharacterIds: [...new Set(options.knowledge.unknownCharacterIds)]
    }
  });
}
