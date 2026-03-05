import type { AppConfig } from '../config.js';
import type { CharacterProfile } from '../types/profile.js';

export interface TeamRecommendation {
  name: string;
  characters: Array<{
    id: number;
    name: string;
    element: string;
  }>;
  reasoning: string;
  rotationTip: string;
}

export interface RecommendationResult {
  source: 'llm' | 'fallback';
  summary: string;
  teams: TeamRecommendation[];
}

interface ParsedLlmTeam {
  name?: string;
  characterIds?: number[];
  reasoning?: string;
  rotationTip?: string;
}

interface ParsedLlmResult {
  summary?: string;
  teams?: ParsedLlmTeam[];
}

function normalizeTeam(
  team: ParsedLlmTeam,
  index: number,
  byId: Map<number, CharacterProfile>
): TeamRecommendation | undefined {
  const ids = (team.characterIds ?? []).filter((value) => Number.isInteger(value));
  const characters = ids
    .map((id) => byId.get(id))
    .filter((value): value is CharacterProfile => Boolean(value))
    .slice(0, 4)
    .map((character) => ({
      id: character.id,
      name: character.name,
      element: character.element
    }));

  if (characters.length === 0) {
    return undefined;
  }

  return {
    name: team.name?.trim() || `推荐配队 ${index + 1}`,
    characters,
    reasoning: team.reasoning?.trim() || '该队伍基于角色面板和敌人环境综合选择。',
    rotationTip: team.rotationTip?.trim() || '先挂元素再主C输出，注意循环与生存。'
  };
}

function extractJsonPayload(raw: string): ParsedLlmResult | undefined {
  const candidates = [raw];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }

  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(raw.slice(braceStart, braceEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ParsedLlmResult;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function scoreCharacter(character: CharacterProfile): number {
  const stats = character.stats;
  return (
    stats.level * 3 +
    stats.atk / 14 +
    stats.hp / 220 +
    stats.critRate * 4 +
    stats.critDmg * 2 +
    stats.energyRecharge +
    stats.elementalMastery / 3
  );
}

function fallbackRecommendation(
  characters: CharacterProfile[],
  enemyNames: string[]
): RecommendationResult {
  const sorted = characters.slice().sort((a, b) => scoreCharacter(b) - scoreCharacter(a));
  const core = sorted.slice(0, Math.min(4, sorted.length)).map((character) => ({
    id: character.id,
    name: character.name,
    element: character.element
  }));

  return {
    source: 'fallback',
    summary:
      enemyNames.length > 0
        ? `已根据角色面板与敌人信息（${enemyNames.join('、')}）生成基础推荐。`
        : '未提供敌人信息，已根据角色面板强度生成基础推荐。',
    teams: [
      {
        name: '基础稳妥队',
        characters: core,
        reasoning: '优先选择综合面板最强的四名角色，确保输出与生存上限。',
        rotationTip: '先辅助后主C，保持元素附着和循环稳定。'
      }
    ]
  };
}

function toPromptPayload(characters: CharacterProfile[]) {
  return characters.map((character) => ({
    id: character.id,
    name: character.name,
    element: character.element,
    stats: character.stats
  }));
}

export async function generateRecommendation(options: {
  config: AppConfig;
  characters: CharacterProfile[];
  enemyNames: string[];
  preference?: string;
  fetchImpl?: typeof fetch;
}): Promise<RecommendationResult> {
  const byId = new Map(options.characters.map((character) => [character.id, character]));

  if (!options.config.llmApiKey || !options.config.llmChatUrl) {
    return fallbackRecommendation(options.characters, options.enemyNames);
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  const prompt = {
    task: 'You are a Genshin team recommendation engine.',
    locale: 'zh-CN',
    requirement: 'Return JSON only with fields: summary, teams[].name, teams[].characterIds, teams[].reasoning, teams[].rotationTip',
    rules: [
      'Each team has 4 characterIds from provided list',
      'At most 3 teams',
      'Reasoning and rotation tip in Chinese'
    ],
    enemies: options.enemyNames,
    preference: options.preference ?? '',
    characters: toPromptPayload(options.characters)
  };

  try {
    const response = await fetchImpl(options.config.llmChatUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.config.llmApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.config.llmModel,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are an expert Genshin team recommender. Output strict JSON only.'
          },
          {
            role: 'user',
            content: JSON.stringify(prompt)
          }
        ]
      })
    });

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content;
    if (!response.ok || !content) {
      return fallbackRecommendation(options.characters, options.enemyNames);
    }

    const parsed = extractJsonPayload(content);
    if (!parsed || !Array.isArray(parsed.teams)) {
      return fallbackRecommendation(options.characters, options.enemyNames);
    }

    const teams = parsed.teams
      .map((team, index) => normalizeTeam(team, index, byId))
      .filter((team): team is TeamRecommendation => Boolean(team))
      .slice(0, 3);

    if (teams.length === 0) {
      return fallbackRecommendation(options.characters, options.enemyNames);
    }

    return {
      source: 'llm',
      summary: parsed.summary?.trim() || '已结合角色面板和敌人环境生成推荐队伍。',
      teams
    };
  } catch {
    return fallbackRecommendation(options.characters, options.enemyNames);
  }
}
