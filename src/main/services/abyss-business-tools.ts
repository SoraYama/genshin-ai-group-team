import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { PersistedProfile } from '../../shared/domain.js';
import type { AbyssScenario } from '../../shared/abyss-advisor.js';
import {
  abyssElementLabel,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import {
  UNKNOWN_CHARACTER_KNOWLEDGE,
  characterKnowledgeView,
  errorToolResult,
  redactedProfileView,
  textToolResult
} from './advisor-business-tool-common.js';

export const ABYSS_MCP_TOOL_NAMES = [
  'mcp__genshin__read_profile_cache',
  'mcp__genshin__query_enemy_data',
  'mcp__genshin__query_genshin_db'
] as const;

export interface AbyssBusinessToolLog {
  tool: 'read_profile_cache' | 'query_enemy_data' | 'query_genshin_db';
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

export interface AbyssBusinessToolAuditContext {
  correlationId: string;
  scenarioId: string;
  dataVersion: string;
  round?: AbyssBusinessToolLog['round'];
}

export interface AbyssBusinessToolsOptions {
  getProfile: (uid: string) => PersistedProfile | null;
  getScenario: () => AbyssScenario;
  knowledge?: CharacterKnowledgeReader;
  auditContext?: AbyssBusinessToolAuditContext;
  maxCharacters?: number;
  log?: (event: AbyssBusinessToolLog) => void;
  now?: () => number;
}

export function createAbyssBusinessTools(options: AbyssBusinessToolsOptions) {
  const maxCharacters = Math.min(Math.max(options.maxCharacters ?? 128, 1), 128);
  const now = options.now ?? Date.now;
  const knowledge = options.knowledge ?? UNKNOWN_CHARACTER_KNOWLEDGE;
  const auditContext = {
    correlationId: options.auditContext?.correlationId ?? 'unscoped',
    scenarioId: options.auditContext?.scenarioId ?? options.getScenario().id,
    dataVersion: options.auditContext?.dataVersion ?? options.getScenario().meta.dataVersion,
    round: options.auditContext?.round ?? ('single' as const)
  };
  const run = async <T>(
    toolName: AbyssBusinessToolLog['tool'],
    itemCount: number,
    parameterSummary: AbyssBusinessToolLog['parameterSummary'],
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
      '读取当前 UID 的本地角色摘要；只读，不返回图片、来源明细或凭据。',
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
      'query_enemy_data',
      '读取已校验深境螺旋场景中指定楼层与房间的本地化敌情；只读。',
      {
        scenarioId: z.string().trim().min(1),
        dataVersion: z.string().trim().min(1),
        floor: z.number().int().positive(),
        chamber: z.number().int().positive()
      },
      async ({ scenarioId, dataVersion, floor, chamber }) =>
        run('query_enemy_data', 1, { floor, chamber }, 'SCENARIO_DATA_UNAVAILABLE', () => {
          const scenario = options.getScenario();
          if (scenario.id !== scenarioId || scenario.meta.dataVersion !== dataVersion) {
            throw new Error('Scenario identity mismatch');
          }
          const selected = scenario.floors
            .find(({ floor: candidate }) => candidate === floor)
            ?.chambers.find(({ chamber: candidate }) => candidate === chamber);
          if (!selected) throw new Error('Scenario target not found');
          return {
            floor,
            chamber,
            targetSeconds: selected.targetSeconds,
            firstHalf: selected.firstHalf.waves.map(localizedWave),
            secondHalf: selected.secondHalf.waves.map(localizedWave),
            blessing: scenario.blessing.description
          };
        }),
      { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
    ),
    tool(
      'query_genshin_db',
      '查询当前本地角色资料中可确认的有限角色知识；未知职责与技能必须返回 unknown。',
      {
        characterIds: z
          .array(z.string().regex(/^[1-9]\d*$/))
          .min(1)
          .max(8)
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

export function createAbyssBusinessMcpServer(options: AbyssBusinessToolsOptions) {
  return createSdkMcpServer({
    name: 'genshin',
    version: '2.0.0',
    instructions: 'Only read bounded, validated local game data. Unknown fields remain unknown.',
    tools: [...createAbyssBusinessTools(options)],
    alwaysLoad: true
  });
}

function localizedWave(
  wave: AbyssScenario['floors'][number]['chambers'][number]['firstHalf']['waves'][number]
) {
  return {
    enemies: wave.enemies.map((enemy) => ({
      name: enemy.enemy.names['zh-CN'] ?? enemy.enemy.names['zh'] ?? '未命名敌人',
      level: enemy.level,
      count: enemy.count,
      mechanics: {
        shields: enemy.mechanics.shields.map(({ element, strength }) => ({
          label: `${elementLabel(element)}元素护盾`,
          strength
        })),
        resistances: enemy.mechanics.resistances.map(({ damageType, percent }) => ({
          label: `${elementLabel(damageType)}抗性`,
          percent
        })),
        immunities: enemy.mechanics.immunities.map(localizedMechanicTerm),
        tags: enemy.mechanics.tags.filter((tag) => /[\u3400-\u9fff]/u.test(tag)),
        requiredCapabilities: parseRequiredCapabilities(enemy.mechanics.tags)
      }
    }))
  };
}

function elementLabel(value: string): string {
  if (value === 'untyped') return '无属性';
  return abyssElementLabel(value);
}
