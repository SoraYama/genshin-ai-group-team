import type { PersistedProfile } from '../../shared/domain.js';
import type { PlayerPreferences, RecommendationPlan } from '../../shared/scenario-v2.js';
import {
  knowledgeContextPacketSchema,
  type KnowledgeContextPacket
} from '../../shared/advisor-knowledge.js';
import { v2PipelineContextSchema, type V2PipelineContext } from '../agents/contracts.js';
import { buildAdvisorProfileView, toAdvisorCharacter } from './advisor-profile-serializer.js';
import {
  AgentPayloadTooLargeError,
  MAX_AGENT_PAYLOAD_BYTES,
  stringifyAgentPayload
} from './agent-payload-budget.js';

export const MAX_V2_AGENT_CONTEXT_BYTES = MAX_AGENT_PAYLOAD_BYTES;
const MAX_DETAILED_PROFILES = 24;

export class V2ContextBudgetError extends AgentPayloadTooLargeError {
  override readonly name = 'V2ContextBudgetError';

  constructor(actualBytes: number) {
    super('pipeline-context', actualBytes, MAX_V2_AGENT_CONTEXT_BYTES);
    this.message = `V2 agent context exceeds ${MAX_V2_AGENT_CONTEXT_BYTES} bytes: ${actualBytes}`;
  }
}

export interface BuildV2PipelineContextOptions {
  correlationId: string;
  profile: PersistedProfile;
  feasibleBaseline: RecommendationPlan;
  eligibleCharacterIds: string[];
  mechanics: V2PipelineContext['mechanics'];
  interventions: Record<string, unknown>;
  knowledge: V2PipelineContext['knowledge'];
  locale?: 'zh-CN' | 'en-US';
}

export function buildUnknownKnowledgeContext(
  knowledgeVersion: string,
  requestedSubjectIds: string[]
): KnowledgeContextPacket {
  const subjectIds = uniqueBoundedIds(requestedSubjectIds);
  return knowledgeContextPacketSchema.parse({
    knowledgeVersion,
    buildInterpretations: [],
    trustedMatches: [],
    ephemeralMatches: [],
    unknowns: subjectIds.map((subjectId, index) => ({
      id: `gap-${index + 1}`,
      subjectId,
      reason: 'No trusted local or ephemeral guide match is available.'
    })),
    coverage: {
      requested: subjectIds.length,
      trusted: 0,
      ephemeral: 0,
      unknown: subjectIds.length
    },
    citations: []
  });
}

export function buildV2PipelineContext(options: BuildV2PipelineContextOptions): V2PipelineContext {
  const baseline = options.feasibleBaseline;
  const selectedCharacterIds = new Set(planCharacterIds(baseline));
  const sortedCharacters = options.profile.characters
    .slice()
    .sort((left, right) => left.id - right.id);
  const byId = new Map(sortedCharacters.map((character) => [String(character.id), character]));
  const eligibleCharacterIds = uniqueBoundedIds(options.eligibleCharacterIds);
  const prioritizedIds = priorityOrderedIds([
    planCharacterIds(baseline),
    recordStringArray(options.interventions, 'lockedCharacterIds'),
    recordStringArray(options.interventions, 'selectedCharacterIds'),
    recordStringArray(options.interventions, 'selectedOpeningCharacterIds'),
    recordStringArray(options.interventions, 'selectedTrialCharacterIds'),
    recordStringArray(options.interventions, 'selectedSpecialGuestCharacterIds'),
    recordStringArray(options.interventions, 'selectedSupportCharacterIds'),
    eligibleCharacterIds
  ]);
  const detailedCharacters = prioritizedIds
    .flatMap((id) => {
      const character = byId.get(id);
      return character ? [character] : [];
    })
    .slice(0, MAX_DETAILED_PROFILES);
  const detailView = buildAdvisorProfileView(
    { ...options.profile, characters: detailedCharacters },
    MAX_DETAILED_PROFILES
  );
  const baseContext = {
    mode: baseline.mode,
    correlationId: options.correlationId,
    scenarioId: baseline.scenarioId,
    dataVersion: baseline.dataVersion,
    locale: options.locale ?? 'zh-CN',
    profileRef: { uid: options.profile.uid },
    profile: {
      coverage: options.profile.coverage,
      provenanceSummaries: detailView.provenanceSummaries,
      minimalIndex: sortedCharacters.map((character) => {
        const { id, name, element, rarity, level, completeness, missingFields } =
          toAdvisorCharacter(character);
        return {
          id,
          name,
          element,
          rarity,
          ...(level === undefined ? {} : { level }),
          completeness,
          ...(missingFields === undefined ? {} : { missingFields })
        };
      }),
      detailedProfiles: detailView.characters
    },
    candidate: {
      kind: 'feasibleBaseline' as const,
      feasibleBaseline: compactBaseline(baseline),
      eligibleCharacterIds
    },
    mechanics: options.mechanics,
    interventions: boundedInterventions(options.interventions, options.locale ?? 'zh-CN'),
    knowledge: knowledgeContextPacketSchema.parse(options.knowledge)
  };
  let budgetError = contextBudgetError(baseContext);
  if (budgetError !== undefined) {
    addPayloadTruncationGap(baseContext.knowledge);
    baseContext.profile.detailedProfiles = baseContext.profile.detailedProfiles.filter(({ id }) =>
      selectedCharacterIds.has(String(id))
    );
    baseContext.knowledge.buildInterpretations = baseContext.knowledge.buildInterpretations.filter(
      ({ characterId }) => selectedCharacterIds.has(characterId)
    );
    baseContext.knowledge.trustedMatches = baseContext.knowledge.trustedMatches.filter(
      ({ characterId }) => characterId === undefined || selectedCharacterIds.has(characterId)
    );
    removeUnreferencedCitations(baseContext.knowledge);
    synchronizeCoverage(baseContext.knowledge);
    budgetError = contextBudgetError(baseContext);
  }
  if (budgetError !== undefined) {
    baseContext.knowledge.trustedMatches = baseContext.knowledge.trustedMatches.map(
      ({ factStatements: _factStatements, ...match }) => match
    );
    budgetError = contextBudgetError(baseContext);
  }
  if (budgetError !== undefined) {
    throw budgetError;
  }
  return v2PipelineContextSchema.parse(baseContext);
}

function contextBudgetError(value: unknown): V2ContextBudgetError | undefined {
  try {
    stringifyAgentPayload(value, 'pipeline-context', MAX_V2_AGENT_CONTEXT_BYTES);
    return undefined;
  } catch (error) {
    if (error instanceof AgentPayloadTooLargeError) {
      return new V2ContextBudgetError(error.actualBytes);
    }
    throw error;
  }
}

function addPayloadTruncationGap(knowledge: KnowledgeContextPacket): void {
  if (knowledge.unknowns.some(({ kind }) => kind === 'payload-truncated')) return;
  const ids = new Set([
    ...knowledge.trustedMatches.map(({ id }) => id),
    ...knowledge.ephemeralMatches.map(({ id }) => id),
    ...knowledge.unknowns.map(({ id }) => id)
  ]);
  let suffix = 1;
  let id = 'gap-payload-truncated';
  while (ids.has(id)) {
    suffix += 1;
    id = `gap-payload-truncated-${suffix}`;
  }
  knowledge.unknowns.push({
    id,
    subjectId: 'payload:knowledge-context',
    kind: 'payload-truncated',
    reason: 'Low-priority knowledge details were removed to fit the bounded agent context.'
  });
}

function removeUnreferencedCitations(knowledge: KnowledgeContextPacket): void {
  const referenced = new Set([
    ...knowledge.trustedMatches.flatMap(({ citationIds }) => citationIds),
    ...knowledge.ephemeralMatches.flatMap(({ citationIds }) => citationIds)
  ]);
  knowledge.citations = knowledge.citations.filter(({ id }) => referenced.has(id));
}

function synchronizeCoverage(knowledge: KnowledgeContextPacket): void {
  knowledge.coverage = {
    requested:
      knowledge.trustedMatches.length +
      knowledge.ephemeralMatches.length +
      knowledge.unknowns.length,
    trusted: knowledge.trustedMatches.length,
    ephemeral: knowledge.ephemeralMatches.length,
    unknown: knowledge.unknowns.length
  };
}

function compactBaseline(
  plan: RecommendationPlan
): V2PipelineContext['candidate']['feasibleBaseline'] {
  switch (plan.mode) {
    case 'spiral-abyss':
      return {
        mode: plan.mode,
        scenarioId: plan.scenarioId,
        dataVersion: plan.dataVersion,
        firstHalfTeam: compactTeam(plan.firstHalfTeam),
        secondHalfTeam: compactTeam(plan.secondHalfTeam),
        chambers: plan.chambers.map(({ floor, chamber }) => ({ floor, chamber }))
      };
    case 'stygian-onslaught':
      return {
        mode: plan.mode,
        scenarioId: plan.scenarioId,
        dataVersion: plan.dataVersion,
        reusePolicyAcknowledgement: plan.reusePolicyAcknowledgement,
        phases: plan.phases.map(({ phase, team }) => ({ phase, team: compactTeam(team) }))
      };
    case 'imaginarium-theater':
      return {
        mode: plan.mode,
        scenarioId: plan.scenarioId,
        dataVersion: plan.dataVersion,
        cast: {
          openingCharacterIds: plan.cast.openingCharacterIds,
          selectedCharacterIds: plan.cast.selectedCharacterIds,
          trialCharacterIds: plan.cast.trialCharacterIds,
          specialGuestCharacterIds: plan.cast.specialGuestCharacterIds,
          supportCharacterIds: plan.cast.supportCharacterIds
        },
        acts: plan.acts.map(({ act, candidateCharacterIds, plannedVigorSpend, pathChoice }) => ({
          act,
          candidateCharacterIds,
          plannedVigorSpend,
          pathKind: pathChoice.kind
        }))
      };
  }
}

function compactTeam(team: { id: string; characterIds: string[] }) {
  return { id: team.id, characterIds: team.characterIds };
}

function planCharacterIds(plan: RecommendationPlan): string[] {
  switch (plan.mode) {
    case 'spiral-abyss':
      return [...plan.firstHalfTeam.characterIds, ...plan.secondHalfTeam.characterIds];
    case 'stygian-onslaught':
      return plan.phases.flatMap(({ team }) => team.characterIds);
    case 'imaginarium-theater':
      return [
        ...plan.cast.selectedCharacterIds,
        ...plan.cast.openingCharacterIds,
        ...plan.cast.trialCharacterIds,
        ...plan.cast.specialGuestCharacterIds,
        ...plan.cast.supportCharacterIds,
        ...plan.acts.flatMap(({ candidateCharacterIds }) => candidateCharacterIds)
      ];
  }
}

function boundedInterventions(
  value: Record<string, unknown>,
  locale: 'zh-CN' | 'en-US'
): V2PipelineContext['interventions'] {
  const preferences = isPreferences(value['preferences'])
    ? value['preferences']
    : {
        comfort: 'off' as const,
        survival: 'off' as const,
        lowInvestment: 'off' as const,
        noBuildChange: value['noBuildChange'] === true
      };
  return {
    locale,
    preferences,
    ...optionalIds(value, 'lockedCharacterIds'),
    ...optionalIds(value, 'excludedCharacterIds'),
    ...optionalIds(value, 'selectedCharacterIds'),
    ...optionalIds(value, 'selectedOpeningCharacterIds'),
    ...optionalIds(value, 'selectedTrialCharacterIds'),
    ...optionalIds(value, 'selectedSpecialGuestCharacterIds'),
    ...optionalIds(value, 'selectedSupportCharacterIds'),
    ...optionalString(value, 'target'),
    ...optionalString(value, 'difficultyId'),
    ...(typeof value['phase'] === 'number' ? { phase: value['phase'] } : {}),
    ...(typeof value['act'] === 'number' ? { act: value['act'] } : {}),
    ...(value['recomputeHalf'] === 'firstHalf' || value['recomputeHalf'] === 'secondHalf'
      ? { recomputeHalf: value['recomputeHalf'] }
      : {})
  };
}

function optionalIds<K extends string>(value: Record<string, unknown>, key: K) {
  const ids = recordStringArray(value, key);
  return ids.length > 0 ? { [key]: uniqueBoundedIds(ids) } : {};
}

function optionalString<K extends string>(value: Record<string, unknown>, key: K) {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim() ? { [key]: candidate.trim() } : {};
}

function recordStringArray(value: Record<string, unknown>, key: string): string[] {
  const candidate = value[key];
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === 'string')
    : [];
}

function uniqueBoundedIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()))]
    .filter((id) => id.length > 0 && id.length <= 128)
    .sort((left, right) => {
      const leftNumeric = /^[1-9]\d*$/.test(left);
      const rightNumeric = /^[1-9]\d*$/.test(right);
      if (leftNumeric && rightNumeric) return Number(left) - Number(right);
      if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
      return left.localeCompare(right);
    });
}

function priorityOrderedIds(buckets: string[][]): string[] {
  const seen = new Set<string>();
  return buckets.flatMap((bucket) =>
    uniqueBoundedIds(bucket).filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
  );
}

function isPreferences(value: unknown): value is PlayerPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    ['off', 'low', 'medium', 'high'].includes(String(record['comfort'])) &&
    ['off', 'low', 'medium', 'high'].includes(String(record['survival'])) &&
    ['off', 'low', 'medium', 'high'].includes(String(record['lowInvestment'])) &&
    typeof record['noBuildChange'] === 'boolean'
  );
}
