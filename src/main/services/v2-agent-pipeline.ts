import type { z } from 'zod';

import {
  v2CritiqueInputSchema,
  v2CritiqueOutputSchema,
  v2ExplainInputSchema,
  v2ExplainOutputSchema,
  v2PipelineContextSchema,
  v2RotationInputSchema,
  v2RotationOutputSchema,
  type V2AgentTarget,
  type V2CritiqueOutput,
  type V2ExplainOutput,
  type V2PipelineContext,
  type V2RotationOutput
} from '../agents/contracts.js';
import { CRITIQUE_PROMPT_V2 } from '../agents/critique/prompt.js';
import { EXPLAIN_PROMPT_V2 } from '../agents/explain/prompt.js';
import { ROTATION_COACH_PROMPT_V2 } from '../agents/rotation-coach/prompt.js';
import type { RecommendationPlan } from '../../shared/scenario-v2.js';
import type { AdvisorFactRef, AdvisorNarrativeReasonCode } from '../../shared/advisor-narrative.js';
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import {
  AgentTurnError,
  addAgentUsage,
  runAuditedAgentTurn,
  type AgentUsage,
  type AuditedAgentTurn,
  type AuditedAgentRunner,
  type ToolAudit
} from './agent-turn-audit.js';
import { AgentPayloadTooLargeError, stringifyAgentPayload } from './agent-payload-budget.js';
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
  trace?: AgentRunTraceWriter;
  onUsageDelta?: (usage: AgentUsage) => void;
  sdkOptionsForStage: (stage: V2AgentStage) => AgentSdkRunOptions;
  composer: {
    initialPrompt: string;
    systemPrompt: string;
    repairPrompt: string;
    validate: (text: string, tools: ToolAudit[]) => ValidationResult<P, I>;
  };
  invalidIssue: (stage: V2AgentStage, message: string) => I;
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
  context: V2PipelineContext,
  initialComposerOptions: AgentSdkRunOptions,
  trace: PipelineTraceObserver
): Promise<V2AgentPipelineResult<P, I>> {
  let usage = zeroUsage();
  let repairs = 0;
  let previousPlan: unknown;
  let pendingIssues: PipelineIssue[] = [];

  while (true) {
    const stage: V2AgentStage = repairs === 0 ? 'compose' : repairs === 1 ? 'repair-1' : 'repair-2';
    const inputSummary =
      stage === 'compose'
        ? `mode=${context.mode}; candidates=${context.candidate.eligibleCharacterIds.length}`
        : `repair=${repairs}; issues=${pendingIssues.map(({ code }) => code).join(',') || 'none'}`;
    const composerOptions = startStageWithSdkOptions(
      stage,
      inputSummary,
      () => (stage === 'compose' ? initialComposerOptions : options.sdkOptionsForStage(stage)),
      trace
    );
    let composerPrompt: string;
    try {
      composerPrompt =
        stage === 'compose'
          ? stringifyAgentPayload(
              {
                request: parseJsonOrRaw(options.composer.initialPrompt),
                context
              },
              'compose-prompt'
            )
          : stringifyAgentPayload(
              {
                instruction: '只修复具体 issue，返回完整方案。',
                issues: pendingIssues,
                previousPlan,
                context
              },
              'repair-prompt'
            );
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
      trace.failStage(stage, turnFailure, undefined, agentTurnErrorUsage(error));
      trace.fail(turnFailure);
      throw error;
    }
    usage = addAgentUsage(usage, composerTurn.usage);
    let validated: ValidationResult<P, I>;
    try {
      validated = options.composer.validate(composerTurn.text, composerTurn.tools);
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
      if (repairs >= 2) {
        trace.fail(failure);
        return { ok: false, repairs, issues: validated.issues, usage };
      }
      repairs += 1;
      pendingIssues = validated.issues;
      previousPlan = parseJsonOrRaw(composerTurn.text);
      continue;
    }
    const candidateViolation = candidatePoolViolation(validated.plan, context);
    if (candidateViolation) {
      const issue = options.invalidIssue(stage, candidateViolation);
      const failure = agentFailure('VALIDATION_FAILED', candidateViolation, false);
      trace.failStage(stage, failure, composerTurn);
      if (repairs >= 2) {
        trace.fail(failure);
        return { ok: false, repairs, issues: [issue], usage };
      }
      repairs += 1;
      pendingIssues = [issue];
      previousPlan = validated.plan;
      continue;
    }
    trace.completeStage(stage, composerTurn);

    const critiqueOptions = startStageWithSdkOptions(
      'critique',
      `plan=${validated.plan.mode}; repairs=${repairs}`,
      () => toolFreeOptions(options.sdkOptionsForStage('critique')),
      trace
    );
    const critiqueResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: critiqueOptions,
      prompt: v2CritiqueInputSchema.parse({
        stage: 'critique',
        context,
        plan: validated.plan
      }),
      systemPrompt: CRITIQUE_PROMPT_V2,
      schema: v2CritiqueOutputSchema,
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
    if (critiqueResult.value.decision === 'repair') {
      if (repairs >= 2) {
        const message =
          'Critique still requires repair after the two-round repair budget was exhausted.';
        const failure = agentFailure('VALIDATION_FAILED', message, false);
        trace.fail(failure);
        return {
          ok: false,
          repairs,
          issues: [options.invalidIssue('critique', message)],
          usage
        };
      }
      repairs += 1;
      pendingIssues = critiqueResult.value.issues.map(({ code, message, target }) => ({
        code,
        path: targetPath(target),
        message
      }));
      previousPlan = validated.plan;
      continue;
    }

    const rotationOptions = startStageWithSdkOptions(
      'rotation',
      `plan=${validated.plan.mode}; critique=accepted`,
      () => toolFreeOptions(options.sdkOptionsForStage('rotation')),
      trace
    );
    const rotationResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: rotationOptions,
      prompt: v2RotationInputSchema.parse({
        stage: 'rotation',
        context,
        plan: validated.plan,
        critique: critiqueResult.value
      }),
      systemPrompt: ROTATION_COACH_PROMPT_V2,
      schema: v2RotationOutputSchema,
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
    const rotationFactError = firstGroundingError(rotationResult.value.rotations, context);
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

    const explainOptions = startStageWithSdkOptions(
      'explain',
      `plan=${validated.plan.mode}; rotation=validated`,
      () => toolFreeOptions(options.sdkOptionsForStage('explain')),
      trace
    );
    const explainResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: explainOptions,
      prompt: v2ExplainInputSchema.parse({
        stage: 'explain',
        context,
        plan: validated.plan,
        critique: critiqueResult.value,
        rotation: rotationResult.value
      }),
      systemPrompt: EXPLAIN_PROMPT_V2,
      schema: v2ExplainOutputSchema,
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
    const explainFactError = firstGroundingError(explainResult.value.explanations, context);
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
      critique: critiqueResult.value,
      rotation: rotationResult.value,
      explanation: explainResult.value,
      usage
    };
  }
}

function firstGroundingError(
  directives: Array<{
    reasonCodes: AdvisorNarrativeReasonCode[];
    factRefs: AdvisorFactRef[];
  }>,
  context: V2PipelineContext
): string | undefined {
  const eligibleIds = new Set(context.candidate.eligibleCharacterIds);
  const unknownKnowledgeIds = new Set(context.knowledge.unknowns.map(({ subjectId }) => subjectId));
  const citationsById = new Map(
    context.knowledge.citations.map((citation) => [citation.id, citation])
  );
  const positivelyGroundedKnowledgeIds = new Set([
    ...context.knowledge.trustedMatches.flatMap((match) =>
      match.characterId !== undefined &&
      match.citationIds.some(
        (citationId) => citationsById.get(citationId)?.trust === 'trusted-local'
      )
        ? [match.characterId]
        : []
    ),
    ...context.knowledge.ephemeralMatches.flatMap((match) =>
      match.citationIds.some(
        (citationId) => citationsById.get(citationId)?.trust === 'ephemeral-web'
      )
        ? [match.subjectId]
        : []
    )
  ]);
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
    throw error;
  }
  let turn: AuditedAgentTurn;
  try {
    turn = await runAuditedAgentTurn({
      runner: options.runner,
      prompt,
      sdkOptions: options.sdkOptions,
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
      error
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(turn.text);
  } catch {
    const message = 'Stage did not return strict JSON.';
    return {
      ok: false,
      message,
      usage: turn.usage,
      failure: agentFailure('AGENT_OUTPUT_INVALID', message, false),
      turn
    };
  }
  const result = options.schema.safeParse(parsed);
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
  private readonly lease: AgentRunTraceLease | undefined;
  private activeStage: V2AgentStage | undefined;
  private terminal = false;

  constructor(
    private readonly writer: AgentRunTraceWriter | undefined,
    private readonly context: V2PipelineContext,
    initialOptions?: AgentSdkRunOptions
  ) {
    this.lease = this.writer?.start({
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
  }

  startStage(stage: V2AgentStage, inputSummary: string, stageOptions: AgentSdkRunOptions): void {
    this.attempted.add(stage);
    this.activeStage = stage;
    if (this.writer === undefined || this.lease === undefined) return;
    this.writer.startStage(this.lease, {
      stage,
      inputSummary,
      sensitiveValues: [
        this.context.profileRef.uid,
        stageOptions.apiKey,
        ...Object.values(stageOptions.customHeaders ?? {})
      ]
    });
  }

  completeStage(stage: V2AgentStage, turn: AuditedAgentTurn): void {
    if (this.writer !== undefined && this.lease !== undefined) {
      this.writer.completeStage(this.lease, traceStageTerminalInput(stage, turn));
    }
    if (this.activeStage === stage) this.activeStage = undefined;
  }

  failStage(
    stage: V2AgentStage,
    failure: AgentFailure,
    turn?: AuditedAgentTurn,
    usage: AgentUsage = zeroUsage()
  ): void {
    if (this.writer !== undefined && this.lease !== undefined) {
      this.writer.failStage(this.lease, {
        ...traceStageTerminalInput(stage, turn, usage),
        failure
      });
    }
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
    if (this.writer !== undefined && this.lease !== undefined) {
      this.writer.startStage(this.lease, {
        stage,
        inputSummary,
        sensitiveValues: [this.context.profileRef.uid]
      });
    }
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
    if (this.writer !== undefined && this.lease !== undefined) {
      this.writer.finish(this.lease, { finalSource: 'smart-service' });
    }
    this.terminal = true;
  }

  fail(failure: AgentFailure): void {
    if (this.terminal) return;
    this.skipUnattempted();
    if (this.writer !== undefined && this.lease !== undefined) {
      this.writer.finish(this.lease, {
        finalSource: 'blocked',
        failure
      });
    }
    this.terminal = true;
  }

  private skipUnattempted(): void {
    for (const stage of TRACE_PIPELINE_STAGES) {
      if (this.attempted.has(stage)) continue;
      if (this.writer !== undefined && this.lease !== undefined) {
        this.writer.skipStage(this.lease, {
          stage,
          inputSummary: 'Stage was not executed.'
        });
      }
    }
  }
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
  switch (error.code) {
    case 'AGENT_TURN_CANCELLED':
      return agentFailure('AGENT_ABORTED', 'Agent turn was cancelled.', true);
    case 'AGENT_TURN_STREAM_FAILED':
    case 'AGENT_TURN_RESULT_ERROR':
      return agentFailure('PROVIDER_ERROR', 'Agent provider request failed.', true);
    case 'AGENT_TURN_INCOMPLETE':
    case 'AGENT_TURN_OUTPUT_TOO_LARGE':
      return agentFailure('AGENT_OUTPUT_INVALID', 'Agent turn returned invalid output.', false);
  }
}

function agentTurnErrorUsage(error: unknown): AgentUsage {
  return error instanceof AgentTurnError && error.usage !== undefined ? error.usage : zeroUsage();
}

function agentFailure(code: AgentFailureCode, message: string, retryable: boolean): AgentFailure {
  return { code, message, retryable };
}

function parseJsonOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function zeroUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}
