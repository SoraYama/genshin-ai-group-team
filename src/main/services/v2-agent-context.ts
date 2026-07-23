import type { PersistedProfile } from '../../shared/domain.js';
import type { PlayerPreferences, RecommendationPlan } from '../../shared/scenario-v2.js';
import { v2PipelineContextSchema, type V2PipelineContext } from '../agents/contracts.js';
import { buildAdvisorProfileView, toAdvisorCharacter } from './advisor-profile-serializer.js';

export const MAX_V2_AGENT_CONTEXT_BYTES = 48 * 1024;
const MAX_DETAILED_PROFILES = 24;

export class V2ContextBudgetError extends Error {
  override readonly name = 'V2ContextBudgetError';

  constructor(readonly actualBytes: number) {
    super(`V2 agent context exceeds ${MAX_V2_AGENT_CONTEXT_BYTES} bytes: ${actualBytes}`);
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

export function buildV2PipelineContext(options: BuildV2PipelineContextOptions): V2PipelineContext {
  const baseline = options.feasibleBaseline;
  const sortedCharacters = options.profile.characters
    .slice()
    .sort((left, right) => left.id - right.id);
  const byId = new Map(sortedCharacters.map((character) => [String(character.id), character]));
  const eligibleCharacterIds = uniqueBoundedIds(options.eligibleCharacterIds);
  const prioritizedIds = uniqueBoundedIds([
    ...planCharacterIds(baseline),
    ...recordStringArray(options.interventions, 'lockedCharacterIds'),
    ...recordStringArray(options.interventions, 'selectedCharacterIds'),
    ...recordStringArray(options.interventions, 'selectedOpeningCharacterIds'),
    ...recordStringArray(options.interventions, 'selectedTrialCharacterIds'),
    ...recordStringArray(options.interventions, 'selectedSpecialGuestCharacterIds'),
    ...recordStringArray(options.interventions, 'selectedSupportCharacterIds'),
    ...eligibleCharacterIds
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
    knowledge: {
      version: options.knowledge.version,
      unknownCharacterIds: uniqueBoundedIds(options.knowledge.unknownCharacterIds)
    }
  };
  const size = Buffer.byteLength(JSON.stringify(baseContext), 'utf8');
  if (size > MAX_V2_AGENT_CONTEXT_BYTES) throw new V2ContextBudgetError(size);
  return v2PipelineContextSchema.parse(baseContext);
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
