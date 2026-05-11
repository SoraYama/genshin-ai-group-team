import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { app } from 'electron';
import { query, type Options as SdkOptions } from '@anthropic-ai/claude-agent-sdk';
import type {
  AdvisorCompareRequest,
  AdvisorCompareResult,
  AdvisorEvent,
  AdvisorRequest,
  AdvisorSide,
  CharacterProfile,
  LlmHealthReport,
  PersistedProfile,
  RecommendationResult,
  TeamRecommendation
} from '../../shared/domain.js';
import { ADVISOR_SYSTEM_PROMPT_V1 } from '../agents/advisor/prompt.js';
import type { ConfigService } from './config-service.js';
import type { HistoryStore } from './history-store.js';
import type { ProfileStore } from './profile-store.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECOMMEND_TIMEOUT_MS = 60_000;
const DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task'
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveClaudeCliPath(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
    );
  }
  return path.resolve(
    __dirname,
    '../../node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
  );
}

interface ParsedTeamFromLlm {
  name?: string;
  characterIds?: number[];
  reasoning?: string;
  rotationTip?: string;
}

interface ParsedLlmPayload {
  summary?: string;
  teams?: ParsedTeamFromLlm[];
  error?: string;
}

interface RunOneInput {
  uid: string;
  enemyNames: string[];
  preference?: string;
  side: AdvisorSide;
  compareGroupId?: string;
}

export class AdvisorAgent {
  private currentAbort: AbortController | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly profiles: ProfileStore,
    private readonly history: HistoryStore
  ) {}

  async testConnection(): Promise<LlmHealthReport> {
    const apiKey = this.config.getApiKey();
    const baseUrl = this.config.getBaseUrl();
    const model = this.config.getModel();
    const customHeaders = this.config.getCustomHeaders();

    if (!apiKey) {
      return {
        ok: false,
        latencyMs: 0,
        model,
        baseUrl,
        message: '尚未配置 API Key'
      };
    }

    const start = Date.now();
    try {
      const { statusCode, body } = await request(joinUrl(baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...customHeaders
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }),
        bodyTimeout: DEFAULT_TIMEOUT_MS,
        headersTimeout: DEFAULT_TIMEOUT_MS
      });

      const latencyMs = Date.now() - start;
      const ok = statusCode >= 200 && statusCode < 300;
      const message = ok ? undefined : truncate(await body.text(), 200);
      if (ok) {
        await body.dump();
      }
      return { ok, latencyMs, model, baseUrl, httpStatus: statusCode, message };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        model,
        baseUrl,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  cancel(): boolean {
    if (!this.currentAbort) {
      return false;
    }
    this.currentAbort.abort();
    return true;
  }

  async recommend(
    input: AdvisorRequest,
    emit: (event: AdvisorEvent) => void
  ): Promise<RecommendationResult> {
    return this.runOne(
      {
        uid: input.uid,
        enemyNames: input.enemyNames,
        preference: input.preference,
        side: 'single'
      },
      emit
    );
  }

  async compare(
    input: AdvisorCompareRequest,
    emit: (event: AdvisorEvent) => void
  ): Promise<AdvisorCompareResult> {
    const groupId = randomUUID();

    const left = await this.runOne(
      {
        uid: input.uid,
        enemyNames: input.left.enemyNames,
        preference: input.left.preference,
        side: 'left',
        compareGroupId: groupId
      },
      emit
    );

    const right = await this.runOne(
      {
        uid: input.uid,
        enemyNames: input.right.enemyNames,
        preference: input.right.preference,
        side: 'right',
        compareGroupId: groupId
      },
      emit
    );

    return {
      groupId,
      left,
      right,
      diffSummary: buildDiffSummary(left, right)
    };
  }

  private async runOne(
    input: RunOneInput,
    emit: (event: AdvisorEvent) => void
  ): Promise<RecommendationResult> {
    const correlationId = randomUUID();
    const { side } = input;
    emit({ type: 'started', correlationId, side });

    const profile = this.profiles.get(input.uid);
    if (!profile) {
      emit({
        type: 'error',
        correlationId,
        side,
        message: `未找到该 UID 的角色缓存：${input.uid}`
      });
      throw new Error(`UID 未绑定：${input.uid}`);
    }

    if (profile.characters.length < 4) {
      emit({
        type: 'progress',
        correlationId,
        side,
        stage: 'fallback',
        message: '角色不足 4 个，使用本地启发式算法'
      });
      const fallback = buildFallback(profile.characters, input.enemyNames);
      this.persistHistory(input, fallback);
      emit({ type: 'final', correlationId, side, result: fallback });
      return fallback;
    }

    const apiKey = this.config.getApiKey();
    if (!apiKey) {
      emit({
        type: 'progress',
        correlationId,
        side,
        stage: 'fallback',
        message: 'LLM API Key 未配置，使用本地启发式算法'
      });
      const fallback = buildFallback(profile.characters, input.enemyNames);
      this.persistHistory(input, fallback);
      emit({ type: 'final', correlationId, side, result: fallback });
      return fallback;
    }

    const abort = new AbortController();
    this.currentAbort = abort;
    const cancelTimer = setTimeout(() => {
      abort.abort();
    }, DEFAULT_RECOMMEND_TIMEOUT_MS);

    try {
      emit({
        type: 'progress',
        correlationId,
        side,
        stage: 'analyzing',
        message: '正在分析角色面板与敌人环境...'
      });

      const userMessage = buildUserMessage(profile, input);
      const options: SdkOptions = {
        systemPrompt: ADVISOR_SYSTEM_PROMPT_V1,
        env: {
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_BASE_URL: this.config.getBaseUrl(),
          ANTHROPIC_MODEL: this.config.getModel(),
          ELECTRON_RUN_AS_NODE: '1'
        },
        pathToClaudeCodeExecutable: resolveClaudeCliPath(),
        executable: process.execPath as 'node',
        disallowedTools: DISALLOWED_TOOLS,
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        abortController: abort,
        cwd: app.getPath('userData'),
        stderr: (data) => {
          if (data.trim().length > 0) {
            emit({
              type: 'progress',
              correlationId,
              side,
              stage: 'sdk-log',
              message: data.trim().slice(0, 200)
            });
          }
        }
      };

      let accumulated = '';
      const q = query({ prompt: userMessage, options });

      for await (const message of q) {
        if (abort.signal.aborted) {
          break;
        }
        const text = extractTextFromMessage(message);
        if (text) {
          accumulated += text;
          emit({ type: 'delta', correlationId, side, text });
        }
        if (isResultMessage(message)) {
          const final = (message as { result?: string }).result;
          if (typeof final === 'string' && final.length > 0 && !accumulated.includes(final)) {
            accumulated += final;
            emit({ type: 'delta', correlationId, side, text: final });
          }
          break;
        }
      }

      if (abort.signal.aborted) {
        emit({ type: 'cancelled', correlationId, side });
        throw new Error('cancelled');
      }

      const parsed = extractJsonPayload(accumulated);
      if (!parsed || !Array.isArray(parsed.teams) || parsed.teams.length === 0) {
        emit({
          type: 'progress',
          correlationId,
          side,
          stage: 'fallback',
          message: '模型未输出合法 JSON，回退本地启发式算法'
        });
        const fallback = buildFallback(profile.characters, input.enemyNames);
        this.persistHistory(input, fallback);
        emit({ type: 'final', correlationId, side, result: fallback });
        return fallback;
      }

      const result = normalizeLlmResult(parsed, profile.characters);
      if (result.teams.length === 0) {
        const fallback = buildFallback(profile.characters, input.enemyNames);
        this.persistHistory(input, fallback);
        emit({ type: 'final', correlationId, side, result: fallback });
        return fallback;
      }
      this.persistHistory(input, result);
      emit({ type: 'final', correlationId, side, result });
      return result;
    } catch (error) {
      if (abort.signal.aborted) {
        emit({ type: 'cancelled', correlationId, side });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: 'progress',
        correlationId,
        side,
        stage: 'fallback',
        message: `LLM 调用失败：${message}`
      });
      const fallback = buildFallback(profile.characters, input.enemyNames);
      this.persistHistory(input, fallback);
      emit({ type: 'final', correlationId, side, result: fallback });
      return fallback;
    } finally {
      clearTimeout(cancelTimer);
      if (this.currentAbort === abort) {
        this.currentAbort = undefined;
      }
    }
  }

  private persistHistory(input: RunOneInput, result: RecommendationResult): void {
    try {
      this.history.append({
        uid: input.uid,
        enemyNames: input.enemyNames,
        preference: input.preference,
        result,
        side: input.side,
        compareGroupId: input.compareGroupId
      });
    } catch {
      // 永不让历史持久化失败影响推荐主流程
    }
  }
}

function buildUserMessage(
  profile: PersistedProfile,
  input: { enemyNames: string[]; preference?: string }
): string {
  const compact = {
    characters: profile.characters.map((character) => ({
      id: character.id,
      name: character.name,
      element: character.element,
      rarity: character.rarity,
      stats: character.stats
    })),
    enemies: input.enemyNames,
    preference: input.preference ?? ''
  };
  return JSON.stringify(compact);
}

function extractTextFromMessage(message: unknown): string {
  if (!isObject(message) || (message as { type?: string }).type !== 'assistant') {
    return '';
  }
  const apiMessage = (message as { message?: unknown }).message;
  if (!isObject(apiMessage)) {
    return '';
  }
  const content = (apiMessage as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return '';
  }
  let text = '';
  for (const block of content) {
    if (isObject(block) && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: string }).text;
      if (typeof t === 'string') {
        text += t;
      }
    }
  }
  return text;
}

function isResultMessage(message: unknown): boolean {
  return isObject(message) && (message as { type?: string }).type === 'result';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractJsonPayload(raw: string): ParsedLlmPayload | undefined {
  const candidates: string[] = [raw];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    candidates.push(fence[1]);
  }
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) {
    candidates.push(raw.slice(open, close + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ParsedLlmPayload;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function normalizeLlmResult(
  parsed: ParsedLlmPayload,
  characters: CharacterProfile[]
): RecommendationResult {
  const byId = new Map(characters.map((character) => [character.id, character]));
  const teams: TeamRecommendation[] = [];

  for (const [index, team] of (parsed.teams ?? []).entries()) {
    const ids = Array.isArray(team.characterIds)
      ? team.characterIds.filter((value): value is number => Number.isInteger(value))
      : [];
    const picks = ids
      .map((id) => byId.get(id))
      .filter((value): value is CharacterProfile => Boolean(value))
      .slice(0, 4);
    if (picks.length < 4) {
      continue;
    }
    teams.push({
      name: team.name?.trim() || `推荐配队 ${index + 1}`,
      characters: picks.map((c) => ({ id: c.id, name: c.name, element: c.element })),
      reasoning: team.reasoning?.trim() || '基于角色面板与敌人环境综合选择。',
      rotationTip: team.rotationTip?.trim() || '先挂元素再主 C 输出，注意循环与生存。'
    });
  }

  return {
    source: 'llm',
    summary: parsed.summary?.trim() || '已结合角色面板和敌人环境生成推荐队伍。',
    teams: teams.slice(0, 3)
  };
}

function scoreCharacter(character: CharacterProfile): number {
  const { stats } = character;
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

export function buildFallback(
  characters: CharacterProfile[],
  enemyNames: string[]
): RecommendationResult {
  const sorted = characters.slice().sort((a, b) => scoreCharacter(b) - scoreCharacter(a));
  const core = sorted.slice(0, Math.min(4, sorted.length));

  return {
    source: 'fallback',
    summary:
      enemyNames.length > 0
        ? `已根据角色面板与敌人信息（${enemyNames.join('、')}）生成基础推荐。`
        : '未提供敌人信息，已根据角色面板综合强度生成基础推荐。',
    teams: [
      {
        name: '基础稳妥队',
        characters: core.map((c) => ({ id: c.id, name: c.name, element: c.element })),
        reasoning: '本地启发式：按面板综合强度选最强 4 名角色，确保输出与生存上限。',
        rotationTip: '先副 C/辅助挂元素，主 C 收伤；注意充能闭环。'
      }
    ]
  };
}

export function buildDiffSummary(
  left: RecommendationResult,
  right: RecommendationResult
): string {
  const leftNames = new Set(
    left.teams.flatMap((team) => team.characters.map((c) => c.name))
  );
  const rightNames = new Set(
    right.teams.flatMap((team) => team.characters.map((c) => c.name))
  );

  const onlyLeft = Array.from(leftNames).filter((name) => !rightNames.has(name));
  const onlyRight = Array.from(rightNames).filter((name) => !leftNames.has(name));

  if (onlyLeft.length === 0 && onlyRight.length === 0) {
    return '两个环境推荐核心角色基本一致，主要差异在站位与循环顺序。';
  }

  const parts: string[] = [];
  if (onlyLeft.length > 0) {
    parts.push(`左环境独有：${onlyLeft.join('、')}`);
  }
  if (onlyRight.length > 0) {
    parts.push(`右环境独有：${onlyRight.join('、')}`);
  }
  return parts.join('；') + '。';
}

function joinUrl(base: string, p: string): string {
  return `${base.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
