import type { z } from 'zod';

import {
  v2CritiqueInputSchema,
  v2CritiqueOutputSchema,
  v2ExplainInputSchema,
  v2ExplainOutputSchema,
  v2AgentTargetSchema,
  v2PipelineContextSchema,
  v2RotationInputSchema,
  v2RotationOutputSchema,
  type V2AgentTarget,
  type V2CritiqueOutput,
  type V2ExplainOutput,
  type V2PipelineContext,
  type V2RotationOutput
} from '../agents/contracts.js';
import { CRITIQUE_PROMPT_V2, CRITIQUE_PROMPT_V3 } from '../agents/critique/prompt.js';
import { EXPLAIN_PROMPT_V2, EXPLAIN_PROMPT_V3 } from '../agents/explain/prompt.js';
import {
  ROTATION_COACH_PROMPT_V2,
  ROTATION_COACH_PROMPT_V3
} from '../agents/rotation-coach/prompt.js';
import type { RecommendationPlan } from '../../shared/scenario-v2.js';
import {
  advisorFactRefSchema,
  advisorNarrativeReasonCodeSchema,
  type AdvisorFactRef,
  type AdvisorNarrativeReasonCode
} from '../../shared/advisor-narrative.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import {
  AgentTurnError,
  addAgentUsage,
  runAuditedAgentTurn,
  safeAgentTurnFailureDetails,
  type AgentUsage,
  type AuditedAgentTurn,
  type AuditedAgentRunner,
  type ToolAudit
} from './agent-turn-audit.js';
import {
  AgentPayloadTooLargeError,
  MAX_AGENT_PAYLOAD_BYTES,
  stringifyAgentPayload,
  type AgentPayloadScope
} from './agent-payload-budget.js';
import {
  parseAgentJson,
  parseStructurallyIncompleteAgentJson
} from './agent-json.js';
import {
  fitV2PipelineContextToBudget,
  projectV2PipelineContextForCharacterIds,
  projectV2PipelineContextForPlan
} from './v2-agent-context.js';
import type {
  AgentRunTraceLease,
  AgentRunTraceWriter,
  CompleteStageInput
} from './agent-run-trace-store.js';
import type {
  AgentFailure,
  AgentFailureCode,
  AgentToolTrace
} from '../../shared/agent-run-trace.js';

export type { V2PipelineContext } from '../agents/contracts.js';

export type V2AgentStage =
  | 'compose'
  | 'repair-1'
  | 'repair-2'
  | 'critique'
  | 'rotation'
  | 'explain';

interface PipelineIssue {
  code: string;
  path: Array<string | number>;
  message: string;
  details?: Record<string, unknown>;
}

type ValidationResult<P extends RecommendationPlan, I extends PipelineIssue> =
  | { ok: true; plan: P }
  | { ok: false; issues: I[] };

export interface RunV2AgentPipelineOptions<P extends RecommendationPlan, I extends PipelineIssue> {
  runner: AuditedAgentRunner;
  context: V2PipelineContext;
  trace?: AgentRunTraceWriter | AgentPipelineTraceSession;
  supportsKnowledgeRef?: (
    characterId: string,
    citationId: string,
    archetypeId: string
  ) => boolean;
  onStageStart?: (stage: V2AgentStage) => void;
  onUsageDelta?: (usage: AgentUsage) => void;
  maxComposerRepairs?: 1 | 2;
  sdkOptionsForStage: (stage: V2AgentStage) => AgentSdkRunOptions;
  composer: {
    initialPrompt: string;
    systemPrompt: string;
    repairPrompt: string;
    reuseToolEvidenceOnToolFreeRepair?: boolean;
    validate: (
      text: string,
      tools: ToolAudit[],
      stage: V2AgentStage
    ) => ValidationResult<P, I>;
  };
  invalidIssue: (stage: V2AgentStage, message: string) => I;
}

export interface AgentPipelineTraceSession {
  writer: AgentRunTraceWriter;
  lease: AgentRunTraceLease;
}

export type V2AgentPipelineResult<P extends RecommendationPlan, I extends PipelineIssue> =
  | {
      ok: true;
      plan: P;
      repairs: number;
      critique: V2CritiqueOutput;
      rotation: V2RotationOutput;
      explanation: V2ExplainOutput;
      usage: AgentUsage;
    }
  | { ok: false; repairs: number; issues: I[]; usage: AgentUsage };

export async function runV2AgentPipeline<P extends RecommendationPlan, I extends PipelineIssue>(
  options: RunV2AgentPipelineOptions<P, I>
): Promise<V2AgentPipelineResult<P, I>> {
  const context = v2PipelineContextSchema.parse(options.context);
  let initialComposerOptions: AgentSdkRunOptions;
  try {
    initialComposerOptions = options.sdkOptionsForStage('compose');
  } catch (error) {
    const trace = new PipelineTraceObserver(options.trace, context);
    trace.failSdkStart('compose', 'Initial composer SDK options could not be prepared.');
    throw error;
  }
  const trace = new PipelineTraceObserver(options.trace, context, initialComposerOptions);

  try {
    return await runV2AgentPipelineWithTrace(options, context, initialComposerOptions, trace);
  } catch (error) {
    trace.failUnexpected();
    throw error;
  }
}

async function runV2AgentPipelineWithTrace<P extends RecommendationPlan, I extends PipelineIssue>(
  options: RunV2AgentPipelineOptions<P, I>,
  initialContext: V2PipelineContext,
  initialComposerOptions: AgentSdkRunOptions,
  trace: PipelineTraceObserver
): Promise<V2AgentPipelineResult<P, I>> {
  let context = initialContext;
  let usage = zeroUsage();
  let repairs = 0;
  let critiqueRepairs = 0;
  let previousPlan: unknown;
  let pendingIssues: PipelineIssue[] = [];
  let composerToolEvidence: ToolAudit[] = [];
  const maxComposerRepairs = options.maxComposerRepairs ?? 2;

  while (true) {
    const stage: V2AgentStage = repairs === 0 ? 'compose' : repairs === 1 ? 'repair-1' : 'repair-2';
    const inputSummary =
      stage === 'compose'
        ? `mode=${context.mode}; candidates=${context.candidate.eligibleCharacterIds.length}`
        : `repair=${repairs}; issues=${pendingIssues.map(({ code }) => code).join(',') || 'none'}`;
    notifyStageStart(options.onStageStart, stage);
    const composerOptions = startStageWithSdkOptions(
      stage,
      inputSummary,
      () => (stage === 'compose' ? initialComposerOptions : options.sdkOptionsForStage(stage)),
      trace
    );
    let composerPrompt: string;
    try {
      const prepared =
        stage === 'compose'
          ? serializeStageEnvelope(
              {
                request: parseJsonOrRaw(options.composer.initialPrompt),
                context
              },
              'compose-prompt'
            )
          : serializeStageEnvelope(
              {
                instruction: '只修复具体 issue，返回完整方案。',
                issues: pendingIssues,
                previousPlan: compactRepairPreviousPlan(previousPlan),
                context: repairContext(context, previousPlan)
              },
              'repair-prompt'
            );
      context = prepared.context;
      composerPrompt = prepared.serialized;
    } catch (error) {
      if (error instanceof AgentPayloadTooLargeError) {
        const failure = agentFailure('VALIDATION_FAILED', error.message, false);
        trace.failStage(stage, failure);
        trace.fail(failure);
        return {
          ok: false,
          repairs,
          issues: [options.invalidIssue(stage, error.message)],
          usage
        };
      }
      const failure = agentFailure(
        'VALIDATION_FAILED',
        'Composer input serialization failed.',
        false
      );
      trace.failStage(stage, failure);
      trace.fail(failure);
      throw error;
    }
    let composerTurn: AuditedAgentTurn;
    try {
      composerTurn = await runAuditedAgentTurn({
        runner: options.runner,
        prompt: composerPrompt,
        sdkOptions: composerOptions,
        systemPrompt:
          stage === 'compose'
            ? options.composer.systemPrompt
            : `${options.composer.systemPrompt}\n\n${options.composer.repairPrompt}`,
        auditContext: {
          correlationId: context.correlationId,
          round: stage === 'compose' ? 'compose' : 'repair'
        },
        onUsageDelta: options.onUsageDelta
      });
    } catch (error) {
      const turnFailure = agentTurnFailure(error);
      usage = addAgentUsage(usage, agentTurnErrorUsage(error));
      trace.failStage(
        stage,
        turnFailure,
        agentTurnErrorPartialTurn(error),
        agentTurnErrorUsage(error)
      );
      trace.fail(turnFailure);
      throw error;
    }
    usage = addAgentUsage(usage, composerTurn.usage);
    if (composerTurn.toolsTruncated !== true && composerTurn.tools.length > 0) {
      composerToolEvidence =
        stage !== 'compose' &&
        options.composer.reuseToolEvidenceOnToolFreeRepair === true
          ? mergeComposerToolEvidence(composerToolEvidence, composerTurn.tools)
          : composerTurn.tools;
    }
    let validated: ValidationResult<P, I>;
    try {
      validated =
        composerTurn.toolsTruncated === true
          ? {
              ok: false,
              issues: [
                options.invalidIssue(
                  stage,
                  'Composer tool audit was truncated; required tool evidence is incomplete.'
                )
              ]
            }
          : options.composer.validate(
              composerTurn.text,
              stage !== 'compose' &&
                options.composer.reuseToolEvidenceOnToolFreeRepair === true
                ? composerToolEvidence
                : composerTurn.tools,
              stage
            );
    } catch (error) {
      const failure = agentFailure(
        'VALIDATION_FAILED',
        'Composer validation raised an error.',
        false
      );
      trace.failStage(stage, failure, composerTurn);
      trace.fail(failure);
      throw error;
    }
    if (!validated.ok) {
      const failure = agentFailure(
        composerValidationFailureCode(validated.issues),
        validated.issues[0]?.message ?? 'Composer output validation failed.',
        false
      );
      trace.failStage(stage, failure, composerTurn);
      if (repairs >= maxComposerRepairs) {
        trace.fail(failure);
        return { ok: false, repairs, issues: validated.issues, usage };
      }
      repairs += 1;
      pendingIssues = validated.issues;
      previousPlan = parseJsonOrRaw(composerTurn.text);
      continue;
    }
    let candidateViolation: string | undefined;
    try {
      candidateViolation = candidatePoolViolation(validated.plan, context);
    } catch (error) {
      const failure = agentFailure(
        'VALIDATION_FAILED',
        'Composer returned a plan that could not be validated locally.',
        false
      );
      trace.failStage(stage, failure, composerTurn);
      trace.fail(failure);
      throw error;
    }
    if (candidateViolation) {
      const issue = options.invalidIssue(stage, candidateViolation);
      const failure = agentFailure('VALIDATION_FAILED', candidateViolation, false);
      trace.failStage(stage, failure, composerTurn);
      if (repairs >= maxComposerRepairs) {
        trace.fail(failure);
        return { ok: false, repairs, issues: [issue], usage };
      }
      repairs += 1;
      pendingIssues = [issue];
      previousPlan = validated.plan;
      continue;
    }
    trace.completeStage(stage, composerTurn);
    const strictContext = projectV2PipelineContextForPlan(context, validated.plan);

    notifyStageStart(options.onStageStart, 'critique');
    const critiqueOptions = startStageWithSdkOptions(
      'critique',
      `plan=${validated.plan.mode}; repairs=${repairs}`,
      () => toolFreeOptions(options.sdkOptionsForStage('critique')),
      trace
    );
    const critiqueInput = prepareStrictStageEnvelope(
      'critique',
      v2CritiqueInputSchema,
      {
        stage: 'critique',
        context: strictContext,
        plan: validated.plan
      },
      trace
    );
    if (!critiqueInput.ok) {
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('critique', critiqueInput.message)],
        usage
      };
    }
    const critiqueContext = critiqueInput.context;
    const critiqueResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: critiqueOptions,
      prompt: critiqueInput.input,
      systemPrompt:
        critiqueContext.mode === 'spiral-abyss'
          ? CRITIQUE_PROMPT_V3
          : CRITIQUE_PROMPT_V2,
      schema: v2CritiqueOutputSchema,
      normalize: normalizeCritiqueStageOutput,
      correlationId: context.correlationId,
      onUsageDelta: options.onUsageDelta
    });
    usage = addAgentUsage(usage, critiqueResult.usage);
    if (!critiqueResult.ok) {
      trace.failStage('critique', critiqueResult.failure, critiqueResult.turn);
      trace.fail(critiqueResult.failure);
      if (critiqueResult.error !== undefined) throw critiqueResult.error;
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('critique', critiqueResult.message)],
        usage
      };
    }
    const critiqueTargetError = firstUnknownTarget(
      validated.plan,
      critiqueResult.value.issues.map(({ target }) => target)
    );
    if (critiqueTargetError) {
      const failure = agentFailure('VALIDATION_FAILED', critiqueTargetError, false);
      trace.failStage('critique', failure, critiqueResult.turn);
      trace.fail(failure);
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('critique', critiqueTargetError)],
        usage
      };
    }
    trace.completeStage('critique', critiqueResult.turn);
    const critique =
      critiqueResult.value.decision === 'repair' &&
      (critiqueRepairs >= 1 || repairs >= maxComposerRepairs)
        ? { ...critiqueResult.value, decision: 'accept' as const }
        : critiqueResult.value;
    if (critique.decision === 'repair') {
      critiqueRepairs += 1;
      repairs += 1;
      pendingIssues = critiqueResult.value.issues.map(({ code, message, target }) => ({
        code,
        path: targetPath(target),
        message
      }));
      previousPlan = validated.plan;
      continue;
    }

    notifyStageStart(options.onStageStart, 'rotation');
    const rotationOptions = startStageWithSdkOptions(
      'rotation',
      `plan=${validated.plan.mode}; critique=accepted`,
      () => toolFreeOptions(options.sdkOptionsForStage('rotation')),
      trace
    );
    const rotationInput = prepareStrictStageEnvelope(
      'rotation',
      v2RotationInputSchema,
      {
        stage: 'rotation',
        context: critiqueContext,
        plan: validated.plan,
        critique
      },
      trace
    );
    if (!rotationInput.ok) {
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('rotation', rotationInput.message)],
        usage
      };
    }
    const rotationContext = rotationInput.context;
    const rotationResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: rotationOptions,
      prompt: rotationInput.input,
      systemPrompt:
        rotationContext.mode === 'spiral-abyss'
          ? ROTATION_COACH_PROMPT_V3
          : ROTATION_COACH_PROMPT_V2,
      schema: v2RotationOutputSchema,
      normalize: (value) =>
        normalizeNarrativeStageOutput(
          value,
          'rotations',
          expectedStageTargets(validated.plan, 'rotation'),
          rotationContext.mechanics,
          true
        ),
      correlationId: context.correlationId,
      onUsageDelta: options.onUsageDelta
    });
    usage = addAgentUsage(usage, rotationResult.usage);
    if (!rotationResult.ok) {
      trace.failStage('rotation', rotationResult.failure, rotationResult.turn);
      trace.fail(rotationResult.failure);
      if (rotationResult.error !== undefined) throw rotationResult.error;
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('rotation', rotationResult.message)],
        usage
      };
    }
    const rotationTargetError = exactCoverageError(
      expectedStageTargets(validated.plan, 'rotation'),
      rotationResult.value.rotations.map(({ target }) => target)
    );
    if (rotationTargetError) {
      const failure = agentFailure('VALIDATION_FAILED', rotationTargetError, false);
      trace.failStage('rotation', failure, rotationResult.turn);
      trace.fail(failure);
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('rotation', rotationTargetError)],
        usage
      };
    }
    const rotationFactError = firstGroundingError(
      rotationResult.value.rotations,
      rotationContext,
      options.supportsKnowledgeRef
    );
    if (rotationFactError) {
      const failure = agentFailure('VALIDATION_FAILED', rotationFactError, false);
      trace.failStage('rotation', failure, rotationResult.turn);
      trace.fail(failure);
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('rotation', rotationFactError)],
        usage
      };
    }
    trace.completeStage('rotation', rotationResult.turn);

    notifyStageStart(options.onStageStart, 'explain');
    const explainOptions = startStageWithSdkOptions(
      'explain',
      `plan=${validated.plan.mode}; rotation=validated`,
      () => toolFreeOptions(options.sdkOptionsForStage('explain')),
      trace
    );
    const explainInput = prepareStrictStageEnvelope(
      'explain',
      v2ExplainInputSchema,
      {
        stage: 'explain',
        context: rotationContext,
        plan: validated.plan,
        critique,
        rotation: rotationResult.value
      },
      trace
    );
    if (!explainInput.ok) {
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('explain', explainInput.message)],
        usage
      };
    }
    const explainContext = explainInput.context;
    const explainResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: explainOptions,
      prompt: explainInput.input,
      systemPrompt:
        explainContext.mode === 'spiral-abyss' ? EXPLAIN_PROMPT_V3 : EXPLAIN_PROMPT_V2,
      schema: v2ExplainOutputSchema,
      normalize: (value) =>
        normalizeNarrativeStageOutput(
          value,
          'explanations',
          expectedStageTargets(validated.plan, 'explain'),
          explainContext.mechanics
        ),
      correlationId: context.correlationId,
      onUsageDelta: options.onUsageDelta
    });
    usage = addAgentUsage(usage, explainResult.usage);
    if (!explainResult.ok) {
      trace.failStage('explain', explainResult.failure, explainResult.turn);
      trace.fail(explainResult.failure);
      if (explainResult.error !== undefined) throw explainResult.error;
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('explain', explainResult.message)],
        usage
      };
    }
    const explainTargetError = exactCoverageError(
      expectedStageTargets(validated.plan, 'explain'),
      explainResult.value.explanations.map(({ target }) => target)
    );
    if (explainTargetError) {
      const failure = agentFailure('VALIDATION_FAILED', explainTargetError, false);
      trace.failStage('explain', failure, explainResult.turn);
      trace.fail(failure);
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('explain', explainTargetError)],
        usage
      };
    }
    const explainFactError = firstGroundingError(
      explainResult.value.explanations,
      explainContext,
      options.supportsKnowledgeRef
    );
    if (explainFactError) {
      const failure = agentFailure('VALIDATION_FAILED', explainFactError, false);
      trace.failStage('explain', failure, explainResult.turn);
      trace.fail(failure);
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('explain', explainFactError)],
        usage
      };
    }
    trace.completeStage('explain', explainResult.turn);
    trace.complete();
    return {
      ok: true,
      plan: validated.plan,
      repairs,
      critique,
      rotation: rotationResult.value,
      explanation: explainResult.value,
      usage
    };
  }
}

function notifyStageStart(
  onStageStart: ((stage: V2AgentStage) => void) | undefined,
  stage: V2AgentStage
): void {
  try {
    onStageStart?.(stage);
  } catch {
    // Progress reporting is observational and must not change the checked pipeline result.
  }
}

function repairContext(
  context: V2PipelineContext,
  previousPlan: unknown
): V2PipelineContext {
  const characterIds = candidatePlanCharacterIds(previousPlan);
  const projectionIds =
    characterIds.length > 0
      ? characterIds
      : candidatePlanCharacterIds(context.candidate.feasibleBaseline);
  return projectionIds.length === 0
    ? context
    : projectV2PipelineContextForCharacterIds(context, projectionIds);
}

function compactRepairPreviousPlan(value: unknown, parentKey = ''): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['invalidJson'] === true
  ) {
    return value;
  }
  if (typeof value === 'string') {
    if (
      /(?:^|[A-Z_])ids?$/iu.test(parentKey) ||
      ['mode', 'schemaVersion', 'scenarioId', 'dataVersion', 'confidence'].includes(parentKey)
    ) {
      return value;
    }
    return Array.from(value).slice(0, 32).join('');
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactRepairPreviousPlan(item, parentKey));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      compactRepairPreviousPlan(item, key)
    ])
  );
}

function candidatePlanCharacterIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const plan = value as Record<string, unknown>;
  const ids: string[] = [];
  const appendTeam = (team: unknown) => {
    if (!team || typeof team !== 'object' || Array.isArray(team)) return;
    const characterIds = (team as Record<string, unknown>)['characterIds'];
    if (!Array.isArray(characterIds)) return;
    ids.push(...characterIds.filter((id): id is string => typeof id === 'string'));
  };
  if (plan['mode'] === 'spiral-abyss') {
    appendTeam(plan['firstHalfTeam']);
    appendTeam(plan['secondHalfTeam']);
  } else if (plan['mode'] === 'stygian-onslaught' && Array.isArray(plan['phases'])) {
    for (const phase of plan['phases']) {
      if (phase && typeof phase === 'object' && !Array.isArray(phase)) {
        appendTeam((phase as Record<string, unknown>)['team']);
      }
    }
  } else if (plan['mode'] === 'imaginarium-theater') {
    const cast =
      plan['cast'] && typeof plan['cast'] === 'object' && !Array.isArray(plan['cast'])
        ? (plan['cast'] as Record<string, unknown>)
        : {};
    for (const key of [
      'openingCharacterIds',
      'selectedCharacterIds',
      'trialCharacterIds',
      'specialGuestCharacterIds',
      'supportCharacterIds'
    ]) {
      const values = cast[key];
      if (Array.isArray(values)) {
        ids.push(...values.filter((id): id is string => typeof id === 'string'));
      }
    }
  }
  return [...new Set(ids)];
}

function firstGroundingError(
  directives: Array<{
    reasonCodes: AdvisorNarrativeReasonCode[];
    factRefs: AdvisorFactRef[];
  }>,
  context: V2PipelineContext,
  supportsKnowledgeRef:
    | ((
        characterId: string,
        citationId: string,
        archetypeId: string
      ) => boolean)
    | undefined
): string | undefined {
  const eligibleIds = new Set(context.candidate.eligibleCharacterIds);
  const unknownKnowledgeIds = new Set(context.knowledge.unknowns.map(({ subjectId }) => subjectId));
  const citationsById = new Map(
    context.knowledge.citations.map((citation) => [citation.id, citation])
  );
  const interpretationsById = new Map(
    context.knowledge.buildInterpretations.map((interpretation) => [
      interpretation.characterId,
      interpretation
    ])
  );
  const positivelyGroundedKnowledgeIds = new Set(
    context.knowledge.trustedMatches.flatMap((match) => {
      const characterId = match.characterId;
      if (characterId === undefined) return [];
      const interpretation = interpretationsById.get(characterId);
      const archetypeId = interpretation?.archetypeId;
      if (
        interpretation === undefined ||
        archetypeId === null ||
        archetypeId === undefined ||
        archetypeId !== match.archetypeId ||
        !interpretation.currentBuildUsable ||
        interpretation.adjustment === 'required' ||
        interpretation.contextRequired ||
        interpretation.conflictingSignals.length > 0 ||
        unknownKnowledgeIds.has(characterId) ||
        !match.citationIds.some(
          (citationId) =>
            citationsById.get(citationId)?.trust === 'trusted-local' &&
            (supportsKnowledgeRef?.(characterId, citationId, archetypeId) ?? true)
        )
      ) {
        return [];
      }
      return [characterId];
    })
  );
  for (const match of context.knowledge.ephemeralMatches) {
    const interpretation = interpretationsById.get(match.subjectId);
    if (
      interpretation !== undefined &&
      interpretation.archetypeId !== null &&
      interpretation.currentBuildUsable &&
      interpretation.adjustment !== 'required' &&
      !interpretation.contextRequired &&
      interpretation.conflictingSignals.length === 0 &&
      !unknownKnowledgeIds.has(match.subjectId) &&
      match.citationIds.some(
        (citationId) => citationsById.get(citationId)?.trust === 'ephemeral-web'
      )
    ) {
      positivelyGroundedKnowledgeIds.add(match.subjectId);
    }
  }
  const detailedProfiles = new Map(
    context.profile.detailedProfiles.map((profile) => [String(profile.id), profile])
  );
  for (const directive of directives) {
    for (const ref of directive.factRefs) {
      if (ref.kind === 'plan') continue;
      if (ref.kind === 'profile') {
        const profile = detailedProfiles.get(ref.characterId);
        if (!profile) {
          return `Stage referenced a profile fact outside the bounded roster: ${ref.characterId}`;
        }
        if (!profileFieldAvailable(profile, ref.field)) {
          return `Stage profile field is unavailable: ${ref.characterId}:${ref.field}`;
        }
      }
      if (ref.kind === 'knowledge') {
        if (!eligibleIds.has(ref.characterId)) {
          return `Stage referenced knowledge outside the eligible pool: ${ref.characterId}`;
        }
        if (unknownKnowledgeIds.has(ref.characterId)) {
          return `Stage knowledge is explicitly unknown: ${ref.characterId}`;
        }
        if (!positivelyGroundedKnowledgeIds.has(ref.characterId)) {
          return `Stage knowledge does not resolve to a positive cited match: ${ref.characterId}`;
        }
      }
      if (ref.kind === 'mechanic') {
        const mechanic = context.mechanics.find(({ target }) => target === ref.target);
        if (!mechanic || ref.factIndex >= mechanic.facts.length) {
          return `Stage referenced an unknown mechanic fact: ${ref.target}#${ref.factIndex}`;
        }
      }
    }
    for (const reason of directive.reasonCodes) {
      if (!directive.factRefs.some((ref) => factSupportsReason(ref, reason))) {
        return `Stage reason lacks a compatible fact reference: ${reason}`;
      }
    }
  }
  return undefined;
}

function profileFieldAvailable(
  profile: V2PipelineContext['profile']['detailedProfiles'][number],
  field: Extract<AdvisorFactRef, { kind: 'profile' }>['field']
): boolean {
  switch (field) {
    case 'level':
      return profile.level !== undefined;
    case 'stats':
      return profile.stats !== undefined;
    case 'build':
      return (
        profile.weapon !== undefined ||
        profile.artifactSummary !== undefined ||
        profile.talents !== undefined ||
        profile.stats !== undefined
      );
    case 'completeness':
      return true;
  }
}

function factSupportsReason(ref: AdvisorFactRef, reason: AdvisorNarrativeReasonCode): boolean {
  switch (reason) {
    case 'setup-order':
      return ref.kind === 'plan';
    case 'energy-cycle':
      return (
        ref.kind === 'knowledge' ||
        (ref.kind === 'profile' && (ref.field === 'stats' || ref.field === 'build'))
      );
    case 'survival-window':
      return (
        ref.kind === 'mechanic' ||
        ref.kind === 'knowledge' ||
        (ref.kind === 'profile' && (ref.field === 'stats' || ref.field === 'build'))
      );
    case 'reaction-chain':
      return ref.kind === 'plan' || ref.kind === 'knowledge';
    case 'mechanic-response':
    case 'target-priority':
      return ref.kind === 'mechanic';
    case 'vigor-budget':
      return ref.kind === 'plan' && ref.field === 'vigor-ledger';
    case 'cast-flexibility':
      return ref.kind === 'plan' && ref.field === 'cast-allocation';
    case 'uncertainty':
      return true;
  }
}

async function runStrictStage<T>(options: {
  runner: AuditedAgentRunner;
  sdkOptions: AgentSdkRunOptions;
  prompt: unknown;
  systemPrompt: string;
  schema: z.ZodType<T>;
  normalize?: (value: unknown) => unknown;
  correlationId: string;
  onUsageDelta?: (usage: AgentUsage) => void;
}): Promise<
  | { ok: true; value: T; usage: AgentUsage; turn: AuditedAgentTurn }
  | {
      ok: false;
      message: string;
      usage: AgentUsage;
      failure: AgentFailure;
      turn?: AuditedAgentTurn;
      error?: unknown;
    }
> {
  let prompt: string;
  try {
    prompt = stringifyAgentPayload(options.prompt, 'strict-stage-prompt');
  } catch (error) {
    if (error instanceof AgentPayloadTooLargeError) {
      return {
        ok: false,
        message: error.message,
        usage: zeroUsage(),
        failure: agentFailure('VALIDATION_FAILED', error.message, false)
      };
    }
    const message = 'Stage input serialization failed.';
    return {
      ok: false,
      message,
      usage: zeroUsage(),
      failure: agentFailure('VALIDATION_FAILED', message, false),
      error
    };
  }
  let turn: AuditedAgentTurn;
  try {
    turn = await runAuditedAgentTurn({
      runner: options.runner,
      prompt,
      sdkOptions: {
        ...options.sdkOptions,
        effort: 'low'
      },
      systemPrompt: options.systemPrompt,
      auditContext: { correlationId: options.correlationId, round: 'single' },
      onUsageDelta: options.onUsageDelta
    });
  } catch (error) {
    const failure = agentTurnFailure(error);
    return {
      ok: false,
      message: failure.message,
      usage: agentTurnErrorUsage(error),
      failure,
      turn: agentTurnErrorPartialTurn(error),
      error
    };
  }
  const parsed = parseAgentJson(turn.text);
  if (parsed === undefined) {
    const message = 'Stage did not return strict JSON.';
    return {
      ok: false,
      message,
      usage: turn.usage,
      failure: agentFailure('AGENT_OUTPUT_INVALID', message, false),
      turn
    };
  }
  const result = options.schema.safeParse(options.normalize?.(parsed) ?? parsed);
  return result.success
    ? { ok: true, value: result.data, usage: turn.usage, turn }
    : {
        ok: false,
        message: `Stage output failed schema validation at ${result.error.issues[0]?.path.join('.') || 'root'}.`,
        usage: turn.usage,
        failure: agentFailure(
          'AGENT_OUTPUT_INVALID',
          `Stage output failed schema validation at ${result.error.issues[0]?.path.join('.') || 'root'}.`,
          false
        ),
        turn
      };
}

function normalizeNarrativeStageOutput(
  value: unknown,
  collectionKey: 'rotations' | 'explanations',
  expectedTargets: V2AgentTarget[],
  mechanics: V2PipelineContext['mechanics'],
  removeUnsupportedReasons = false
): unknown {
  if (!isPlainRecord(value) || !Array.isArray(value[collectionKey])) return value;
  let repairedToneAlias = false;
  const normalized = value[collectionKey].map((item) => {
    if (!isPlainRecord(item)) return item;
    let current = item;
    if (
      item['tone'] === 'uncertainty' &&
      Array.isArray(item['reasonCodes']) &&
      item['reasonCodes'].length === 1 &&
      item['reasonCodes'][0] === 'uncertainty'
    ) {
      repairedToneAlias = true;
      current = { ...current, tone: 'cautious' };
    }
    if (Array.isArray(current['factRefs'])) {
      current = {
        ...current,
        factRefs: current['factRefs'].map((ref) =>
          normalizeGlmFactRef(ref, current['target'], mechanics)
        )
      };
    }
    if (
      !removeUnsupportedReasons ||
      !Array.isArray(current['reasonCodes']) ||
      !Array.isArray(current['factRefs'])
    ) {
      return current;
    }
    const reasons = current['reasonCodes'].map((reason) =>
      advisorNarrativeReasonCodeSchema.safeParse(reason)
    );
    const refs = current['factRefs'].map((ref) => advisorFactRefSchema.safeParse(ref));
    if (
      reasons.some((reason) => !reason.success) ||
      refs.some((ref) => !ref.success)
    ) {
      return current;
    }
    const groundedReasons = reasons
      .map((reason) => reason.data!)
      .filter((reason) => refs.some((ref) => factSupportsReason(ref.data!, reason)));
    return groundedReasons.length > 0 && groundedReasons.length < reasons.length
      ? { ...current, reasonCodes: groundedReasons }
      : current;
  });
  if (!repairedToneAlias) return { ...value, [collectionKey]: normalized };
  const expectedKeys = new Set(expectedTargets.map((target) => JSON.stringify(target)));
  const actualKeys = normalized.map((item) =>
    isPlainRecord(item) && isPlainRecord(item['target'])
      ? JSON.stringify(item['target'])
      : undefined
  );
  if (
    actualKeys.some((key) => key === undefined || !expectedKeys.has(key)) ||
    new Set(actualKeys).size !== actualKeys.length
  ) {
    return { ...value, [collectionKey]: normalized };
  }
  const actualKeySet = new Set(actualKeys);
  const fallbacks = expectedTargets
    .filter((target) => !actualKeySet.has(JSON.stringify(target)))
    .map((target) => ({
      target,
      tone: 'cautious',
      reasonCodes: ['uncertainty'],
      factRefs: [{ kind: 'plan', field: 'validated-target' }]
    }));
  return { ...value, [collectionKey]: [...normalized, ...fallbacks] };
}

function normalizeGlmFactRef(
  value: unknown,
  directiveTarget: unknown,
  mechanics: V2PipelineContext['mechanics']
): unknown {
  const knowledgeRef = normalizeGlmKnowledgeFactRef(value);
  return normalizeGlmMechanicTarget(knowledgeRef, directiveTarget, mechanics);
}

function normalizeGlmKnowledgeFactRef(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const keys = Object.keys(value).sort();
  const field = value['field'];
  return (
    value['kind'] === 'knowledge' &&
    keys.length === 2 &&
    keys[0] === 'field' &&
    keys[1] === 'kind' &&
    typeof field === 'string' &&
    /^[1-9]\d{0,127}$/u.test(field)
  )
    ? { kind: 'knowledge', characterId: field }
    : value;
}

function normalizeGlmMechanicTarget(
  value: unknown,
  directiveTarget: unknown,
  mechanics: V2PipelineContext['mechanics']
): unknown {
  if (!isPlainRecord(value)) return value;
  const keys = Object.keys(value).sort();
  if (
    value['kind'] !== 'mechanic' ||
    keys.length !== 3 ||
    keys[0] !== 'factIndex' ||
    keys[1] !== 'kind' ||
    keys[2] !== 'target' ||
    !isPlainRecord(value['target'])
  ) {
    return value;
  }
  const nestedTarget = v2AgentTargetSchema.safeParse(value['target']);
  const outerTarget = v2AgentTargetSchema.safeParse(directiveTarget);
  if (
    !nestedTarget.success ||
    !outerTarget.success ||
    nestedTarget.data.kind !== 'abyss-chamber' ||
    JSON.stringify(nestedTarget.data) !== JSON.stringify(outerTarget.data)
  ) {
    return value;
  }
  const target = `${nestedTarget.data.floor} 层第 ${nestedTarget.data.chamber} 间${
    nestedTarget.data.half === 'first' ? '上半' : '下半'
  }`;
  return mechanics.some((mechanic) => mechanic.target === target)
    ? { ...value, target }
    : value;
}

function normalizeCritiqueStageOutput(value: unknown): unknown {
  if (!isPlainRecord(value) || !Array.isArray(value['issues'])) return value;
  return {
    ...value,
    issues: value['issues'].map((issue) =>
      isPlainRecord(issue) && issue['severity'] === 'hard'
        ? { ...issue, severity: 'soft' }
        : issue
    )
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStrictStageInput<T>(
  stage: Extract<V2AgentStage, 'critique' | 'rotation' | 'explain'>,
  schema: z.ZodType<T>,
  input: unknown,
  trace: PipelineTraceObserver
): T {
  try {
    return schema.parse(input);
  } catch (error) {
    const failure = agentFailure(
      'VALIDATION_FAILED',
      `${stage} input failed local validation.`,
      false
    );
    trace.failStage(stage, failure);
    trace.fail(failure);
    throw error;
  }
}

function prepareStrictStageEnvelope<T extends { context: V2PipelineContext }>(
  stage: Extract<V2AgentStage, 'critique' | 'rotation' | 'explain'>,
  schema: z.ZodType<T>,
  input: unknown,
  trace: PipelineTraceObserver
):
  | { ok: true; input: T; context: V2PipelineContext }
  | { ok: false; message: string } {
  const parsed = parseStrictStageInput(stage, schema, input, trace);
  try {
    const prepared = serializeStageEnvelope(parsed, 'strict-stage-prompt');
    return {
      ok: true,
      input: prepared.input,
      context: prepared.context
    };
  } catch (error) {
    if (!(error instanceof AgentPayloadTooLargeError)) throw error;
    const failure = agentFailure('VALIDATION_FAILED', error.message, false);
    trace.failStage(stage, failure);
    trace.fail(failure);
    return { ok: false, message: error.message };
  }
}

function serializeStageEnvelope<T extends { context: V2PipelineContext }>(
  input: T,
  scope: Extract<
    AgentPayloadScope,
    'compose-prompt' | 'repair-prompt' | 'strict-stage-prompt'
  >
): { input: T; context: V2PipelineContext; serialized: string } {
  const placeholder = JSON.stringify({ ...input, context: null });
  const nonContextBytes =
    Buffer.byteLength(placeholder, 'utf8') - Buffer.byteLength('null', 'utf8');
  const contextBudget = MAX_AGENT_PAYLOAD_BYTES - nonContextBytes;
  if (contextBudget <= 0) {
    throw new AgentPayloadTooLargeError(
      scope,
      Buffer.byteLength(JSON.stringify(input), 'utf8'),
      MAX_AGENT_PAYLOAD_BYTES
    );
  }
  let context: V2PipelineContext;
  try {
    context = fitV2PipelineContextToBudget(input.context, contextBudget);
  } catch (error) {
    if (error instanceof AgentPayloadTooLargeError) {
      throw new AgentPayloadTooLargeError(
        scope,
        nonContextBytes + error.actualBytes,
        MAX_AGENT_PAYLOAD_BYTES
      );
    }
    throw error;
  }
  const fitted = { ...input, context };
  return {
    input: fitted,
    context,
    serialized: stringifyAgentPayload(fitted, scope, MAX_AGENT_PAYLOAD_BYTES)
  };
}

function toolFreeOptions(options: AgentSdkRunOptions): AgentSdkRunOptions {
  return {
    ...options,
    mcpServers: undefined,
    allowedBusinessTools: [],
    maxTurns: 1
  };
}

function startStageWithSdkOptions(
  stage: V2AgentStage,
  inputSummary: string,
  getOptions: () => AgentSdkRunOptions,
  trace: PipelineTraceObserver
): AgentSdkRunOptions {
  let stageOptions: AgentSdkRunOptions;
  try {
    stageOptions = getOptions();
  } catch (error) {
    trace.failSdkStart(stage, `${stage} SDK options could not be prepared.`);
    throw error;
  }
  trace.startStage(stage, inputSummary, stageOptions);
  return stageOptions;
}

function candidatePoolViolation(
  plan: RecommendationPlan,
  context: V2PipelineContext
): string | undefined {
  const eligible = new Set(context.candidate.eligibleCharacterIds);
  const outside = planCharacterIds(plan).filter((id) => !eligible.has(id));
  return outside.length > 0
    ? `Plan selected entities outside the deterministic eligible pool: ${[...new Set(outside)].join(', ')}`
    : undefined;
}

function planCharacterIds(plan: RecommendationPlan): string[] {
  switch (plan.mode) {
    case 'spiral-abyss':
      return [...plan.firstHalfTeam.characterIds, ...plan.secondHalfTeam.characterIds];
    case 'stygian-onslaught':
      return plan.phases.flatMap(({ team }) => team.characterIds);
    case 'imaginarium-theater':
      return [
        ...plan.cast.openingCharacterIds,
        ...plan.cast.selectedCharacterIds,
        ...plan.cast.trialCharacterIds,
        ...plan.cast.specialGuestCharacterIds,
        ...plan.cast.supportCharacterIds,
        ...plan.acts.flatMap(({ candidateCharacterIds }) => candidateCharacterIds)
      ];
  }
}

function firstUnknownTarget(
  plan: RecommendationPlan,
  targets: V2AgentTarget[]
): string | undefined {
  const target = targets.find((candidate) => !targetExists(plan, candidate));
  return target
    ? `Stage referenced a target outside the validated plan: ${JSON.stringify(target)}`
    : undefined;
}

function expectedStageTargets(
  plan: RecommendationPlan,
  stage: 'rotation' | 'explain'
): V2AgentTarget[] {
  switch (plan.mode) {
    case 'spiral-abyss':
      return stage === 'rotation'
        ? [
            { kind: 'abyss-team', half: 'first' },
            { kind: 'abyss-team', half: 'second' }
          ]
        : plan.chambers.flatMap(({ floor, chamber }) =>
            (['first', 'second'] as const).map((half) => ({
              kind: 'abyss-chamber' as const,
              floor,
              chamber,
              half
            }))
          );
    case 'stygian-onslaught':
      return plan.phases.map(({ phase }) => ({ kind: 'stygian-phase', phase }));
    case 'imaginarium-theater':
      return stage === 'rotation'
        ? plan.acts.map(({ act }) => ({ kind: 'theater-act', act }))
        : [
            { kind: 'theater-cast' },
            ...plan.acts.map(({ act }) => ({ kind: 'theater-act' as const, act }))
          ];
  }
}

function exactCoverageError(
  expected: V2AgentTarget[],
  actual: V2AgentTarget[]
): string | undefined {
  const expectedCounts = targetCounts(expected);
  const actualCounts = targetCounts(actual);
  const missing = [...expectedCounts].filter(
    ([key, count]) => (actualCounts.get(key) ?? 0) !== count
  );
  const extra = [...actualCounts].filter(
    ([key, count]) => (expectedCounts.get(key) ?? 0) !== count
  );
  return missing.length === 0 && extra.length === 0
    ? undefined
    : `Stage target coverage must be exact-once; missing=${
        missing.map(([key]) => key).join(',') || 'none'
      }; extra-or-duplicate=${extra.map(([key]) => key).join(',') || 'none'}.`;
}

function targetCounts(targets: V2AgentTarget[]): Map<string, number> {
  const counts = new Map<string, number>();
  targets.forEach((target) => {
    const key = JSON.stringify(target);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

function targetExists(plan: RecommendationPlan, target: V2AgentTarget): boolean {
  if (plan.mode === 'spiral-abyss') {
    if (target.kind === 'abyss-team') return true;
    return (
      target.kind === 'abyss-chamber' &&
      plan.chambers.some(
        ({ floor, chamber }) => floor === target.floor && chamber === target.chamber
      )
    );
  }
  if (plan.mode === 'stygian-onslaught') {
    return (
      target.kind === 'stygian-phase' && plan.phases.some(({ phase }) => phase === target.phase)
    );
  }
  return (
    target.kind === 'theater-cast' ||
    (target.kind === 'theater-act' && plan.acts.some(({ act }) => act === target.act))
  );
}

function targetPath(target: V2AgentTarget): Array<string | number> {
  switch (target.kind) {
    case 'abyss-team':
      return [target.half === 'first' ? 'firstHalfTeam' : 'secondHalfTeam'];
    case 'abyss-chamber':
      return ['chambers', `${target.floor}:${target.chamber}`, target.half];
    case 'stygian-phase':
      return ['phases', target.phase];
    case 'theater-act':
      return ['acts', target.act];
    case 'theater-cast':
      return ['cast'];
  }
}

const TRACE_PIPELINE_STAGES = [
  'compose',
  'repair-1',
  'repair-2',
  'critique',
  'rotation',
  'explain'
] as const;

class PipelineTraceObserver {
  private readonly attempted = new Set<V2AgentStage>();
  private writer: AgentRunTraceWriter | undefined;
  private lease: AgentRunTraceLease | undefined;
  private activeStage: V2AgentStage | undefined;
  private terminal = false;
  private readonly ownsLifecycle: boolean;

  constructor(
    trace: AgentRunTraceWriter | AgentPipelineTraceSession | undefined,
    private readonly context: V2PipelineContext,
    initialOptions?: AgentSdkRunOptions
  ) {
    this.ownsLifecycle = trace !== undefined && !isTraceSession(trace);
    this.writer = isTraceSession(trace) ? trace.writer : trace;
    if (trace === undefined) return;
    if (isTraceSession(trace)) {
      this.lease = trace.lease;
      return;
    }
    try {
      this.lease = trace.start({
        correlationId: context.correlationId,
        model: initialOptions?.model ?? '[unavailable]',
        knowledge: {
          trusted: context.knowledge.coverage.trusted,
          ephemeral: context.knowledge.coverage.ephemeral,
          unknown: context.knowledge.coverage.unknown,
          searched: context.knowledge.ephemeralMatches.length > 0
        },
        sensitiveValues: [
          context.profileRef.uid,
          ...(initialOptions === undefined
            ? []
            : [initialOptions.apiKey, ...Object.values(initialOptions.customHeaders ?? {})])
        ]
      });
    } catch {
      this.disableWriter();
    }
  }

  startStage(stage: V2AgentStage, inputSummary: string, stageOptions: AgentSdkRunOptions): void {
    this.attempted.add(stage);
    this.activeStage = stage;
    this.write((writer, lease) => {
      writer.startStage(lease, {
        stage,
        inputSummary,
        sensitiveValues: [
          this.context.profileRef.uid,
          stageOptions.apiKey,
          ...Object.values(stageOptions.customHeaders ?? {})
        ]
      });
    });
  }

  completeStage(stage: V2AgentStage, turn: AuditedAgentTurn): void {
    this.write((writer, lease) =>
      writer.completeStage(lease, traceStageTerminalInput(stage, turn))
    );
    if (this.activeStage === stage) this.activeStage = undefined;
  }

  failStage(
    stage: V2AgentStage,
    failure: AgentFailure,
    turn?: AuditedAgentTurn,
    usage: AgentUsage = zeroUsage()
  ): void {
    this.write((writer, lease) => {
      writer.failStage(lease, {
        ...traceStageTerminalInput(stage, turn, usage),
        failure
      });
    });
    if (this.activeStage === stage) this.activeStage = undefined;
  }

  failSdkStart(stage: V2AgentStage, inputSummary: string): void {
    if (this.terminal) return;
    const failure = agentFailure(
      'SDK_START_FAILED',
      'Agent SDK options could not be prepared.',
      true
    );
    this.attempted.add(stage);
    this.activeStage = stage;
    this.write((writer, lease) => {
      writer.startStage(lease, {
        stage,
        inputSummary,
        sensitiveValues: [this.context.profileRef.uid]
      });
    });
    this.failStage(stage, failure);
    this.fail(failure);
  }

  failUnexpected(): void {
    if (this.terminal) return;
    const failure = agentFailure('PROVIDER_ERROR', 'Agent pipeline failed unexpectedly.', true);
    if (this.activeStage !== undefined) this.failStage(this.activeStage, failure);
    this.fail(failure);
  }

  complete(): void {
    if (this.terminal) return;
    this.skipUnattempted();
    if (this.ownsLifecycle) {
      this.write((writer, lease) => writer.finish(lease, { finalSource: 'smart-service' }));
    }
    this.terminal = true;
  }

  fail(failure: AgentFailure): void {
    if (this.terminal) return;
    this.skipUnattempted();
    if (this.ownsLifecycle) {
      this.write((writer, lease) => {
        writer.finish(lease, {
          finalSource: 'blocked',
          failure
        });
      });
    }
    this.terminal = true;
  }

  private skipUnattempted(): void {
    for (const stage of TRACE_PIPELINE_STAGES) {
      if (this.attempted.has(stage)) continue;
      this.write((writer, lease) => {
        writer.skipStage(lease, {
          stage,
          inputSummary: 'Stage was not executed.'
        });
      });
    }
  }

  private write(
    operation: (writer: AgentRunTraceWriter, lease: AgentRunTraceLease) => void
  ): void {
    if (this.writer === undefined || this.lease === undefined) return;
    try {
      operation(this.writer, this.lease);
    } catch {
      this.disableWriter();
    }
  }

  private disableWriter(): void {
    this.writer = undefined;
    this.lease = undefined;
  }
}

function isTraceSession(
  value: AgentRunTraceWriter | AgentPipelineTraceSession | undefined
): value is AgentPipelineTraceSession {
  return (
    value !== undefined &&
    typeof value === 'object' &&
    'writer' in value &&
    'lease' in value
  );
}

function mergeComposerToolEvidence(
  previous: readonly ToolAudit[],
  current: readonly ToolAudit[]
): ToolAudit[] {
  const currentIds = new Set(current.map(({ id }) => id));
  return [...previous.filter(({ id }) => !currentIds.has(id)), ...current];
}

function traceStageTerminalInput(
  stage: V2AgentStage,
  turn: AuditedAgentTurn | undefined,
  fallbackUsage: AgentUsage = zeroUsage()
): CompleteStageInput {
  return {
    stage,
    ...(turn === undefined ? {} : { rawOutput: turn.finalRawText }),
    tools: turn?.tools.map(traceTool) ?? [],
    citationIds: [],
    usage: traceUsage(turn?.usage ?? fallbackUsage)
  };
}

function traceTool(tool: ToolAudit): AgentToolTrace {
  const inputSummary = stringifyToolInput(tool.input);
  return tool.succeeded
    ? {
        name: tool.name,
        status: 'completed',
        inputSummary
      }
    : {
        name: tool.name,
        status: 'failed',
        inputSummary,
        failure: agentFailure(
          'TOOL_REQUIREMENT_FAILED',
          'Tool call did not complete successfully.',
          false
        )
      };
}

function stringifyToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return '[unserializable tool input]';
  }
}

function traceUsage(usage: AgentUsage): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens
  };
}

function composerValidationFailureCode(issues: PipelineIssue[]): AgentFailureCode {
  if (issues.some(({ path }) => path[0] === 'tools')) return 'TOOL_REQUIREMENT_FAILED';
  if (
    issues.some(
      ({ code }) =>
        code === 'AGENT_OUTPUT_INVALID' ||
        code.includes('SCHEMA') ||
        code.includes('OUTPUT_INVALID')
    )
  ) {
    return 'AGENT_OUTPUT_INVALID';
  }
  return 'VALIDATION_FAILED';
}

function agentTurnFailure(error: unknown): AgentFailure {
  if (!(error instanceof AgentTurnError)) {
    return agentFailure('PROVIDER_ERROR', 'Agent turn failed.', true);
  }
  const diagnostic = safeAgentTurnFailureDetails(error);
  const details: AgentFailure['details'] = {
    ...(diagnostic.sdkCode === undefined ? {} : { sdkCode: diagnostic.sdkCode }),
    ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: String(diagnostic.httpStatus) })
  };
  switch (error.code) {
    case 'AGENT_TURN_CANCELLED':
      return agentFailure('AGENT_ABORTED', 'Agent turn was cancelled.', true, details);
    case 'AGENT_TURN_STREAM_FAILED':
    case 'AGENT_TURN_RESULT_ERROR':
      return agentFailure('PROVIDER_ERROR', 'Agent provider request failed.', true, details);
    case 'AGENT_TURN_INCOMPLETE':
    case 'AGENT_TURN_OUTPUT_TOO_LARGE':
      return agentFailure(
        'AGENT_OUTPUT_INVALID',
        'Agent turn returned invalid output.',
        false,
        details
      );
  }
}

function agentTurnErrorUsage(error: unknown): AgentUsage {
  return error instanceof AgentTurnError && error.usage !== undefined ? error.usage : zeroUsage();
}

function agentTurnErrorPartialTurn(error: unknown): AuditedAgentTurn | undefined {
  return error instanceof AgentTurnError ? error.partialTurn : undefined;
}

function agentFailure(
  code: AgentFailureCode,
  message: string,
  retryable: boolean,
  details?: AgentFailure['details']
): AgentFailure {
  return {
    code,
    message,
    retryable,
    ...(details === undefined || Object.keys(details).length === 0 ? {} : { details })
  };
}

function parseJsonOrRaw(raw: string): unknown {
  const parsed = parseAgentJson(raw);
  if (parsed !== undefined) return parsed;
  const objectStart = raw.indexOf('{');
  if (objectStart > 0) {
    const repairCandidate = raw.slice(objectStart);
    const recovered =
      parseAgentJson(repairCandidate) ??
      parseStructurallyIncompleteAgentJson(repairCandidate);
    if (recovered !== undefined) return recovered;
  }
  const rawPreview = raw.slice(0, 2_048);
  return {
    invalidJson: true,
    rawPreview,
    rawBytes: Buffer.byteLength(raw, 'utf8'),
    truncated: rawPreview.length < raw.length
  };
}

function zeroUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}
