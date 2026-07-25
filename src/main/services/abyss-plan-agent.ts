import type { CharacterProfile } from '../../shared/domain.js';
import {
  type AbyssAdvisorPlanInput,
  type AbyssPlanIssue,
  type AbyssPlanOutput,
  type AbyssScenario
} from '../../shared/abyss-advisor.js';
import {
  ABYSS_COMPOSER_PROMPT_V3,
  ABYSS_REPAIR_PROMPT_V3
} from '../agents/abyss-composer/prompt.js';
import type {
  V2CritiqueOutput,
  V2ExplainOutput,
  V2PipelineContext,
  V2RotationOutput
} from '../agents/contracts.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import type { AgentUsage, ToolAudit } from './agent-turn-audit.js';
import { validateAbyssPlan } from './abyss-plan-validator.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import { runV2AgentPipeline, type V2AgentStage } from './v2-agent-pipeline.js';
import type { AgentFailure } from '../../shared/agent-run-trace.js';
import type { AgentPipelineTraceSession } from './v2-agent-pipeline.js';
import { abyssMemberAssignmentSchema } from '../../shared/scenario-v2.js';

export interface AbyssPlanAgentRunner {
  run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown>;
}

export interface AbyssPlanAgentInput {
  input: AbyssAdvisorPlanInput;
  scenario: AbyssScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  pipelineContext: V2PipelineContext;
  sdkOptions: AgentSdkRunOptions;
  sdkOptionsForStage?: (stage: V2AgentStage) => AgentSdkRunOptions;
  onStageStart?: (stage: V2AgentStage) => void;
  onUsageDelta?: (usage: AgentUsage) => void;
  trace?: AgentPipelineTraceSession;
  citationPolicy?: AbyssKnowledgeCitationPolicy;
}

export interface AbyssKnowledgeCitationPolicy {
  supportsCharacter: (
    citationId: string,
    characterId: string,
    archetypeId: string | null
  ) => boolean;
}

export type AbyssPlanAgentResult =
  | {
      ok: true;
      repaired: boolean;
      repairs: number;
      plan: AbyssPlanOutput;
      critique: V2CritiqueOutput;
      rotation: V2RotationOutput;
      explanation: V2ExplainOutput;
      usage: AgentUsage;
    }
  | { ok: false; issues: AbyssPlanIssue[]; usage: AgentUsage; failure: AgentFailure };

export class AbyssPlanAgent {
  constructor(private readonly runner: AbyssPlanAgentRunner) {}

  async compose(context: AbyssPlanAgentInput): Promise<AbyssPlanAgentResult> {
    const result = await runV2AgentPipeline<AbyssPlanOutput, AbyssPlanIssue>({
      runner: this.runner,
      context: context.pipelineContext,
      trace: context.trace,
      supportsKnowledgeRef: context.citationPolicy
        ? (characterId, citationId, archetypeId) =>
            context.citationPolicy!.supportsCharacter(citationId, characterId, archetypeId)
        : undefined,
      onStageStart: context.onStageStart,
      onUsageDelta: context.onUsageDelta,
      sdkOptionsForStage: context.sdkOptionsForStage ?? (() => context.sdkOptions),
      composer: {
        initialPrompt: buildComposePayload(context),
        systemPrompt: ABYSS_COMPOSER_PROMPT_V3,
        repairPrompt: ABYSS_REPAIR_PROMPT_V3,
        validate: (text, tools) => validateAgentOutput(text, context, tools)
      },
      invalidIssue: (stage, message) => ({
        code: 'AGENT_OUTPUT_INVALID' as const,
        path: [stage],
        message
      })
    });
    if (!result.ok) {
      return {
        ok: false,
        issues: result.issues,
        usage: result.usage,
        failure: issueFailure(result.issues)
      };
    }
    if (result.usage.outputTokens <= 0) {
      return {
        ok: false,
        issues: [
          {
            code: 'AGENT_OUTPUT_INVALID',
            path: ['usage', 'outputTokens'],
            message: '智能服务没有返回可验证的模型输出用量。'
          }
        ],
        usage: result.usage,
        failure: {
          code: 'AGENT_OUTPUT_INVALID',
          message: 'Agent output usage was zero.',
          retryable: false
        }
      };
    }
    const plan = applyAbyssStageOutputs(result.plan, result.critique);
    return {
      ok: true,
      repaired: result.repairs > 0,
      repairs: result.repairs,
      plan,
      critique: result.critique,
      rotation: result.rotation,
      explanation: result.explanation,
      usage: result.usage
    };
  }
}

function validateAgentOutput(
  raw: string,
  context: Pick<
    AbyssPlanAgentInput,
    'input' | 'scenario' | 'characters' | 'knowledge' | 'pipelineContext' | 'citationPolicy'
  >,
  tools: ToolAudit[]
): { ok: true; plan: AbyssPlanOutput } | { ok: false; issues: AbyssPlanIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: 'AGENT_OUTPUT_INVALID',
          path: [],
          message: '智能服务没有返回完整 JSON 方案。'
        }
      ]
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      issues: [
        {
          code: 'AGENT_OUTPUT_INVALID',
          path: [],
          message: '智能服务返回的内容不是方案对象。'
        }
      ]
    };
  }
  const toolIssue = validateRequiredTools(context, tools, parsed);
  if (toolIssue) return { ok: false, issues: [toolIssue] };
  return validateAbyssPlan({ ...context, plan: parsed });
}

function validateRequiredTools(
  context: Pick<
    AbyssPlanAgentInput,
    'input' | 'scenario' | 'characters' | 'pipelineContext' | 'citationPolicy'
  >,
  tools: ToolAudit[],
  plan: Record<string, unknown>
): AbyssPlanIssue | undefined {
  const correlationTools = tools.filter(
    ({ correlationId }) => correlationId === context.input.correlationId
  );
  const duplicateToolIds =
    correlationTools.length !== new Set(correlationTools.map(({ id }) => id)).size;
  const successful = correlationTools.filter(({ succeeded }) => succeeded);
  const has = (name: string, predicate: (input: Record<string, unknown>) => boolean = () => true) =>
    successful.some((use) => use.name === name && predicate(use.input));
  const missing: string[] = [];
  const plannedIds = ['firstHalfTeam', 'secondHalfTeam'].flatMap((key) => {
    const team = isRecord(plan[key]) ? plan[key] : {};
    return Array.isArray(team['characterIds'])
      ? team['characterIds'].filter((id): id is string => typeof id === 'string')
      : [];
  });
  const ownedIds = new Set(context.characters.map(({ id }) => String(id)));
  const plannedOwnedIds = plannedIds.filter((id) => ownedIds.has(id));
  const detailedProfileIds = new Set(
    successful
      .filter(
        ({ name, input }) =>
          name === 'mcp__genshin__read_profile_cache' &&
          auditedUidMatches(input['uid'], context.input.uid)
      )
      .flatMap(({ input }) =>
        Array.isArray(input['characterIds'])
          ? input['characterIds'].filter((id): id is string => typeof id === 'string')
          : []
      )
  );
  if (plannedOwnedIds.length === 0 || plannedOwnedIds.some((id) => !detailedProfileIds.has(id))) {
    missing.push('read_profile_cache:selected-character-details');
  }
  if (duplicateToolIds) missing.push('tool-audit:duplicate-id');

  const targetFloor = context.scenario.floors.find(({ floor }) => floor === context.input.floor);
  const targetChambers =
    targetFloor?.chambers.filter(
      ({ chamber }) => context.input.chamber === undefined || chamber === context.input.chamber
    ) ?? [];
  targetChambers.forEach(({ chamber }) => {
    if (
      !has(
        'mcp__genshin__query_enemy_data',
        (input) =>
          input['scenarioId'] === context.scenario.id &&
          input['dataVersion'] === context.scenario.meta.dataVersion &&
          input['floor'] === context.input.floor &&
          input['chamber'] === chamber
      )
    ) {
      missing.push(`query_enemy_data:${context.input.floor}-${chamber}`);
    }
    (['first', 'second'] as const).forEach((half) => {
      const expectedIds =
        half === 'first'
          ? recordTeamCharacterIds(plan, 'firstHalfTeam')
          : recordTeamCharacterIds(plan, 'secondHalfTeam');
      const knowledgeCalls = successful.filter(
        ({ name, input }) =>
          name === 'mcp__genshin__query_team_knowledge' &&
          input['floor'] === context.input.floor &&
          input['chamber'] === chamber &&
          input['half'] === half
      );
      const queriedIds =
        knowledgeCalls.length === 1 && Array.isArray(knowledgeCalls[0]!.input['characterIds'])
          ? knowledgeCalls[0]!.input['characterIds'].filter(
              (id): id is string => typeof id === 'string'
            )
          : [];
      const coveredIds = new Set(queriedIds);
      if (
        expectedIds.length !== 4 ||
        knowledgeCalls.length !== 1 ||
        queriedIds.length !== expectedIds.length ||
        expectedIds.some((id) => !coveredIds.has(id)) ||
        coveredIds.size !== expectedIds.length
      ) {
        missing.push(`query_team_knowledge:${context.input.floor}-${chamber}-${half}`);
      }
    });
  });
  missing.push(...validateMemberAssignments(context, plan, plannedIds));
  if (missing.length === 0) return undefined;
  return {
    code: 'AGENT_OUTPUT_INVALID',
    path: ['tools'],
    message: '智能服务没有成功读取并验证生成方案所需的角色、逐房间敌情与知识引用。',
    details: { missing }
  };
}

function auditedUidMatches(value: unknown, expected: string): boolean {
  return value === expected || value === '[REDACTED]';
}

function buildComposePayload(context: AbyssPlanAgentInput): string {
  return JSON.stringify({
    task: '联合生成深境螺旋上下半固定双队',
    request: publicRequest(context),
    availableCharacterIds: context.characters.map(({ id }) => String(id)),
    toolPolicy: {
      required: ['read_profile_cache', 'query_enemy_data', 'query_team_knowledge'],
      unknownMeansUnknown: true
    }
  });
}

function recordTeamCharacterIds(plan: Record<string, unknown>, key: string): string[] {
  const team = isRecord(plan[key]) ? plan[key] : {};
  return Array.isArray(team['characterIds'])
    ? team['characterIds'].filter((id): id is string => typeof id === 'string')
    : [];
}

function validateMemberAssignments(
  context: Pick<AbyssPlanAgentInput, 'input' | 'pipelineContext' | 'citationPolicy'>,
  plan: Record<string, unknown>,
  plannedIds: string[]
): string[] {
  const missing: string[] = [];
  const rawAssignments = plan['memberAssignments'];
  if (!Array.isArray(rawAssignments) || rawAssignments.length !== 8) {
    return ['member-assignments:exactly-eight'];
  }
  const parsedAssignments = rawAssignments.map((assignment, index) => {
    const parsed = abyssMemberAssignmentSchema.safeParse(assignment);
    if (!parsed.success) missing.push(`member-assignment:${index}:schema-invalid`);
    return parsed.success ? parsed.data : undefined;
  });
  if (missing.length > 0) return missing;
  const assignments = parsedAssignments.filter(
    (assignment): assignment is NonNullable<typeof assignment> => assignment !== undefined
  );
  const assignmentIds = assignments.map(({ characterId }) => characterId);
  if (
    new Set(assignmentIds).size !== 8 ||
    new Set(plannedIds).size !== 8 ||
    plannedIds.some((characterId) => !assignmentIds.includes(characterId))
  ) {
    missing.push('member-assignments:team-coverage-mismatch');
  }
  const expectedHalfById = new Map<string, 'first' | 'second'>([
    ...recordTeamCharacterIds(plan, 'firstHalfTeam').map(
      (characterId) => [characterId, 'first'] as const
    ),
    ...recordTeamCharacterIds(plan, 'secondHalfTeam').map(
      (characterId) => [characterId, 'second'] as const
    )
  ]);
  const packet = context.pipelineContext.knowledge;
  const citationsById = new Map(packet.citations.map((citation) => [citation.id, citation]));
  for (const assignment of assignments) {
    const { characterId } = assignment;
    if (assignment.half !== expectedHalfById.get(characterId)) {
      missing.push(`member-assignment:${characterId}:half-mismatch`);
    }
    const interpretation = packet.buildInterpretations.find(
      ({ characterId: candidate }) => candidate === characterId
    );
    if (interpretation === undefined) {
      missing.push(`member-assignment:${characterId}:build-interpretation-missing`);
      continue;
    }
    if (assignment.archetypeId !== interpretation.archetypeId) {
      missing.push(`member-assignment:${characterId}:archetype-mismatch`);
    }
    const explicitGap = packet.unknowns.some(
      ({ subjectId, kind }) =>
        subjectId === characterId &&
        ['missing', 'stale', 'conflict', 'build-unmatched'].includes(kind)
    );
    if (explicitGap) {
      if (
        assignment.role !== 'unclassified' ||
        assignment.buildStatus !== 'unknown' ||
        assignment.citationIds.length !== 0
      ) {
        missing.push(`member-assignment:${characterId}:unknown-must-be-unclassified`);
      }
      if (plan['confidence'] !== 'low' || !planContainsUnknownMarker(plan, characterId)) {
        missing.push(`member-assignment:${characterId}:unknown-marker-missing`);
      }
      continue;
    }
    const requiresAdjustment =
      !interpretation.currentBuildUsable ||
      interpretation.adjustment === 'required' ||
      interpretation.conflictingSignals.length > 0;
    if (requiresAdjustment && context.input.preferences.noBuildChange) {
      missing.push(`member-assignment:${characterId}:no-build-change-conflict`);
    }
    const expectedBuildStatus = requiresAdjustment
      ? 'requires-adjustment'
      : 'current-build';
    if (assignment.buildStatus !== expectedBuildStatus) {
      missing.push(`member-assignment:${characterId}:build-status-mismatch`);
    }

    const trustedMatches = packet.trustedMatches.filter(
      ({ characterId: candidate, archetypeId }) =>
        candidate === characterId && archetypeId === interpretation.archetypeId
    );
    const ephemeralMatches = packet.ephemeralMatches.filter(
      ({ subjectId }) => subjectId === characterId
    );
    if (trustedMatches.length > 0) {
      const supportedRoles = new Set(
        trustedMatches.flatMap(({ role }) => (role === undefined ? [] : [role]))
      );
      if (!supportedRoles.has(assignment.role as Exclude<typeof assignment.role, 'unclassified'>)) {
        missing.push(`member-assignment:${characterId}:role-mismatch`);
      }
      const roleMatches = trustedMatches.filter(
        ({ role }) => role === assignment.role
      );
      const supportedCitationIds = new Set(
        roleMatches.flatMap(({ citationIds }) => citationIds)
      );
      if (
        assignment.citationIds.length === 0 ||
        assignment.citationIds.some((citationId) => {
          const citation = citationsById.get(citationId);
          return (
            !supportedCitationIds.has(citationId) ||
            citation?.trust !== 'trusted-local' ||
            (context.citationPolicy !== undefined &&
              !context.citationPolicy.supportsCharacter(
                citationId,
                characterId,
                interpretation.archetypeId
              ))
          );
        })
      ) {
        missing.push(`member-assignment:${characterId}:citation-subject-mismatch`);
      }
      continue;
    }
    if (ephemeralMatches.length > 0) {
      const supportedCitationIds = new Set(
        ephemeralMatches.flatMap(({ citationIds }) => citationIds)
      );
      if (
        assignment.role !== 'unclassified' ||
        assignment.citationIds.length === 0 ||
        assignment.citationIds.some(
          (citationId) =>
            !supportedCitationIds.has(citationId) ||
            citationsById.get(citationId)?.trust !== 'ephemeral-web'
        )
      ) {
        missing.push(`member-assignment:${characterId}:ephemeral-must-be-unclassified`);
      }
      continue;
    }
    missing.push(`member-assignment:${characterId}:knowledge-missing`);
  }
  return missing;
}

function planContainsUnknownMarker(plan: Record<string, unknown>, characterId: string): boolean {
  const text = ['warnings', 'assumptions'].flatMap((key) =>
    Array.isArray(plan[key])
      ? plan[key].filter((value): value is string => typeof value === 'string')
      : []
  );
  return text.some(
    (value) =>
      value.includes(characterId) &&
      /unknown|low-confidence|low confidence|未知|低置信度|知识缺口/iu.test(value)
  );
}

function issueFailure(issues: AbyssPlanIssue[]): AgentFailure {
  if (issues.some(({ path }) => path[0] === 'tools')) {
    return {
      code: 'TOOL_REQUIREMENT_FAILED',
      message: 'Required business tool evidence was incomplete.',
      retryable: false
    };
  }
  return {
    code: 'AGENT_OUTPUT_INVALID',
    message: 'Agent output did not pass deterministic validation.',
    retryable: false
  };
}

function publicRequest(context: Pick<AbyssPlanAgentInput, 'input' | 'scenario'>) {
  return {
    uid: context.input.uid,
    scenarioId: context.scenario.id,
    dataVersion: context.scenario.meta.dataVersion,
    locale: context.input.locale,
    floor: context.input.floor,
    chamber: context.input.chamber,
    preferences: context.input.preferences,
    lockedCharacterIds: context.input.lockedCharacterIds,
    excludedCharacterIds: context.input.excludedCharacterIds,
    ...(context.input.priorPlan && context.input.recomputeHalf
      ? {
          recomputeHalf: context.input.recomputeHalf,
          priorPlan: context.input.priorPlan,
          preservationRule:
            context.input.recomputeHalf === 'firstHalf'
              ? 'secondHalfTeam 与每个 chambers.secondHalf 必须逐字段保持不变'
              : 'firstHalfTeam 与每个 chambers.firstHalf 必须逐字段保持不变'
        }
      : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyAbyssStageOutputs(
  plan: AbyssPlanOutput,
  critique: V2CritiqueOutput
): AbyssPlanOutput {
  return {
    ...plan,
    chambers: plan.chambers.map((chamber) => {
      const enrich = (half: 'first' | 'second') => {
        const current = half === 'first' ? chamber.firstHalf : chamber.secondHalf;
        const risks = critique.issues
          .filter(
            ({ target }) =>
              target.kind === 'abyss-chamber' &&
              target.floor === chamber.floor &&
              target.chamber === chamber.chamber &&
              target.half === half
          )
          .map(({ message }) => message);
        return {
          ...current,
          risks: [...current.risks, ...risks]
        };
      };
      return {
        ...chamber,
        firstHalf: enrich('first'),
        secondHalf: enrich('second')
      };
    })
  };
}
