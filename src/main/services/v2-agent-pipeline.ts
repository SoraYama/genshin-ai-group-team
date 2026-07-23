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
import type { AgentSdkRunOptions } from './agent-sdk-adapter.js';
import {
  addAgentUsage,
  runAuditedAgentTurn,
  type AgentUsage,
  type AuditedAgentRunner,
  type ToolAudit
} from './agent-turn-audit.js';

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
  let usage = zeroUsage();
  let repairs = 0;
  let previousPlan: unknown;
  let pendingIssues: PipelineIssue[] = [];

  while (true) {
    const stage: V2AgentStage = repairs === 0 ? 'compose' : repairs === 1 ? 'repair-1' : 'repair-2';
    const composerOptions = options.sdkOptionsForStage(stage);
    const composerTurn = await runAuditedAgentTurn({
      runner: options.runner,
      prompt:
        stage === 'compose'
          ? JSON.stringify({
              request: parseJsonOrRaw(options.composer.initialPrompt),
              context
            })
          : JSON.stringify({
              instruction: '只修复具体 issue，返回完整方案。',
              issues: pendingIssues,
              previousPlan,
              context
            }),
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
    usage = addAgentUsage(usage, composerTurn.usage);
    const validated = options.composer.validate(composerTurn.text, composerTurn.tools);
    if (!validated.ok) {
      if (repairs >= 2) return { ok: false, repairs, issues: validated.issues, usage };
      repairs += 1;
      pendingIssues = validated.issues;
      previousPlan = parseJsonOrRaw(composerTurn.text);
      continue;
    }
    const candidateViolation = candidatePoolViolation(validated.plan, context);
    if (candidateViolation) {
      const issue = options.invalidIssue(stage, candidateViolation);
      if (repairs >= 2) return { ok: false, repairs, issues: [issue], usage };
      repairs += 1;
      pendingIssues = [issue];
      previousPlan = validated.plan;
      continue;
    }

    const critiqueResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: toolFreeOptions(options.sdkOptionsForStage('critique')),
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
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('critique', critiqueTargetError)],
        usage
      };
    }
    if (critiqueResult.value.decision === 'repair') {
      if (repairs >= 2) {
        return {
          ok: false,
          repairs,
          issues: [
            options.invalidIssue(
              'critique',
              'Critique still requires repair after the two-round repair budget was exhausted.'
            )
          ],
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

    const rotationResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: toolFreeOptions(options.sdkOptionsForStage('rotation')),
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
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('rotation', rotationTargetError)],
        usage
      };
    }
    const rotationFactError = firstInvalidFactRef(
      rotationResult.value.rotations.flatMap(({ factRefs }) => factRefs),
      context
    );
    if (rotationFactError) {
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('rotation', rotationFactError)],
        usage
      };
    }

    const explainResult = await runStrictStage({
      runner: options.runner,
      sdkOptions: toolFreeOptions(options.sdkOptionsForStage('explain')),
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
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('explain', explainTargetError)],
        usage
      };
    }
    const explainFactError = firstInvalidFactRef(
      explainResult.value.explanations.flatMap(({ factRefs }) => factRefs),
      context
    );
    if (explainFactError) {
      return {
        ok: false,
        repairs,
        issues: [options.invalidIssue('explain', explainFactError)],
        usage
      };
    }
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

function firstInvalidFactRef(
  refs: Array<
    | { kind: 'plan'; field: string }
    | { kind: 'mechanic'; target: string; factIndex: number }
    | { kind: 'profile'; characterId: string; field: string }
    | { kind: 'knowledge'; characterId: string }
  >,
  context: V2PipelineContext
): string | undefined {
  const profileIds = new Set(context.profile.minimalIndex.map(({ id }) => String(id)));
  const eligibleIds = new Set(context.candidate.eligibleCharacterIds);
  for (const ref of refs) {
    if (ref.kind === 'plan') continue;
    if (ref.kind === 'profile' && !profileIds.has(ref.characterId)) {
      return `Stage referenced a profile fact outside the bounded roster: ${ref.characterId}`;
    }
    if (ref.kind === 'knowledge' && !eligibleIds.has(ref.characterId)) {
      return `Stage referenced knowledge outside the eligible pool: ${ref.characterId}`;
    }
    if (ref.kind === 'mechanic') {
      const mechanic = context.mechanics.find(({ target }) => target === ref.target);
      if (!mechanic || ref.factIndex >= mechanic.facts.length) {
        return `Stage referenced an unknown mechanic fact: ${ref.target}#${ref.factIndex}`;
      }
    }
  }
  return undefined;
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
  { ok: true; value: T; usage: AgentUsage } | { ok: false; message: string; usage: AgentUsage }
> {
  const turn = await runAuditedAgentTurn({
    runner: options.runner,
    prompt: JSON.stringify(options.prompt),
    sdkOptions: options.sdkOptions,
    systemPrompt: options.systemPrompt,
    auditContext: { correlationId: options.correlationId, round: 'single' },
    onUsageDelta: options.onUsageDelta
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(turn.text);
  } catch {
    return { ok: false, message: 'Stage did not return strict JSON.', usage: turn.usage };
  }
  const result = options.schema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data, usage: turn.usage }
    : {
        ok: false,
        message: `Stage output failed schema validation at ${result.error.issues[0]?.path.join('.') || 'root'}.`,
        usage: turn.usage
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
