import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { PersistedProfile } from '../../shared/domain.js';
import type { TheaterScenario } from '../../shared/theater-advisor.js';
import { localizedMechanicTerm, parseRequiredCapabilities } from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import {
  UNKNOWN_CHARACTER_KNOWLEDGE,
  characterKnowledgeView,
  errorToolResult,
  redactedProfileView,
  textToolResult
} from './advisor-business-tool-common.js';

export const THEATER_MCP_TOOL_NAMES = [
  'mcp__genshin__read_profile_cache',
  'mcp__genshin__query_theater_act',
  'mcp__genshin__query_genshin_db'
] as const;

export interface TheaterBusinessToolLog {
  tool: 'read_profile_cache' | 'query_theater_act' | 'query_genshin_db';
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

export interface TheaterBusinessToolsOptions {
  getProfile: (uid: string) => PersistedProfile | null;
  getScenario: () => TheaterScenario;
  knowledge?: CharacterKnowledgeReader;
  auditContext?: {
    correlationId: string;
    scenarioId: string;
    dataVersion: string;
    round: TheaterBusinessToolLog['round'];
  };
  maxCharacters?: number;
  log?: (event: TheaterBusinessToolLog) => void;
  now?: () => number;
}

export function createTheaterBusinessTools(options: TheaterBusinessToolsOptions) {
  const maxCharacters = Math.min(Math.max(options.maxCharacters ?? 128, 1), 128);
  const now = options.now ?? Date.now;
  const knowledge = options.knowledge ?? UNKNOWN_CHARACTER_KNOWLEDGE;
  const current = options.getScenario();
  const audit = options.auditContext ?? {
    correlationId: 'unscoped',
    scenarioId: current.id,
    dataVersion: current.meta.dataVersion,
    round: 'single' as const
  };
  const run = async <T>(
    toolName: TheaterBusinessToolLog['tool'],
    itemCount: number,
    parameterSummary: TheaterBusinessToolLog['parameterSummary'],
    failure: string,
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
        ...audit,
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
        ...audit,
        knowledgeVersion: knowledge.version,
        parameterSummary,
        issueCodes: [failure]
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
      'query_theater_act',
      '读取已校验剧诗指定幕的敌人、路径和活力资料；只读。',
      {
        scenarioId: z.string().trim().min(1),
        dataVersion: z.string().trim().min(1),
        act: z.number().int().min(1).max(10)
      },
      async ({ scenarioId, dataVersion, act }) =>
        run('query_theater_act', 1, { act }, 'SCENARIO_DATA_UNAVAILABLE', () => {
          const scenario = options.getScenario();
          if (scenario.id !== scenarioId || scenario.meta.dataVersion !== dataVersion)
            throw new Error('Scenario identity mismatch');
          const selected = scenario.acts.find((item) => item.act === act);
          if (!selected) throw new Error('Act not found');
          return {
            act,
            vigorCost: scenario.vigor.actCosts.find((item) => item.act === act)?.cost ?? null,
            encounters: selected.encounters.map(({ waves }) => ({
              waves: waves.map(({ enemies }) => ({ enemies: enemies.map(localizedEnemy) }))
            })),
            pathNotes: selected.pathNotes.map((note) => ({
              kind: note.kind,
              text: note.kind === 'conditional' ? `如果${note.condition}，${note.text}` : note.text
            }))
          };
        }),
      { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
    ),
    tool(
      'query_genshin_db',
      '查询当前本地角色可确认的有限角色知识；未知保持未知。',
      {
        characterIds: z.array(z.string().trim().min(1).max(128)).min(1).max(32)
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

export function createTheaterBusinessMcpServer(options: TheaterBusinessToolsOptions) {
  return createSdkMcpServer({
    name: 'genshin',
    version: '2.0.0',
    instructions: 'Only read bounded validated local Theater data. Unknown fields remain unknown.',
    tools: [...createTheaterBusinessTools(options)],
    alwaysLoad: true
  });
}

function localizedEnemy(
  enemy: TheaterScenario['acts'][number]['encounters'][number]['waves'][number]['enemies'][number]
) {
  return {
    name: enemy.enemy.names['zh-CN'] ?? enemy.enemy.names['zh-Hans'] ?? '未命名敌人',
    level: enemy.level,
    count: enemy.count,
    mechanics: {
      shields: enemy.mechanics.shields.map(({ element, strength }) => ({
        label: `${localizedMechanicTerm(element)}护盾`,
        strength
      })),
      resistances: enemy.mechanics.resistances.map(({ damageType, percent }) => ({
        label: `${localizedMechanicTerm(damageType)}抗性`,
        percent
      })),
      immunities: enemy.mechanics.immunities.map(localizedMechanicTerm),
      requiredCapabilities: parseRequiredCapabilities(enemy.mechanics.tags).map(
        ({ value, known }) => ({ label: known ? capabilityLabel(value) : '未识别要求', known })
      )
    }
  };
}

function capabilityLabel(value: string): string {
  return (
    { grouping: '聚怪能力', healing: '治疗能力', shield: '护盾能力', bow: '弓系角色' }[value] ??
    '已确认对策能力'
  );
}
