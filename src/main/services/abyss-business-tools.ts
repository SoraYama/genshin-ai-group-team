import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { PersistedProfile } from '../../shared/domain.js';
import type { AbyssScenario } from '../../shared/abyss-advisor.js';
import type { KnowledgeContextPacket } from '../../shared/advisor-knowledge.js';
import {
  abyssElementLabel,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../shared/abyss-mechanics.js';
import {
  errorToolResult,
  profileCacheToolInput,
  profileCacheView,
  textToolResult
} from './advisor-business-tool-common.js';

export const ABYSS_MCP_TOOL_NAMES = [
  'mcp__genshin__read_profile_cache',
  'mcp__genshin__query_enemy_data',
  'mcp__genshin__query_team_knowledge'
] as const;

export interface AbyssBusinessToolLog {
  tool: 'read_profile_cache' | 'query_enemy_data' | 'query_team_knowledge';
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
  knowledgePacket?: KnowledgeContextPacket;
  knowledgeScope?: Readonly<{
    floor: number;
    chambers: readonly number[];
    eligibleCharacterIds: readonly string[];
  }>;
  auditContext?: AbyssBusinessToolAuditContext;
  maxCharacters?: number;
  log?: (event: AbyssBusinessToolLog) => void;
  now?: () => number;
}

export function createAbyssBusinessTools(options: AbyssBusinessToolsOptions) {
  const maxCharacters = Math.min(Math.max(options.maxCharacters ?? 100, 1), 100);
  const now = options.now ?? Date.now;
  const knowledgeVersion = options.knowledgePacket?.knowledgeVersion ?? 'unavailable';
  const auditContext = {
    correlationId: options.auditContext?.correlationId ?? 'unscoped',
    scenarioId: options.auditContext?.scenarioId ?? options.getScenario().id,
    dataVersion: options.auditContext?.dataVersion ?? options.getScenario().meta.dataVersion,
    round: options.auditContext?.round ?? ('single' as const)
  };
  const run = async <T>(
    toolName: AbyssBusinessToolLog['tool'],
    itemCount: number,
    parameterSummary:
      | AbyssBusinessToolLog['parameterSummary']
      | (() => AbyssBusinessToolLog['parameterSummary']),
    failureIssueCode: string,
    operation: () => T
  ) => {
    const startedAt = now();
    try {
      const value = operation();
      const result = textToolResult(value);
      options.log?.({
        tool: toolName,
        itemCount,
        ok: true,
        durationMs: Math.max(0, now() - startedAt),
        ...auditContext,
        knowledgeVersion,
        parameterSummary:
          typeof parameterSummary === 'function' ? parameterSummary() : parameterSummary,
        issueCodes: []
      });
      return result;
    } catch (error) {
      options.log?.({
        tool: toolName,
        itemCount,
        ok: false,
        durationMs: Math.max(0, now() - startedAt),
        ...auditContext,
        knowledgeVersion,
        parameterSummary:
          typeof parameterSummary === 'function' ? parameterSummary() : parameterSummary,
        issueCodes: [failureIssueCode]
      });
      return errorToolResult(error);
    }
  };

  return [
    tool(
      'read_profile_cache',
      '按页读取当前 UID 的全量角色索引，或按 characterIds 读取完整安全详情；只读，不返回图片、来源明细或凭据。',
      profileCacheToolInput,
      async ({ uid, characterIds, cursor, pageSize }) => {
        const profile = options.getProfile(uid);
        return run(
          'read_profile_cache',
          characterIds?.length ??
            Math.min(pageSize ?? maxCharacters, profile?.characters.length ?? 0),
          {
            requested: characterIds ? 'details' : 'index-page',
            requestedCount: characterIds?.length ?? pageSize ?? maxCharacters
          },
          'PROFILE_NOT_FOUND',
          () => {
            if (!profile) throw new Error('Profile not found');
            return profileCacheView(profile, {
              characterIds,
              cursor,
              pageSize: pageSize ?? maxCharacters
            });
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
      'query_team_knowledge',
      '查询当前推荐运行已预构建的知识包子集；只读，不搜索、不联网、不写入知识库。',
      {
        characterIds: z
          .array(z.string().regex(/^[1-9]\d*$/))
          .min(1)
          .max(8)
          .refine((ids) => new Set(ids).size === ids.length, 'Character IDs must be unique'),
        floor: z.number().int().positive(),
        chamber: z.number().int().positive(),
        half: z.enum(['first', 'second'])
      },
      async ({ characterIds, floor, chamber, half }) => {
        let returnedCitationIds: string[] = [];
        return run(
          'query_team_knowledge',
          characterIds.length,
          () => ({
            requestedCount: characterIds.length,
            floor,
            chamber,
            half,
            returnedCitationIds: returnedCitationIds.join(',')
          }),
          'KNOWLEDGE_LOOKUP_FAILED',
          () => {
            const packet = options.knowledgePacket;
            const scope = options.knowledgeScope;
            if (packet === undefined || scope === undefined) {
              throw new Error('Knowledge packet unavailable');
            }
            if (new Set(characterIds).size !== characterIds.length) {
              throw new Error('Knowledge character IDs must be unique');
            }
            if (floor !== scope.floor || !scope.chambers.includes(chamber)) {
              throw new Error('Knowledge target outside current run scope');
            }
            const eligible = new Set(scope.eligibleCharacterIds);
            if (characterIds.some((id) => !eligible.has(id))) {
              throw new Error('Knowledge character outside current run scope');
            }
            const value = teamKnowledgeSubset(packet, {
              characterIds,
              floor,
              chamber,
              half
            });
            returnedCitationIds = value.citationIds;
            return value;
          }
        );
      },
      { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
    )
  ] as const;
}

function teamKnowledgeSubset(
  packet: KnowledgeContextPacket,
  target: {
    characterIds: string[];
    floor: number;
    chamber: number;
    half: 'first' | 'second';
  }
) {
  const characterIds = new Set(target.characterIds);
  const buildInterpretations = packet.buildInterpretations.filter(({ characterId }) =>
    characterIds.has(characterId)
  );
  const characterStrategies = packet.trustedMatches.filter(
    ({ characterId }) => characterId !== undefined && characterIds.has(characterId)
  );
  const ephemeralCharacterStrategies = packet.ephemeralMatches.filter(({ subjectId }) =>
    characterIds.has(subjectId)
  );
  const mechanicStrategies = packet.trustedMatches.filter(
    ({ mechanicId }) => mechanicId !== undefined
  );
  const unknown = packet.unknowns.filter(
    ({ subjectId, kind }) =>
      characterIds.has(subjectId) ||
      subjectId.startsWith('mechanic:') ||
      subjectId.startsWith('scenario:') ||
      kind === 'payload-truncated'
  );
  const citationIds = Array.from(
    new Set(
      [...characterStrategies, ...ephemeralCharacterStrategies, ...mechanicStrategies].flatMap(
        ({ citationIds: ids }) => ids
      )
    )
  ).sort();
  const citationsById = new Map(packet.citations.map((citation) => [citation.id, citation]));
  return structuredClone({
    knowledgeVersion: packet.knowledgeVersion,
    target: {
      floor: target.floor,
      chamber: target.chamber,
      half: target.half
    },
    buildInterpretations,
    characterStrategies,
    ephemeralCharacterStrategies,
    mechanicStrategies,
    unknown,
    citationIds,
    citations: citationIds.flatMap((id) => {
      const citation = citationsById.get(id);
      return citation === undefined ? [] : [citation];
    })
  });
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
