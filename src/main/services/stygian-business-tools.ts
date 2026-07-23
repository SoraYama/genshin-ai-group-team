import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { PersistedProfile } from '../../shared/domain.js';
import type { StygianScenario } from '../../shared/stygian-advisor.js';
import { localizedMechanicTerm, parseRequiredCapabilities } from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import { localizeStygianModifier } from '../../shared/stygian-modifier-localization.js';
import {
  UNKNOWN_CHARACTER_KNOWLEDGE,
  characterKnowledgeView,
  errorToolResult,
  redactedProfileView,
  textToolResult
} from './advisor-business-tool-common.js';

export const STYGIAN_MCP_TOOL_NAMES = [
  'mcp__genshin__read_profile_cache',
  'mcp__genshin__query_stygian_phase',
  'mcp__genshin__query_genshin_db'
] as const;

export interface StygianBusinessToolLog {
  tool: 'read_profile_cache' | 'query_stygian_phase' | 'query_genshin_db';
  itemCount: number;
  ok: boolean;
  durationMs: number;
  correlationId: string;
  scenarioId: string;
  dataVersion: string;
  knowledgeVersion: string;
  round: 'compose' | 'repair' | 'repair-1' | 'repair-2' | 'single';
  parameterSummary: Readonly<Record<string, string | number | boolean>>;
  issueCodes: string[];
}

export interface StygianBusinessToolsOptions {
  getProfile: (uid: string) => PersistedProfile | null;
  getScenario: () => StygianScenario;
  knowledge?: CharacterKnowledgeReader;
  auditContext?: {
    correlationId: string;
    scenarioId: string;
    dataVersion: string;
    round: StygianBusinessToolLog['round'];
  };
  maxCharacters?: number;
  log?: (event: StygianBusinessToolLog) => void;
  now?: () => number;
}

export function createStygianBusinessTools(options: StygianBusinessToolsOptions) {
  const maxCharacters = Math.min(Math.max(options.maxCharacters ?? 128, 1), 128);
  const now = options.now ?? Date.now;
  const knowledge = options.knowledge ?? UNKNOWN_CHARACTER_KNOWLEDGE;
  const current = options.getScenario();
  const auditContext = options.auditContext ?? {
    correlationId: 'unscoped',
    scenarioId: current.id,
    dataVersion: current.meta.dataVersion,
    round: 'single'
  };
  const run = async <T>(
    toolName: StygianBusinessToolLog['tool'],
    itemCount: number,
    parameterSummary: StygianBusinessToolLog['parameterSummary'],
    failureIssueCode: string,
    operation: () => T
  ) => {
    const startedAt = now();
    try {
      const value = operation();
      options.log?.({
        tool: toolName,
        itemCount,
        ok: true,
        durationMs: Math.max(0, now() - startedAt),
        ...auditContext,
        knowledgeVersion: knowledge.version,
        parameterSummary,
        issueCodes: []
      });
      return textToolResult(value);
    } catch (error) {
      options.log?.({
        tool: toolName,
        itemCount,
        ok: false,
        durationMs: Math.max(0, now() - startedAt),
        ...auditContext,
        knowledgeVersion: knowledge.version,
        parameterSummary,
        issueCodes: [failureIssueCode]
      });
      return errorToolResult(error instanceof Error ? error.message : 'Tool request failed');
    }
  };

  return [
    tool(
      'read_profile_cache',
      '读取当前 UID 的本地角色摘要；只读，不返回凭据或图片。',
      { uid: z.string().regex(/^\d{9}$/) },
      async ({ uid }) => {
        const profile = options.getProfile(uid);
        return run(
          'read_profile_cache',
          profile?.characters.length ?? 0,
          { requested: 'profile', maxCharacters },
          'PROFILE_NOT_FOUND',
          () => {
            if (!profile) throw new Error('Profile not found');
            return redactedProfileView(profile, maxCharacters);
          }
        );
      },
      { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
    ),
    tool(
      'query_stygian_phase',
      '读取已校验幽境危战中指定阶段与难度的本地化首领资料；只读。',
      {
        scenarioId: z.string().trim().min(1),
        dataVersion: z.string().trim().min(1),
        difficultyId: z.string().trim().min(1),
        phase: z.number().int().min(1).max(3)
      },
      async ({ scenarioId, dataVersion, difficultyId, phase }) => {
        const scenario = options.getScenario();
        const selectedDifficulty = scenario.difficulties.find(({ id }) => id === difficultyId);
        return run(
          'query_stygian_phase',
          1,
          { difficultyOrder: selectedDifficulty?.order ?? -1, phase },
          'SCENARIO_DATA_UNAVAILABLE',
          () => {
            if (scenario.id !== scenarioId || scenario.meta.dataVersion !== dataVersion) {
              throw new Error('Scenario identity mismatch');
            }
            const selectedPhase = scenario.phases.find(
              ({ phase: candidate }) => candidate === phase
            );
            if (!selectedPhase || !selectedDifficulty) throw new Error('Scenario target not found');
            return {
              phase,
              difficulty: localName(selectedDifficulty.name),
              difficultyModifiers: selectedDifficulty.modifiers.map(localizeStygianModifier),
              phaseModifiers: selectedPhase.phaseModifiers.map(localizeStygianModifier),
              bossModifiers: selectedPhase.bossModifiers.map(localizeStygianModifier),
              boss: localizedBoss(selectedPhase.boss),
              reusePolicy: scenario.crossPartyReusePolicy
            };
          }
        );
      },
      { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
    ),
    tool(
      'query_genshin_db',
      '查询当前本地角色资料中可确认的有限角色知识；未知保持 unknown。',
      {
        characterIds: z
          .array(z.string().regex(/^[1-9]\d*$/))
          .min(1)
          .max(12)
      },
      async ({ characterIds }) =>
        run(
          'query_genshin_db',
          characterIds.length,
          { requestedCount: characterIds.length },
          'KNOWLEDGE_LOOKUP_FAILED',
          () => characterKnowledgeView(knowledge, characterIds)
        ),
      { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
    )
  ] as const;
}

export function createStygianBusinessMcpServer(options: StygianBusinessToolsOptions) {
  return createSdkMcpServer({
    name: 'genshin',
    version: '2.0.0',
    instructions: 'Only read bounded, validated local game data. Unknown fields remain unknown.',
    tools: [...createStygianBusinessTools(options)],
    alwaysLoad: true
  });
}

function localizedBoss(boss: StygianScenario['phases'][number]['boss']) {
  return {
    name: localName(boss.enemy),
    level: boss.level,
    count: boss.count,
    mechanics: {
      shields: boss.mechanics.shields.map(({ element, strength }) => ({
        label: `${localizedMechanicTerm(element)}护盾`,
        strength
      })),
      resistances: boss.mechanics.resistances.map(({ damageType, percent }) => ({
        label: `${localizedMechanicTerm(damageType)}抗性`,
        percent
      })),
      immunities: boss.mechanics.immunities.map(localizedMechanicTerm),
      tags: boss.mechanics.tags.filter((tag) => /[\u3400-\u9fff]/u.test(tag)),
      requiredCapabilities: parseRequiredCapabilities(boss.mechanics.tags)
    }
  };
}

function localName(reference: { names: Record<string, string> }): string {
  return reference.names['zh-CN'] ?? reference.names['zh-Hans'] ?? '未命名';
}
