import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { PersistedProfile } from '../../shared/domain.js';
import type { AbyssScenario } from '../../shared/abyss-advisor.js';
import {
  abyssElementLabel,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../shared/abyss-mechanics.js';
import {
  ALL_CHARACTER_KNOWLEDGE_FIELDS,
  type CharacterKnowledgeReader
} from '../../shared/character-knowledge.js';

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
  parameterSummary: Readonly<Record<string, string | number | boolean>>;
  issueCodes: string[];
}

export interface AbyssBusinessToolAuditContext {
  correlationId: string;
  scenarioId: string;
  dataVersion: string;
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
  const knowledge = options.knowledge ?? UNKNOWN_KNOWLEDGE_READER;
  const auditContext = options.auditContext ?? {
    correlationId: 'unscoped',
    scenarioId: options.getScenario().id,
    dataVersion: options.getScenario().meta.dataVersion
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
      return textResult(value);
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
      return errorResult(error instanceof Error ? error.message : 'Tool request failed');
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
            return {
              uid: profile.uid,
              fetchedAt: profile.fetchedAt,
              coverage: profile.coverage,
              characters: profile.characters.slice(0, maxCharacters).map((character) => ({
                id: String(character.id),
                name: character.name,
                element: character.element,
                rarity: character.rarity,
                level: character.level,
                completeness: character.completeness,
                energyRecharge: character.build?.stats?.energyRecharge
              }))
            };
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
          () => ({
            knowledgeVersion: knowledge.version,
            coverage: knowledge.coverageFor(characterIds),
            characters: characterIds.map((id) => knowledge.lookup(id))
          })
        ),
      { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
    )
  ] as const;
}

const UNKNOWN_KNOWLEDGE_READER: CharacterKnowledgeReader = {
  version: 'unavailable',
  coverage: { characterCount: 0, notes: '角色知识资料不可用。' },
  lookup: (id) => ({
    status: 'unknown',
    id,
    knowledgeVersion: 'unavailable',
    unknownFields: [...ALL_CHARACTER_KNOWLEDGE_FIELDS]
  }),
  coverageFor: (characterIds) => ({
    knowledgeVersion: 'unavailable',
    requested: new Set(characterIds).size,
    known: 0,
    unknownCharacterIds: Array.from(new Set(characterIds))
  })
};

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

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true
  };
}
