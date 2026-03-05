import JSZip from 'jszip';
import { useEffect, useMemo, useState } from 'react';

type CharacterStats = {
  level: number;
  hp: number;
  atk: number;
  def: number;
  critRate: number;
  critDmg: number;
  energyRecharge: number;
  elementalMastery: number;
};

type CharacterProfile = {
  id: number;
  name: string;
  element: string;
  rarity: number;
  imageUrl: string;
  stats: CharacterStats;
};

type CachedData = {
  uid: string;
  nickname?: string;
  level?: number;
  source: 'miyoushe+enka' | 'miyoushe';
  updatedAt: string;
  profiles: CharacterProfile[];
};

type RecommendationTeam = {
  name: string;
  characters: Array<{ id: number; name: string; element: string }>;
  reasoning: string;
  rotationTip: string;
};

type RecommendationData = {
  source: 'llm' | 'fallback';
  summary: string;
  teams: RecommendationTeam[];
};

type RecommendationHistoryItem = {
  id: string;
  uid?: string;
  createdAt: string;
  enemyNames: string[];
  preference?: string;
  source: 'llm' | 'fallback';
  summary: string;
  teams: RecommendationTeam[];
};

type RecommendationCompareData = {
  left: RecommendationData;
  right: RecommendationData;
  diffSummary: string;
};

type TeamDetailView = {
  title: string;
  summary?: string;
  team: RecommendationTeam;
};

type HistoryQueryResult = {
  items: RecommendationHistoryItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

type HistoryFilters = {
  source: 'all' | 'llm' | 'fallback';
  enemyKeyword: string;
  fromDate: string;
  toDate: string;
  limit: number;
};

const LOCAL_CACHE_KEY = 'genshin-ai.phase2.cache.v1';

function readCacheFromLocalStorage(): CachedData | null {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as CachedData;
  } catch {
    return null;
  }
}

function App() {
  const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';
  const [cookie, setCookie] = useState('');
  const [status, setStatus] = useState('等待导入');
  const [cached, setCached] = useState<CachedData | null>(() => readCacheFromLocalStorage());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [enemyInput, setEnemyInput] = useState('abyss-mage, ruin-guard');
  const [preference, setPreference] = useState('优先考虑操作简单且容错高');
  const [recommendation, setRecommendation] = useState<RecommendationData | null>(null);
  const [isRecommending, setIsRecommending] = useState(false);
  const [historyItems, setHistoryItems] = useState<RecommendationHistoryItem[]>([]);
  const [historyQuery, setHistoryQuery] = useState<HistoryQueryResult>({
    items: [],
    total: 0,
    offset: 0,
    limit: 20,
    hasMore: false
  });
  const [leftEnemyInput, setLeftEnemyInput] = useState('abyss-mage');
  const [rightEnemyInput, setRightEnemyInput] = useState('ruin-guard');
  const [compareResult, setCompareResult] = useState<RecommendationCompareData | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const [teamDetailView, setTeamDetailView] = useState<TeamDetailView | null>(null);
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>({
    source: 'all',
    enemyKeyword: '',
    fromDate: '',
    toDate: '',
    limit: 20
  });

  const historyStats = useMemo(() => {
    const total = historyQuery.total;
    const llmCount = historyItems.filter((item) => item.source === 'llm').length;
    const fallbackCount = historyItems.filter((item) => item.source === 'fallback').length;

    return {
      total,
      llmCount,
      fallbackCount,
      llmRatio: total > 0 ? Math.round((llmCount / total) * 100) : 0,
      fallbackRatio: total > 0 ? Math.round((fallbackCount / total) * 100) : 0
    };
  }, [historyItems, historyQuery.total]);

  const selectedProfile = useMemo(() => {
    if (!cached || cached.profiles.length === 0) {
      return undefined;
    }

    if (selectedId !== null) {
      return cached.profiles.find((profile) => profile.id === selectedId);
    }

    return cached.profiles[0];
  }, [cached, selectedId]);

  const compareLeftTeam = compareResult?.left.teams[0];
  const compareRightTeam = compareResult?.right.teams[0];

  useEffect(() => {
    if (!cached) {
      return;
    }
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cached));
  }, [cached]);

  useEffect(() => {
    if (!selectedProfile && cached?.profiles?.[0]) {
      setSelectedId(cached.profiles[0].id);
    }
  }, [cached, selectedProfile]);

  async function validateCookie(): Promise<void> {
    setStatus('校验 Cookie 中...');
    const response = await fetch(`${apiBase}/api/mys/validate-cookie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie })
    });

    const body = (await response.json()) as { ok: boolean; roleCount?: number; message?: string };
    if (!response.ok || !body.ok) {
      setStatus(`Cookie 校验失败：${body.message ?? '请检查 Cookie'}`);
      return;
    }

    setStatus(`Cookie 校验通过，检测到 ${body.roleCount ?? 0} 个绑定角色`);
  }

  async function importProfiles(): Promise<void> {
    setStatus('导入中：米游社角色 → Enka 面板...');
    const response = await fetch(`${apiBase}/api/mys/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie })
    });

    const body = (await response.json()) as { ok: boolean; message?: string; data?: CachedData };
    if (!response.ok || !body.ok || !body.data) {
      setStatus(`导入失败：${body.message ?? '未知错误'}`);
      return;
    }

    setCached(body.data);
    setSelectedId(body.data.profiles[0]?.id ?? null);
    setStatus(`导入完成：UID ${body.data.uid}，角色 ${body.data.profiles.length} 个`);
  }

  async function loadFromApiCache(): Promise<void> {
    if (!cached?.uid) {
      setStatus('没有本地 UID，先导入一次');
      return;
    }

    const response = await fetch(`${apiBase}/api/profile/${cached.uid}`);
    const body = (await response.json()) as { ok: boolean; message?: string; data?: CachedData };

    if (!response.ok || !body.ok || !body.data) {
      setStatus(`读取服务端缓存失败：${body.message ?? '未知错误'}`);
      return;
    }

    setCached(body.data);
    setStatus(`已从服务端缓存恢复：${body.data.uid}`);
  }

  async function pullEnemyPreset(): Promise<void> {
    const response = await fetch(`${apiBase}/api/enemy/current`);
    const body = (await response.json()) as { ok: boolean; data?: { enemies?: string[] } };

    if (!response.ok || !body.ok || !body.data?.enemies) {
      setStatus('读取当期敌人失败，继续使用手动输入。');
      return;
    }

    setEnemyInput(body.data.enemies.slice(0, 12).join(', '));
    setStatus('已加载社区敌人数据，请检查并调整。');
  }

  function updateSelectedProfileStat(field: keyof CharacterStats, value: number): void {
    if (!cached || !selectedProfile) {
      return;
    }

    const updatedProfiles = cached.profiles.map((profile) => {
      if (profile.id !== selectedProfile.id) {
        return profile;
      }

      return {
        ...profile,
        stats: {
          ...profile.stats,
          [field]: value
        }
      };
    });

    setCached({
      ...cached,
      updatedAt: new Date().toISOString(),
      profiles: updatedProfiles
    });
  }

  async function generateRecommendationRequest(): Promise<void> {
    if (!cached || cached.profiles.length < 4) {
      setStatus('至少需要 4 个角色后才能推荐配队');
      return;
    }

    setIsRecommending(true);
    setStatus('AI 正在分析角色面板和敌人信息...');

    const enemyNames = enemyInput
      .split(/[\n,，]/g)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    const response = await fetch(`${apiBase}/api/ai/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: cached.uid,
        characters: cached.profiles,
        enemyNames,
        preference
      })
    });

    const body = (await response.json()) as { ok: boolean; message?: string; data?: RecommendationData };
    if (!response.ok || !body.ok || !body.data) {
      setStatus(`推荐失败：${body.message ?? '未知错误'}`);
      setIsRecommending(false);
      return;
    }

    setRecommendation(body.data);
    setStatus(`推荐完成，来源：${body.data.source === 'llm' ? 'LLM' : 'Fallback'}`);
    setIsRecommending(false);
    await loadRecommendationHistory(undefined, 0);
  }

  async function loadRecommendationHistory(filters?: Partial<HistoryFilters>, offset?: number): Promise<void> {
    const nextFilters: HistoryFilters = {
      ...historyFilters,
      ...filters
    };
    const nextOffset = offset && offset > 0 ? offset : 0;

    const uid = cached?.uid;
    const params = new URLSearchParams();
    params.set('limit', String(nextFilters.limit));
    params.set('offset', String(nextOffset));
    if (uid) {
      params.set('uid', uid);
    }
    if (nextFilters.source !== 'all') {
      params.set('source', nextFilters.source);
    }
    if (nextFilters.enemyKeyword.trim()) {
      params.set('enemyKeyword', nextFilters.enemyKeyword.trim());
    }
    if (nextFilters.fromDate) {
      params.set('fromDate', nextFilters.fromDate);
    }
    if (nextFilters.toDate) {
      params.set('toDate', nextFilters.toDate);
    }

    const response = await fetch(`${apiBase}/api/recommend/history?${params.toString()}`);
    const body = (await response.json()) as { ok: boolean; data?: HistoryQueryResult };

    if (!response.ok || !body.ok || !body.data) {
      setStatus('读取推荐历史失败');
      return;
    }

    setHistoryItems(body.data.items);
    setHistoryQuery(body.data);
    setHistoryFilters(nextFilters);
  }

  function buildHistoryCsvContent(): string {
    const escapeCsv = (value: string): string => {
      const escaped = value.replace(/"/g, '""');
      return `"${escaped}"`;
    };

    const header = ['id', 'createdAt', 'uid', 'source', 'enemyNames', 'summary'];
    const rows = historyItems.map((item) => [
      item.id,
      item.createdAt,
      item.uid ?? '',
      item.source,
      item.enemyNames.join(' | '),
      item.summary
    ]);

    return [header, ...rows]
      .map((row) => row.map((cell) => escapeCsv(String(cell))).join(','))
      .join('\n');
  }

  function exportHistoryAsJson(): void {
    if (historyItems.length === 0) {
      setStatus('没有可导出的推荐历史');
      return;
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      filters: historyFilters,
      items: historyItems
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `recommend-history-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('推荐历史已导出为 JSON 文件');
  }

  function exportHistoryAsCsv(): void {
    if (historyItems.length === 0) {
      setStatus('没有可导出的推荐历史');
      return;
    }

    const csv = buildHistoryCsvContent();

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `recommend-history-${Date.now()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('推荐历史已导出为 CSV 文件');
  }

  async function exportHistoryAsZip(): Promise<void> {
    if (historyItems.length === 0) {
      setStatus('没有可导出的推荐历史');
      return;
    }

    const jsonPayload = {
      exportedAt: new Date().toISOString(),
      filters: historyFilters,
      items: historyItems
    };

    const zip = new JSZip();
    zip.file('recommend-history.json', JSON.stringify(jsonPayload, null, 2));
    zip.file('recommend-history.csv', buildHistoryCsvContent());

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `recommend-history-${Date.now()}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('推荐历史已导出为 ZIP（JSON + CSV）');
  }

  function openTeamDetail(detail: TeamDetailView): void {
    setTeamDetailView(detail);
  }

  async function deleteHistoryItem(id: string): Promise<void> {
    const response = await fetch(`${apiBase}/api/recommend/history/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    const body = (await response.json()) as { ok: boolean; message?: string };

    if (!response.ok || !body.ok) {
      setStatus(`删除历史失败：${body.message ?? '未知错误'}`);
      return;
    }

    const currentOffset = historyQuery.offset;
    await loadRecommendationHistory(undefined, currentOffset);
    setStatus('已删除一条历史记录');
  }

  async function clearFilteredHistory(): Promise<void> {
    const uid = cached?.uid;
    const params = new URLSearchParams();
    if (uid) {
      params.set('uid', uid);
    }
    if (historyFilters.source !== 'all') {
      params.set('source', historyFilters.source);
    }
    if (historyFilters.enemyKeyword.trim()) {
      params.set('enemyKeyword', historyFilters.enemyKeyword.trim());
    }

    const response = await fetch(`${apiBase}/api/recommend/history?${params.toString()}`, {
      method: 'DELETE'
    });
    const body = (await response.json()) as { ok: boolean; removed?: number; message?: string };

    if (!response.ok || !body.ok) {
      setStatus(`批量删除历史失败：${body.message ?? '未知错误'}`);
      return;
    }

    await loadRecommendationHistory(undefined, 0);
    setStatus(`已删除 ${body.removed ?? 0} 条历史记录`);
  }

  async function goToPrevHistoryPage(): Promise<void> {
    const nextOffset = Math.max(0, historyQuery.offset - historyQuery.limit);
    await loadRecommendationHistory(undefined, nextOffset);
  }

  async function goToNextHistoryPage(): Promise<void> {
    if (!historyQuery.hasMore) {
      return;
    }

    const nextOffset = historyQuery.offset + historyQuery.limit;
    await loadRecommendationHistory(undefined, nextOffset);
  }

  async function compareRecommendationRequest(): Promise<void> {
    if (!cached || cached.profiles.length < 4) {
      setStatus('至少需要 4 个角色后才能进行对比');
      return;
    }

    setIsComparing(true);
    const parseEnemyInput = (value: string): string[] =>
      value
        .split(/[\n,，]/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

    const response = await fetch(`${apiBase}/api/recommend/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: cached.uid,
        characters: cached.profiles,
        leftEnemyNames: parseEnemyInput(leftEnemyInput),
        rightEnemyNames: parseEnemyInput(rightEnemyInput),
        leftPreference: preference,
        rightPreference: preference
      })
    });

    const body = (await response.json()) as { ok: boolean; message?: string; data?: RecommendationCompareData };
    if (!response.ok || !body.ok || !body.data) {
      setStatus(`对比失败：${body.message ?? '未知错误'}`);
      setIsComparing(false);
      return;
    }

    setCompareResult(body.data);
    setStatus('已生成双环境对比推荐');
    setIsComparing(false);
    await loadRecommendationHistory(undefined, 0);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>原神 AI 配队助手</h1>
        <p>Phase 7：历史检索优化、推荐详情页与 ZIP 导出</p>
      </header>

      <main className="layout-grid">
        <section className="panel panel-left">
          <h2>角色展示</h2>
          <div className="character-grid">
            {(cached?.profiles ?? []).map((character) => (
              <article
                key={`${character.id}-${character.name}`}
                className={`character-card ${selectedProfile?.id === character.id ? 'character-card-active' : ''}`}
                onClick={() => setSelectedId(character.id)}
              >
                <img src={character.imageUrl} alt={character.name} loading="lazy" />
                <div className="character-body">
                  <h3>{character.name}</h3>
                  <p>
                    元素：{character.element} · 等级 {character.stats.level}
                  </p>
                  <dl>
                    <div>
                      <dt>攻击</dt>
                      <dd>{character.stats.atk}</dd>
                    </div>
                    <div>
                      <dt>生命</dt>
                      <dd>{character.stats.hp}</dd>
                    </div>
                    <div>
                      <dt>暴击率</dt>
                      <dd>{character.stats.critRate}%</dd>
                    </div>
                    <div>
                      <dt>暴击伤害</dt>
                      <dd>{character.stats.critDmg}%</dd>
                    </div>
                  </dl>
                </div>
              </article>
            ))}
          </div>
          {!cached?.profiles?.length && <p className="empty-text">暂无角色数据，请先校验 Cookie 并导入。</p>}
        </section>

        <section className="panel panel-right">
          <h2>导入、微调与 AI 推荐</h2>

          <label htmlFor="cookie-input" className="field-label">
            米游社 Cookie
          </label>
          <textarea
            id="cookie-input"
            className="cookie-input"
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            placeholder="粘贴完整 Cookie，仅本地使用"
          />

          <div className="button-row">
            <button type="button" onClick={() => void validateCookie()} disabled={!cookie.trim()}>
              校验 Cookie
            </button>
            <button type="button" onClick={() => void importProfiles()} disabled={!cookie.trim()}>
              导入角色
            </button>
            <button type="button" onClick={() => void loadFromApiCache()} disabled={!cached?.uid}>
              读取服务端缓存
            </button>
            <button type="button" onClick={() => void pullEnemyPreset()}>
              加载当期敌人
            </button>
            <button type="button" onClick={() => void loadRecommendationHistory()}>
              读取推荐历史
            </button>
          </div>

          <p className="status-text">状态：{status}</p>

          {cached && (
            <div className="cache-meta">
              <p>UID：{cached.uid}</p>
              <p>来源：{cached.source}</p>
              <p>更新时间：{new Date(cached.updatedAt).toLocaleString()}</p>
            </div>
          )}

          {selectedProfile && (
            <div className="editor-grid">
              <h3>{selectedProfile.name} 面板微调</h3>
              <label>
                等级
                <input
                  type="number"
                  value={selectedProfile.stats.level}
                  onChange={(event) => updateSelectedProfileStat('level', Number(event.target.value || 1))}
                />
              </label>
              <label>
                攻击
                <input
                  type="number"
                  value={selectedProfile.stats.atk}
                  onChange={(event) => updateSelectedProfileStat('atk', Number(event.target.value || 0))}
                />
              </label>
              <label>
                生命
                <input
                  type="number"
                  value={selectedProfile.stats.hp}
                  onChange={(event) => updateSelectedProfileStat('hp', Number(event.target.value || 0))}
                />
              </label>
              <label>
                防御
                <input
                  type="number"
                  value={selectedProfile.stats.def}
                  onChange={(event) => updateSelectedProfileStat('def', Number(event.target.value || 0))}
                />
              </label>
              <label>
                暴击率
                <input
                  type="number"
                  step="0.1"
                  value={selectedProfile.stats.critRate}
                  onChange={(event) => updateSelectedProfileStat('critRate', Number(event.target.value || 0))}
                />
              </label>
              <label>
                暴击伤害
                <input
                  type="number"
                  step="0.1"
                  value={selectedProfile.stats.critDmg}
                  onChange={(event) => updateSelectedProfileStat('critDmg', Number(event.target.value || 0))}
                />
              </label>
              <label>
                充能效率
                <input
                  type="number"
                  step="0.1"
                  value={selectedProfile.stats.energyRecharge}
                  onChange={(event) => updateSelectedProfileStat('energyRecharge', Number(event.target.value || 0))}
                />
              </label>
              <label>
                元素精通
                <input
                  type="number"
                  value={selectedProfile.stats.elementalMastery}
                  onChange={(event) => updateSelectedProfileStat('elementalMastery', Number(event.target.value || 0))}
                />
              </label>
            </div>
          )}

          <div className="recommendation-panel">
            <h3>配队推荐输入</h3>
            <label>
              当期敌人（逗号或换行分隔）
              <textarea
                className="cookie-input"
                value={enemyInput}
                onChange={(event) => setEnemyInput(event.target.value)}
              />
            </label>
            <label>
              偏好
              <input
                type="text"
                value={preference}
                onChange={(event) => setPreference(event.target.value)}
              />
            </label>
            <button type="button" onClick={() => generateRecommendationRequest()} disabled={isRecommending || !cached}>
              {isRecommending ? '推荐中...' : '生成 AI 配队推荐'}
            </button>
          </div>

          <div className="recommendation-panel">
              <h3>双环境对比推荐（Phase 7）</h3>
            <label>
              环境 A 敌人
              <textarea
                className="cookie-input"
                value={leftEnemyInput}
                onChange={(event) => setLeftEnemyInput(event.target.value)}
              />
            </label>
            <label>
              环境 B 敌人
              <textarea
                className="cookie-input"
                value={rightEnemyInput}
                onChange={(event) => setRightEnemyInput(event.target.value)}
              />
            </label>
            <button type="button" onClick={() => void compareRecommendationRequest()} disabled={isComparing || !cached}>
              {isComparing ? '对比中...' : '生成对比推荐'}
            </button>
          </div>

          {recommendation && (
            <div className="recommendation-result">
              <h3>推荐结果（{recommendation.source === 'llm' ? 'LLM' : 'Fallback'}）</h3>
              <p>{recommendation.summary}</p>
              {recommendation.teams.map((team) => (
                <article key={team.name} className="team-card">
                  <h4>{team.name}</h4>
                  <p>角色：{team.characters.map((character) => `${character.name}(${character.element})`).join(' · ')}</p>
                  <p>理由：{team.reasoning}</p>
                  <p>手法：{team.rotationTip}</p>
                  <button
                    type="button"
                    onClick={() =>
                      openTeamDetail({
                        title: team.name,
                        summary: recommendation.summary,
                        team
                      })
                    }
                  >
                    查看详情页
                  </button>
                </article>
              ))}
            </div>
          )}

          {compareResult && (
            <div className="recommendation-result">
              <h3>对比结论</h3>
              <p>{compareResult.diffSummary}</p>
              <article className="team-card">
                <h4>环境 A：{compareResult.left.summary}</h4>
                <p>{compareLeftTeam?.name ?? '无'}</p>
                {compareLeftTeam && (
                  <button
                    type="button"
                    onClick={() => {
                      const team = compareResult.left.teams[0];
                      if (!team) {
                        return;
                      }

                      openTeamDetail({
                        title: `环境 A - ${team.name}`,
                        summary: compareResult.left.summary,
                        team
                      });
                    }}
                  >
                    查看详情页
                  </button>
                )}
              </article>
              <article className="team-card">
                <h4>环境 B：{compareResult.right.summary}</h4>
                <p>{compareRightTeam?.name ?? '无'}</p>
                {compareRightTeam && (
                  <button
                    type="button"
                    onClick={() => {
                      const team = compareResult.right.teams[0];
                      if (!team) {
                        return;
                      }

                      openTeamDetail({
                        title: `环境 B - ${team.name}`,
                        summary: compareResult.right.summary,
                        team
                      });
                    }}
                  >
                    查看详情页
                  </button>
                )}
              </article>
            </div>
          )}

          <div className="recommendation-result">
            <h3>推荐历史</h3>
            <div className="history-filter-grid">
              <label>
                来源
                <select
                  value={historyFilters.source}
                  onChange={(event) =>
                    setHistoryFilters((prev) => ({
                      ...prev,
                      source: event.target.value as HistoryFilters['source']
                    }))
                  }
                >
                  <option value="all">全部</option>
                  <option value="llm">LLM</option>
                  <option value="fallback">Fallback</option>
                </select>
              </label>
              <label>
                敌人关键词
                <input
                  type="text"
                  value={historyFilters.enemyKeyword}
                  onChange={(event) =>
                    setHistoryFilters((prev) => ({
                      ...prev,
                      enemyKeyword: event.target.value
                    }))
                  }
                />
              </label>
              <label>
                起始日期
                <input
                  type="date"
                  value={historyFilters.fromDate}
                  onChange={(event) =>
                    setHistoryFilters((prev) => ({
                      ...prev,
                      fromDate: event.target.value
                    }))
                  }
                />
              </label>
              <label>
                结束日期
                <input
                  type="date"
                  value={historyFilters.toDate}
                  onChange={(event) =>
                    setHistoryFilters((prev) => ({
                      ...prev,
                      toDate: event.target.value
                    }))
                  }
                />
              </label>
              <label>
                条数上限
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={historyFilters.limit}
                  onChange={(event) =>
                    setHistoryFilters((prev) => ({
                      ...prev,
                      limit: Number(event.target.value || 20)
                    }))
                  }
                />
              </label>
            </div>

            <div className="button-row history-actions">
              <button
                type="button"
                onClick={() => {
                  void loadRecommendationHistory(undefined, 0);
                }}
              >
                应用筛选
              </button>
              <button type="button" onClick={exportHistoryAsJson}>
                导出 JSON
              </button>
              <button type="button" onClick={exportHistoryAsCsv}>
                导出 CSV
              </button>
              <button type="button" onClick={() => void exportHistoryAsZip()}>
                导出 ZIP
              </button>
              <button type="button" onClick={() => void clearFilteredHistory()}>
                删除筛选结果
              </button>
            </div>

            <div className="history-stats">
              <p>总记录：{historyStats.total}</p>
              <p>
                当前页：
                {historyQuery.total === 0
                  ? '0-0'
                  : `${historyQuery.offset + 1}-${Math.min(historyQuery.offset + historyQuery.limit, historyQuery.total)}`}
              </p>
              <div className="ratio-row">
                <span>LLM：{historyStats.llmCount} ({historyStats.llmRatio}%)</span>
                <div className="ratio-track">
                  <div className="ratio-fill ratio-llm" style={{ width: `${historyStats.llmRatio}%` }} />
                </div>
              </div>
              <div className="ratio-row">
                <span>Fallback：{historyStats.fallbackCount} ({historyStats.fallbackRatio}%)</span>
                <div className="ratio-track">
                  <div className="ratio-fill ratio-fallback" style={{ width: `${historyStats.fallbackRatio}%` }} />
                </div>
              </div>
            </div>

            <div className="button-row history-actions">
              <button type="button" onClick={() => void goToPrevHistoryPage()} disabled={historyQuery.offset <= 0}>
                上一页
              </button>
              <button type="button" onClick={() => void goToNextHistoryPage()} disabled={!historyQuery.hasMore}>
                下一页
              </button>
            </div>

            {historyItems.length === 0 && <p>暂无历史记录</p>}
            {historyItems.map((item) => {
              const firstTeam = item.teams[0];

              return (
                <article key={item.id} className="team-card">
                  <h4>{new Date(item.createdAt).toLocaleString()} · {item.source.toUpperCase()}</h4>
                  <p>敌人：{item.enemyNames.join('、') || '未指定'}</p>
                  <p>{item.summary}</p>
                  {firstTeam && (
                    <button
                      type="button"
                      onClick={() => {
                        const team = item.teams[0];
                        if (!team) {
                          return;
                        }

                        openTeamDetail({
                          title: `${item.source.toUpperCase()} 历史 - ${team.name}`,
                          summary: item.summary,
                          team
                        });
                      }}
                    >
                      查看详情页
                    </button>
                  )}
                  <button type="button" className="danger-button" onClick={() => void deleteHistoryItem(item.id)}>
                    删除该条
                  </button>
                </article>
              );
            })}
          </div>

          {teamDetailView && (
            <div className="recommendation-result detail-view">
              <h3>推荐结果详情页</h3>
              <h4>{teamDetailView.title}</h4>
              <p>{teamDetailView.summary ?? '无摘要'}</p>
              <p>
                角色：{teamDetailView.team.characters.map((character) => `${character.name}(${character.element})`).join(' · ')}
              </p>
              <p>理由：{teamDetailView.team.reasoning}</p>
              <p>手法：{teamDetailView.team.rotationTip}</p>
              <button type="button" onClick={() => setTeamDetailView(null)}>
                关闭详情页
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
