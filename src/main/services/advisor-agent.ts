import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { app } from 'electron';
import type {
  AdvisorCompareRequest,
  AdvisorCompareResult,
  AdvisorEvent,
  AdvisorRequest,
  AdvisorSide,
  CharacterProfile,
  LlmHealthReport,
  RecommendationResult,
  TeamRecommendation
} from '../../shared/domain.js';
import { validateCustomHeaders } from '../../shared/custom-headers.js';
import type { ConfigService } from './config-service.js';
import type { HistoryStore } from './history-store.js';
import type { ProfileStore } from './profile-store.js';
import { AgentSdkAdapter } from './agent-sdk-adapter.js';
import { serializeAdvisorProfile } from './advisor-profile-serializer.js';
import { createAdvisorOrchestrator } from './advisor-orchestrator.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECOMMEND_TIMEOUT_MS = 180_000;
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
  private readonly sdk = new AgentSdkAdapter();
  private readonly orchestrator = createAdvisorOrchestrator(this.sdk);

  constructor(
    private readonly config: ConfigService,
    private readonly profiles: ProfileStore,
    private readonly history: HistoryStore
  ) {}

  async testConnection(): Promise<LlmHealthReport> {
    const apiKey = this.config.getApiKey();
    const baseUrl = this.config.getBaseUrl();
    const model = this.config.getModel();
    let customHeaders: Record<string, string> | undefined;

    if (!apiKey) {
      return {
        ok: false,
        latencyMs: 0,
        model,
        baseUrl,
        message: '智能服务尚未配置'
      };
    }

    const start = Date.now();
    try {
      customHeaders = validateCustomHeaders(this.config.getCustomHeaders());
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
      const message = ok ? undefined : `Provider returned HTTP ${statusCode}`;
      await body.dump();
      return { ok, latencyMs, model, baseUrl, httpStatus: statusCode, message };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        model,
        baseUrl,
        message: `Provider request failed (${error instanceof Error ? error.name : 'Error'})`
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
        stage: 'fallback-characters'
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
        stage: 'fallback-key'
      });
      const fallback = buildFallback(profile.characters, input.enemyNames);
      this.persistHistory(input, fallback);
      emit({ type: 'final', correlationId, side, result: fallback });
      return fallback;
    }

    this.currentAbort?.abort();
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
        stage: 'analyzing'
      });

      const result = await this.orchestrator.run({
        serializedProfile: serializeAdvisorProfile(profile, input),
        characters: profile.characters,
        correlationId,
        side,
        emit,
        onUsage: (inputTokens, outputTokens, estimatedCostUsd) => {
          this.config.recordUsage(inputTokens, outputTokens, estimatedCostUsd);
        },
        sdkOptions: {
          apiKey,
          baseUrl: this.config.getBaseUrl(),
          model: this.config.getModel(),
          clientVersion: app.getVersion(),
          customHeaders: this.config.getCustomHeaders(),
          systemPrompt: '',
          cwd: app.getPath('userData'),
          abortController: abort,
          maxTurns: 1
        }
      });
      this.persistHistory(input, result);
      emit({ type: 'final', correlationId, side, result });
      return result;
    } catch (error) {
      if (abort.signal.aborted) {
        emit({ type: 'cancelled', correlationId, side });
        throw error;
      }
      emit({
        type: 'progress',
        correlationId,
        side,
        stage: 'fallback-error'
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
    if (ids.length !== 4 || new Set(ids).size !== 4) continue;
    const picks = ids
      .map((id) => byId.get(id))
      .filter((value): value is CharacterProfile => Boolean(value));
    if (picks.length !== 4) continue;
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
  const stats = character.build?.stats;
  return (
    (character.level ?? 1) * 3 +
    character.rarity * 30 +
    (stats?.atk ?? 0) / 14 +
    (stats?.hp ?? 0) / 220 +
    (stats?.critRate ?? 0) * 4 +
    (stats?.critDmg ?? 0) * 2 +
    (stats?.energyRecharge ?? 0) +
    (stats?.elementalMastery ?? 0) / 3
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
        ? `已根据已知角色数据与敌人信息（${enemyNames.join('、')}）生成基础推荐；缺失面板不会按 0 处理。`
        : '未提供敌人信息，已根据已知角色数据生成基础推荐；缺失面板不会按 0 处理。',
    teams: [
      {
        name: '基础稳妥队',
        characters: core.map((c) => ({ id: c.id, name: c.name, element: c.element })),
        reasoning: '本地规则：以等级、稀有度和已知面板做可解释排序；未知字段只降低建议把握。',
        rotationTip: '先副 C/辅助挂元素，主 C 输出；充能数据未知时请以实战循环为准。'
      }
    ]
  };
}

export function buildDiffSummary(left: RecommendationResult, right: RecommendationResult): string {
  const leftNames = new Set(left.teams.flatMap((team) => team.characters.map((c) => c.name)));
  const rightNames = new Set(right.teams.flatMap((team) => team.characters.map((c) => c.name)));

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
