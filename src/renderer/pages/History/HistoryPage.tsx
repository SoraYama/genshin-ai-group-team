import { useCallback, useEffect, useState } from 'react';
import { api } from '../../ipc';
import type {
  HistoryQueryResult,
  ProfileStateView,
  RecommendationHistoryEntry
} from '../../../shared/domain';

interface HistoryPageProps {
  state: ProfileStateView;
}

type SourceFilter = 'all' | 'llm' | 'fallback';

interface Filters {
  scope: 'all' | 'active';
  source: SourceFilter;
  enemyKeyword: string;
  fromDate: string;
  toDate: string;
  limit: number;
}

const DEFAULT_FILTERS: Filters = {
  scope: 'active',
  source: 'all',
  enemyKeyword: '',
  fromDate: '',
  toDate: '',
  limit: 20
};

export function HistoryPage({ state }: HistoryPageProps) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [query, setQuery] = useState<HistoryQueryResult>({
    items: [],
    total: 0,
    offset: 0,
    limit: 20,
    hasMore: false
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (next: Filters, offset: number) => {
      setError(null);
      setLoading(true);
      try {
        const result = await api.history.list({
          uid: next.scope === 'active' ? state.activeUid : undefined,
          source: next.source === 'all' ? undefined : next.source,
          enemyKeyword: next.enemyKeyword.trim() || undefined,
          fromDate: next.fromDate || undefined,
          toDate: next.toDate || undefined,
          offset,
          limit: next.limit
        });
        setQuery(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [state.activeUid]
  );

  useEffect(() => {
    void load(filters, 0);
  }, [load, filters.scope, state.activeUid]);

  async function applyFilters() {
    await load(filters, 0);
  }

  async function gotoPrev() {
    if (query.offset === 0) return;
    await load(filters, Math.max(0, query.offset - query.limit));
  }

  async function gotoNext() {
    if (!query.hasMore) return;
    await load(filters, query.offset + query.limit);
  }

  async function deleteEntry(id: string) {
    await api.history.delete({ id });
    if (expandedId === id) {
      setExpandedId(null);
    }
    await load(filters, query.offset);
  }

  async function clearMatching() {
    if (filters.scope !== 'active' && filters.source === 'all' && !filters.enemyKeyword.trim()) {
      setError('批量清除至少要指定当前 UID、来源或关键词中的一个');
      return;
    }
    try {
      const result = await api.history.clear({
        uid: filters.scope === 'active' ? state.activeUid : undefined,
        source: filters.source === 'all' ? undefined : filters.source,
        enemyKeyword: filters.enemyKeyword.trim() || undefined
      });
      await load(filters, 0);
      setError(result.removed === 0 ? '没有匹配的历史记录' : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量删除失败');
    }
  }

  return (
    <section className="history-page">
      <header className="history-header">
        <h2>推荐历史</h2>
        <p className="hint">最多保留最近 200 条；删除后无法恢复。</p>
      </header>

      <div className="history-filters">
        <label>
          范围
          <select
            value={filters.scope}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                scope: event.target.value as Filters['scope']
              }))
            }
          >
            <option value="active">当前 UID</option>
            <option value="all">全部 UID</option>
          </select>
        </label>
        <label>
          来源
          <select
            value={filters.source}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                source: event.target.value as SourceFilter
              }))
            }
          >
            <option value="all">全部</option>
            <option value="llm">LLM</option>
            <option value="fallback">本地启发式</option>
          </select>
        </label>
        <label>
          敌人关键词
          <input
            type="text"
            value={filters.enemyKeyword}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, enemyKeyword: event.target.value }))
            }
          />
        </label>
        <label>
          起始日期
          <input
            type="date"
            value={filters.fromDate}
            onChange={(event) => setFilters((prev) => ({ ...prev, fromDate: event.target.value }))}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            value={filters.toDate}
            onChange={(event) => setFilters((prev) => ({ ...prev, toDate: event.target.value }))}
          />
        </label>
        <label>
          每页
          <input
            type="number"
            min={1}
            max={100}
            value={filters.limit}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, limit: Math.max(1, Number(event.target.value) || 20) }))
            }
          />
        </label>
      </div>

      <div className="button-row">
        <button type="button" onClick={() => void applyFilters()} disabled={loading}>
          {loading ? '加载中…' : '应用筛选'}
        </button>
        <button type="button" className="danger" onClick={() => void clearMatching()}>
          删除匹配项
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="history-stats">
        <span>共 {query.total} 条</span>
        <span>
          当前页：
          {query.total === 0
            ? '0-0'
            : `${query.offset + 1}-${Math.min(query.offset + query.limit, query.total)}`}
        </span>
      </div>

      {query.items.length === 0 ? (
        <p className="hint">暂无匹配的历史记录。</p>
      ) : (
        <ul className="history-list">
          {query.items.map((item) => (
            <HistoryListItem
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
              onDelete={() => void deleteEntry(item.id)}
            />
          ))}
        </ul>
      )}

      <div className="button-row">
        <button type="button" onClick={() => void gotoPrev()} disabled={query.offset === 0}>
          上一页
        </button>
        <button type="button" onClick={() => void gotoNext()} disabled={!query.hasMore}>
          下一页
        </button>
      </div>
    </section>
  );
}

interface HistoryListItemProps {
  item: RecommendationHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}

function HistoryListItem({ item, expanded, onToggle, onDelete }: HistoryListItemProps) {
  return (
    <li className={`history-entry ${expanded ? 'history-entry-expanded' : ''}`}>
      <button type="button" className="history-entry-summary" onClick={onToggle}>
        <span className="history-entry-time">{new Date(item.createdAt).toLocaleString()}</span>
        <span className="history-entry-tag">{labelForSource(item.result.source)}</span>
        {item.side !== 'single' && (
          <span className="history-entry-tag tag-compare">{item.side === 'left' ? '对比·左' : '对比·右'}</span>
        )}
        <span className="history-entry-meta">UID {item.uid}</span>
        <span className="history-entry-enemies">
          {item.enemyNames.length > 0 ? item.enemyNames.join('、') : '未指定敌人'}
        </span>
      </button>

      {expanded && (
        <div className="history-entry-body">
          <p>{item.result.summary}</p>
          {item.preference && (
            <p className="muted">
              <span>偏好：</span>
              {item.preference}
            </p>
          )}
          {item.result.teams.map((team, index) => (
            <article key={`${team.name}-${index}`} className="team-card">
              <h4>{team.name}</h4>
              <p className="muted">
                {team.characters.map((c) => `${c.name}(${c.element})`).join(' · ')}
              </p>
              <p>
                <span className="muted">思路：</span>
                {team.reasoning}
              </p>
              <p>
                <span className="muted">手法：</span>
                {team.rotationTip}
              </p>
            </article>
          ))}
          <div className="button-row">
            <button type="button" className="danger" onClick={onDelete}>
              删除此条
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function labelForSource(source: 'llm' | 'fallback'): string {
  return source === 'llm' ? 'LLM' : '本地';
}
