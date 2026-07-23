import { describe, expect, it } from 'vitest';

import { TheaterPlanAgent } from '../../../src/main/services/theater-plan-agent.js';
import type { AgentSdkRunOptions } from '../../../src/main/services/agent-sdk-adapter.js';
import { buildV2PipelineContext } from '../../../src/main/services/v2-agent-context.js';
import type { CharacterKnowledgeReader } from '../../../src/shared/character-knowledge.js';
import {
  THEATER_CHARACTERS,
  theaterInput,
  theaterScenario,
  validTheaterPlan
} from './theater-test-fixtures.js';

function directive<T>(target: T) {
  return {
    target,
    tone: 'steady',
    reasonCodes: ['setup-order'],
    factRefs: [{ kind: 'plan', field: 'validated-target' }]
  };
}

const groupingKnowledge: CharacterKnowledgeReader = {
  version: 'test',
  coverage: { characterCount: 1, notes: 'test' },
  lookup: (id) =>
    id === '1001'
      ? {
          status: 'known',
          knowledgeVersion: 'test',
          id,
          name: '剧诗角色1',
          capabilities: ['grouping'],
          unknownFields: [
            'weaponType',
            'roles',
            'energyCost',
            'energyNeeds',
            'applicationNotes',
            'kitNotes'
          ]
        }
      : {
          status: 'unknown',
          id,
          knowledgeVersion: 'test',
          unknownFields: [
            'weaponType',
            'roles',
            'energyCost',
            'energyNeeds',
            'capabilities',
            'applicationNotes',
            'kitNotes'
          ]
        },
  coverageFor: (ids) => ({
    knowledgeVersion: 'test',
    requested: new Set(ids).size,
    known: ids.includes('1001') ? 1 : 0,
    unknownCharacterIds: ids.filter((id) => id !== '1001')
  })
};

class Runner {
  calls: Array<{ prompt: string; options: AgentSdkRunOptions }> = [];
  profileInputs: Array<{ uid: string; characterIds: string[] }> = [];
  constructor(
    private outputs: unknown[],
    private toolRounds: number[] = [0, 1],
    private knowledgeIds: string[] = Array.from({ length: 8 }, (_, index) => String(1001 + index))
  ) {}
  async *run(prompt: string, options: AgentSdkRunOptions): AsyncIterable<unknown> {
    this.calls.push({ prompt, options });
    if (options.systemPrompt.includes('CritiqueAgent v2')) {
      yield { type: 'result', result: JSON.stringify({ decision: 'accept', issues: [] }) };
      return;
    }
    if (options.systemPrompt.includes('RotationCoachAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          rotations: [1, 2].map((act) => directive({ kind: 'theater-act', act }))
        })
      };
      return;
    }
    if (options.systemPrompt.includes('ExplainAgent v2')) {
      yield {
        type: 'result',
        result: JSON.stringify({
          explanations: [
            directive({ kind: 'theater-cast' }),
            directive({ kind: 'theater-act', act: 1 }),
            directive({ kind: 'theater-act', act: 2 })
          ]
        })
      };
      return;
    }
    const round = this.calls.length - 1;
    const payload = JSON.parse(prompt) as {
      context: { profileRef: { uid: string } };
    };
    const nextPlan = this.outputs[0] as {
      cast?: Record<string, unknown>;
      acts?: Array<{ candidateCharacterIds?: unknown }>;
    };
    const selectedIds = [
      ...Object.values(nextPlan?.cast ?? {}).flatMap((ids) =>
        Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
      ),
      ...(Array.isArray(nextPlan?.acts)
        ? nextPlan.acts.flatMap(({ candidateCharacterIds }) =>
            Array.isArray(candidateCharacterIds)
              ? candidateCharacterIds.filter((id): id is string => typeof id === 'string')
              : []
          )
        : [])
    ];
    const profileInput = {
      uid: payload.context.profileRef.uid,
      characterIds: [...new Set(selectedIds.filter((id) => /^[1-9]\d*$/.test(id)))]
    };
    this.profileInputs.push(profileInput);
    const uses = [
      { id: 'profile', name: 'mcp__genshin__read_profile_cache', input: profileInput },
      ...[1, 2].map((act) => ({
        id: `act-${act}`,
        name: 'mcp__genshin__query_theater_act',
        input: { scenarioId: 'theater.2026-07', dataVersion: '2026.07.1', act }
      })),
      {
        id: 'knowledge',
        name: 'mcp__genshin__query_genshin_db',
        input: { characterIds: this.knowledgeIds }
      }
    ];
    if (this.toolRounds.includes(round)) {
      yield {
        type: 'assistant',
        message: { content: uses.map((use) => ({ type: 'tool_use', ...use })) }
      };
      yield {
        type: 'user',
        message: {
          content: uses.map(({ id }) => ({
            type: 'tool_result',
            tool_use_id: id,
            is_error: false,
            content: 'ok'
          }))
        }
      };
    }
    yield {
      type: 'result',
      result: JSON.stringify(this.outputs.shift()),
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01
    };
  }
}

function sdkOptions(): AgentSdkRunOptions {
  return {
    apiKey: 'test',
    baseUrl: 'https://example.test',
    model: 'test',
    systemPrompt: '',
    cwd: '/tmp',
    abortController: new AbortController(),
    maxTurns: 4,
    mcpServers: { genshin: { type: 'sdk', name: 'genshin', instance: {} as never } },
    allowedBusinessTools: [
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_theater_act',
      'mcp__genshin__query_genshin_db'
    ]
  };
}

function pipelineContext(feasibleBaseline = validTheaterPlan()) {
  const eligibleCharacterIds = [
    ...THEATER_CHARACTERS.map(({ id }) => String(id)),
    ...feasibleBaseline.cast.openingCharacterIds,
    ...feasibleBaseline.cast.trialCharacterIds,
    ...feasibleBaseline.cast.specialGuestCharacterIds,
    ...feasibleBaseline.cast.supportCharacterIds,
    ...feasibleBaseline.acts.flatMap(({ candidateCharacterIds }) => candidateCharacterIds)
  ];
  return buildV2PipelineContext({
    correlationId: 'theater-test-request',
    profile: {
      schemaVersion: 2,
      uid: '123456789',
      source: 'merged',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      characters: THEATER_CHARACTERS,
      coverage: {
        ownedCount: THEATER_CHARACTERS.length,
        detailedCount: 8,
        buildCount: THEATER_CHARACTERS.length,
        statsCount: THEATER_CHARACTERS.length,
        enkaShowcaseCount: 8,
        missingDetailCount: 4,
        partial: true
      }
    },
    feasibleBaseline,
    eligibleCharacterIds: [...new Set(eligibleCharacterIds)],
    mechanics: [{ target: '所选幕次', facts: ['活力按幕次扣除'], unknowns: ['随机路径结果未知'] }],
    interventions: { target: 'safe-clear' },
    knowledge: {
      version: groupingKnowledge.version,
      unknownCharacterIds: THEATER_CHARACTERS.slice(1).map(({ id }) => String(id))
    }
  });
}

describe('TheaterPlanAgent', () => {
  it('validates compose, performs one repair, and audits tools independently each round', async () => {
    const invalid = validTheaterPlan();
    invalid.acts[1]!.pathChoice = { kind: 'fixed', note: '已确定' };
    const runner = new Runner([invalid, validTheaterPlan()]);
    const result = await new TheaterPlanAgent(runner).compose({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge: groupingKnowledge,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: true,
      repaired: true,
      usage: { inputTokens: 20, outputTokens: 10 }
    });
    expect(runner.calls).toHaveLength(5);
    expect(runner.calls[0]?.prompt).toContain('"locale":"zh-CN"');
    expect(runner.calls[1]?.prompt).toContain('PATH_CHOICE_INVALID');
    expect(runner.profileInputs.every(({ uid }) => uid === '123456789')).toBe(true);
    expect(runner.profileInputs[1]?.characterIds).toEqual(
      expect.arrayContaining(validTheaterPlan().cast.selectedCharacterIds)
    );
  });

  it('requires profile, knowledge, and every target act read in the same round', async () => {
    const runner = new Runner([validTheaterPlan(), validTheaterPlan(), validTheaterPlan()], [0]);
    const result = await new TheaterPlanAgent(runner).compose({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'AGENT_OUTPUT_INVALID', path: ['tools'] })]
    });
    expect(runner.calls).toHaveLength(3);
  });

  it('falls through deterministic issues after exactly one invalid repair', async () => {
    const runner = new Runner(['not-json', {}, 'still-not-json']);
    const result = await new TheaterPlanAgent(runner).compose({
      input: theaterInput(),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      pipelineContext: pipelineContext(),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'AGENT_OUTPUT_INVALID' })]
    });
    expect(runner.calls).toHaveLength(3);
  });

  it('requires an explicit knowledge read for external cast and candidate actors each round', async () => {
    const external = validTheaterPlan();
    external.cast.trialCharacterIds = ['trial.1'];
    external.acts[1]!.candidateCharacterIds[3] = 'trial.1';
    external.acts[1]!.plannedVigorSpend[3] = { characterId: 'trial.1', cost: 1 };
    const runner = new Runner([external, external, external]);
    const result = await new TheaterPlanAgent(runner).compose({
      input: theaterInput({ selectedTrialCharacterIds: ['trial.1'] }),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge: groupingKnowledge,
      pipelineContext: pipelineContext(external),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'AGENT_OUTPUT_INVALID', path: ['tools'] })]
    });
  });

  it('accepts an external actor only after the tool has returned an explicit knowledge result', async () => {
    const external = validTheaterPlan();
    external.cast.trialCharacterIds = ['trial.1'];
    external.acts[1]!.candidateCharacterIds[3] = 'trial.1';
    external.acts[1]!.plannedVigorSpend[3] = { characterId: 'trial.1', cost: 1 };
    const queried = [...Array.from({ length: 8 }, (_, index) => String(1001 + index)), 'trial.1'];
    const runner = new Runner([external], [0], queried);
    const result = await new TheaterPlanAgent(runner).compose({
      input: theaterInput({ selectedTrialCharacterIds: ['trial.1'] }),
      scenario: theaterScenario(),
      characters: THEATER_CHARACTERS,
      knowledge: groupingKnowledge,
      pipelineContext: pipelineContext(external),
      sdkOptions: sdkOptions()
    });
    expect(result).toMatchObject({ ok: true, repaired: false });
  });
});
