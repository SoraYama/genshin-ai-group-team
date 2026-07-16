import type { z } from 'zod';
import type {
  AdvisorEvent,
  AdvisorSide,
  CharacterProfile,
  RecommendationResult
} from '../../shared/domain.js';
import {
  critiqueOutputSchema,
  dataCuratorOutputSchema,
  explainOutputSchema,
  rotationCoachOutputSchema,
  teamComposerOutputSchema
} from '../agents/contracts.js';
import { CRITIQUE_PROMPT_V1 } from '../agents/critique/prompt.js';
import { DATA_CURATOR_PROMPT_V1 } from '../agents/data-curator/prompt.js';
import { EXPLAIN_PROMPT_V1 } from '../agents/explain/prompt.js';
import {
  ORCHESTRATION_ROUTE_V1,
  type OrchestrationStage
} from '../agents/orchestrator/policy.js';
import { ROTATION_COACH_PROMPT_V1 } from '../agents/rotation-coach/prompt.js';
import { TEAM_COMPOSER_PROMPT_V1 } from '../agents/team-composer/prompt.js';
import type {
  AgentSdkRunOptions,
  AgentSdkAdapter
} from './agent-sdk-adapter.js';

export interface AdvisorOrchestratorInput {
  serializedProfile: string;
  characters: CharacterProfile[];
  sdkOptions: AgentSdkRunOptions;
  correlationId: string;
  side: AdvisorSide;
  emit: (event: AdvisorEvent) => void;
  onUsage?: (inputTokens: number, outputTokens: number, estimatedCostUsd?: number) => void;
}

export interface AgentQueryRunner {
  run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown>;
}

export class AdvisorOrchestrator {
  constructor(private readonly runner: AgentQueryRunner) {}

  async run(input: AdvisorOrchestratorInput): Promise<RecommendationResult> {
    const context = JSON.parse(input.serializedProfile) as unknown;
    const curator = await this.stage(
      ORCHESTRATION_ROUTE_V1[0],
      DATA_CURATOR_PROMPT_V1,
      context,
      dataCuratorOutputSchema,
      input
    );
    const ownedIds = new Set(input.characters.map((character) => character.id));
    if (curator.usableCharacterIds.some((id) => !ownedIds.has(id))) {
      throw new Error('DataCurator returned an unknown character ID');
    }

    const composer = await this.stage(
      ORCHESTRATION_ROUTE_V1[1],
      TEAM_COMPOSER_PROMPT_V1,
      { context, curator },
      teamComposerOutputSchema,
      input
    );
    const usableIds = new Set(curator.usableCharacterIds);
    for (const team of composer.teams) {
      if (new Set(team.characterIds).size !== 4) throw new Error('Composer returned duplicate IDs');
      if (team.characterIds.some((id) => !usableIds.has(id) || !ownedIds.has(id))) {
        throw new Error('Composer returned an unknown character ID');
      }
    }

    const critique = await this.stage(
      ORCHESTRATION_ROUTE_V1[2],
      CRITIQUE_PROMPT_V1,
      { context, teams: composer.teams },
      critiqueOutputSchema,
      input
    );
    assertOneReviewPerTeam(critique.reviews, composer.teams.length);
    const viableIndexes = critique.reviews
      .filter((review) => review.viable)
      .map((review) => review.teamIndex);
    if (viableIndexes.length === 0) throw new Error('Critique rejected every composed team');

    const rotation = await this.stage(
      ORCHESTRATION_ROUTE_V1[3],
      ROTATION_COACH_PROMPT_V1,
      { context, teams: composer.teams, viableIndexes },
      rotationCoachOutputSchema,
      input
    );
    const rotationByIndex = new Map(
      rotation.rotations.map((item) => [item.teamIndex, item.rotationTip])
    );
    if (viableIndexes.some((index) => !rotationByIndex.has(index))) {
      throw new Error('RotationCoach omitted a viable team');
    }

    const explanation = await this.stage(
      ORCHESTRATION_ROUTE_V1[4],
      EXPLAIN_PROMPT_V1,
      { context, composer, critique, rotation, curator },
      explainOutputSchema,
      input
    );
    const reasoningByIndex = new Map(
      explanation.teams.map((item) => [item.teamIndex, item.reasoning])
    );
    if (viableIndexes.some((index) => !reasoningByIndex.has(index))) {
      throw new Error('ExplainAgent omitted a viable team');
    }

    const byId = new Map(input.characters.map((character) => [character.id, character]));
    return {
      source: 'llm',
      summary: explanation.summary,
      partial: curator.partial,
      dataNotes: curator.dataNotes,
      teams: viableIndexes.map((teamIndex) => {
        const team = composer.teams[teamIndex];
        if (!team) throw new Error('Critique referenced an unknown team');
        const review = critique.reviews.find((item) => item.teamIndex === teamIndex);
        return {
          name: team.name,
          characters: team.characterIds.map((id) => {
            const character = byId.get(id);
            if (!character) throw new Error('Validated character disappeared');
            return { id, name: character.name, element: character.element };
          }),
          reasoning: reasoningByIndex.get(teamIndex) ?? team.concept,
          rotationTip: rotationByIndex.get(teamIndex) ?? '',
          confidence: team.confidence,
          assumptions: team.assumptions,
          critiqueIssues: review?.issues ?? []
        };
      })
    };
  }

  private async stage<T>(
    stage: OrchestrationStage,
    systemPrompt: string,
    payload: unknown,
    schema: z.ZodType<T>,
    input: AdvisorOrchestratorInput
  ): Promise<T> {
    input.emit({
      type: 'progress',
      correlationId: input.correlationId,
      side: input.side,
      stage
    });
    let assistantText = '';
    let resultText = '';
    const stageAbort = new AbortController();
    const abortStage = () => stageAbort.abort();
    input.sdkOptions.abortController.signal.addEventListener('abort', abortStage, { once: true });
    const stageTimer = setTimeout(abortStage, 45_000);
    try {
      for await (const sdkMessage of this.runner.run(JSON.stringify(payload), {
        ...input.sdkOptions,
        abortController: stageAbort,
        systemPrompt,
        maxTurns: 1
      })) {
        if (input.sdkOptions.abortController.signal.aborted) throw new Error('cancelled');
        assistantText += extractAssistantText(sdkMessage);
        if (isObject(sdkMessage) && sdkMessage['type'] === 'result') {
          const result = sdkMessage['result'];
          if (typeof result === 'string') resultText = result;
          const usage = sdkMessage['usage'];
          if (isObject(usage)) {
            input.onUsage?.(
              numberValue(usage['input_tokens']),
              numberValue(usage['output_tokens']),
              numberValue(sdkMessage['total_cost_usd'])
            );
          }
        }
      }
      if (stageAbort.signal.aborted) {
        throw new Error(
          input.sdkOptions.abortController.signal.aborted ? 'cancelled' : `${stage} timed out`
        );
      }
    } finally {
      clearTimeout(stageTimer);
      input.sdkOptions.abortController.signal.removeEventListener('abort', abortStage);
    }
    const candidate = resultText || assistantText;
    const parsed = parseJson(candidate);
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`${stage} output failed schema validation`);
    }
    return validated.data;
  }
}

export function createAdvisorOrchestrator(sdk: AgentSdkAdapter): AdvisorOrchestrator {
  return new AdvisorOrchestrator(sdk);
}

function assertOneReviewPerTeam(
  reviews: Array<{ teamIndex: number }>,
  teamCount: number
): void {
  if (reviews.length !== teamCount) throw new Error('Critique must review every team exactly once');
  const indexes = reviews.map((review) => review.teamIndex).sort((left, right) => left - right);
  if (indexes.some((value, index) => value !== index)) {
    throw new Error('Critique returned duplicate or unknown team indexes');
  }
}

function parseJson(raw: string): unknown {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  const candidates = [raw, fence, open >= 0 && close > open ? raw.slice(open, close + 1) : undefined];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next bounded candidate.
    }
  }
  return undefined;
}

function extractAssistantText(message: unknown): string {
  if (!isObject(message) || message['type'] !== 'assistant') return '';
  const apiMessage = message['message'];
  if (!isObject(apiMessage) || !Array.isArray(apiMessage['content'])) return '';
  return apiMessage['content']
    .filter((block): block is Record<string, unknown> => isObject(block) && block['type'] === 'text')
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
    .join('');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
