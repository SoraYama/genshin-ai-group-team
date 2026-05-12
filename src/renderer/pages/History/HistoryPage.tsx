import { useCallback, useEffect, useState } from 'react';
import { api } from '../../ipc';
import type {
  HistoryQueryResult,
  ProfileStateView,
  RecommendationHistoryEntry
} from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';

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
    <section>
      <h2 className="gta-section-title">
        推荐历史
        <span className="gta-section-sub">HISTORY · MAX 200</span>
      </h2>

      <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
        <div className="gta-panel-body">
          <div className="gta-form-grid">
            <label className="gta-field">
              <span className="gta-field-label">范围</span>
              <select
                className="gta-select"
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
            <label className="gta-field">
              <span className="gta-field-label">来源</span>
              <select
                className="gta-select"
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
            <label className="gta-field">
              <span className="gta-field-label">敌人关键词</span>
              <input
                type="text"
                className="gta-input"
                value={filters.enemyKeyword}
                onChange={(event) =>
                  setFilters((prev) => ({ ...prev, enemyKeyword: event.target.value }))
                }
              />
            </label>
            <label className="gta-field">
              <span className="gta-field-label">起始日期</span>
              <input
                type="date"
                className="gta-input is-mono"
                value={filters.fromDate}
                onChange={(event) =>
                  setFilters((prev) => ({ ...prev, fromDate: event.target.value }))
                }
              />
            </label>
            <label className="gta-field">
              <span className="gta-field-label">结束日期</span>
              <input
                type="date"
                className="gta-input is-mono"
                value={filters.toDate}
                onChange={(event) =>
                  setFilters((prev) => ({ ...prev, toDate: event.target.value }))
                }
              />
            </label>
            <label className="gta-field">
              <span className="gta-field-label">每页</span>
              <input
                type="number"
                className="gta-input is-mono"
                min={1}
                max={100}
                value={filters.limit}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    limit: Math.max(1, Number(event.target.value) || 20)
                  }))
                }
              />
            </label>
          </div>

          <div className="gta-actions" style={{ marginTop: 'var(--gta-s4)' }}>
            <button
              type="button"
              className="gta-btn"
              onClick={() => void applyFilters()}
              disabled={loading}
            >
              <span className="gta-btn-icon">
                <ButtonGlyph name="refresh" />
              </span>
              {loading ? '加载中…' : '应用筛选'}
            </button>
            <button
              type="button"
              className="gta-btn gta-btn--danger"
              onClick={() => void clearMatching()}
            >
              <span className="gta-btn-icon">
                <ButtonGlyph name="trash" />
              </span>
              删除匹配项
            </button>
          </div>
        </div>
      </div>

      {error && <p className="gta-error">{error}</p>}

      <p className="gta-history-stats">
        <span>共 {query.total} 条</span>
        <span>
          当前页：
          {query.total === 0
            ? '0-0'
            : `${query.offset + 1}-${Math.min(query.offset + query.limit, query.total)}`}
        </span>
      </p>

      {query.items.length === 0 ? (
        <div className="gta-panel">
          <div className="gta-panel-body">
            <p className="gta-hint">暂无匹配的历史记录。</p>
          </div>
        </div>
      ) : (
        <ul className="gta-history-list">
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

      <div className="gta-actions" style={{ marginTop: 'var(--gta-s4)' }}>
        <button
          type="button"
          className="gta-btn gta-btn--ghost"
          onClick={() => void gotoPrev()}
          disabled={query.offset === 0}
        >
          上一页
        </button>
        <button
          type="button"
          className="gta-btn gta-btn--ghost"
          onClick={() => void gotoNext()}
          disabled={!query.hasMore}
        >
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
  const isLlm = item.result.source === 'llm';
  return (
    <li className={expanded ? 'gta-history-entry is-expanded' : 'gta-history-entry'}>
      <button type="button" className="gta-history-summary" onClick={onToggle}>
        <span className="gta-history-time">{formatTime(item.createdAt)}</span>
        <span className={isLlm ? 'gta-tag is-llm' : 'gta-tag is-fallback'}>
          {isLlm ? 'LLM' : '本地'}
        </span>
        {item.side !== 'single' && (
          <span className="gta-tag is-accent">
            对比·{item.side === 'left' ? '左' : '右'}
          </span>
        )}
        <span className="gta-history-uid">UID {item.uid}</span>
        <span className="gta-history-enemies">
          {item.enemyNames.length > 0 ? item.enemyNames.join('、') : '未指定敌人'}
        </span>
      </button>

      {expanded && (
        <div className="gta-history-body">
          <p style={{ margin: 0 }}>{item.result.summary}</p>
          {item.preference && (
            <p
              className="gta-hint"
              style={{ margin: 0, fontSize: 'var(--gta-text-sm)' }}
            >
              <span className="gta-team-line-label">偏好</span>
              {item.preference}
            </p>
          )}
          {item.result.teams.map((team, index) => (
            <article key={`${team.name}-${index}`} className="gta-team-card">
              <h4>{team.name}</h4>
              <p className="gta-team-roster">
                {team.characters.map((c) => `${c.name}(${c.element})`).join(' · ')}
              </p>
              <p>
                <span className="gta-team-line-label">思路</span>
                {team.reasoning}
              </p>
              <p>
                <span className="gta-team-line-label">手法</span>
                {team.rotationTip}
              </p>
            </article>
          ))}
          <div className="gta-actions">
            <button type="button" className="gta-btn gta-btn--danger" onClick={onDelete}>
              <span className="gta-btn-icon">
                <ButtonGlyph name="trash" />
              </span>
              删除此条
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yy}-${mm}-${dd} ${hh}:${mi}`;
}
