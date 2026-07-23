import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../ipc';
import type {
  AbyssPlanHistoryEntry,
  HistoryQueryResult,
  ProfileStateView,
  RecommendationHistoryEntry,
  StygianPlanHistoryEntry,
  TheaterPlanHistoryEntry
} from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';
import { localizeError, useI18n } from '../../i18n';
import { rewardTargetLabel, reuseRuleSummary } from '../Advisor/stygian-presentation';
import { objectiveLabel, pathChoiceLabel, poolSourceLabel } from '../Advisor/theater-presentation';

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
  const { locale, t } = useI18n();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [query, setQuery] = useState<HistoryQueryResult>({
    items: [],
    total: 0,
    offset: 0,
    limit: 20,
    hasMore: false
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [abyssPlans, setAbyssPlans] = useState<AbyssPlanHistoryEntry[]>([]);
  const [stygianPlans, setStygianPlans] = useState<StygianPlanHistoryEntry[]>([]);
  const [theaterPlans, setTheaterPlans] = useState<TheaterPlanHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const filtersRef = useRef(filters);

  const load = useCallback(
    async (next: Filters, offset: number) => {
      setError(null);
      setLoading(true);
      try {
        const [result, nextAbyssPlans, nextStygianPlans, nextTheaterPlans] = await Promise.all([
          api.history.list({
            uid: next.scope === 'active' ? state.activeUid : undefined,
            source: next.source === 'all' ? undefined : next.source,
            enemyKeyword: next.enemyKeyword.trim() || undefined,
            fromDate: next.fromDate || undefined,
            toDate: next.toDate || undefined,
            offset,
            limit: next.limit
          }),
          api.history.listAbyss({
            uid: next.scope === 'active' ? state.activeUid : undefined
          }),
          api.history.listStygian({
            uid: next.scope === 'active' ? state.activeUid : undefined
          }),
          api.history.listTheater({
            uid: next.scope === 'active' ? state.activeUid : undefined
          })
        ]);
        setQuery(result);
        setAbyssPlans(
          nextAbyssPlans.filter((entry) => {
            const sourceMatches =
              next.source === 'all' ||
              (next.source === 'llm' && entry.source === 'smart-service') ||
              (next.source === 'fallback' && entry.source === 'local-rules');
            const timestamp = Date.parse(entry.createdAt);
            const fromMatches =
              !next.fromDate || timestamp >= Date.parse(`${next.fromDate}T00:00:00`);
            const toMatches = !next.toDate || timestamp <= Date.parse(`${next.toDate}T23:59:59`);
            return sourceMatches && fromMatches && toMatches && !next.enemyKeyword.trim();
          })
        );
        setStygianPlans(
          nextStygianPlans.filter((entry) => {
            const sourceMatches =
              next.source === 'all' ||
              (next.source === 'llm' && entry.source === 'smart-service') ||
              (next.source === 'fallback' && entry.source === 'local-rules');
            const timestamp = Date.parse(entry.createdAt);
            const fromMatches =
              !next.fromDate || timestamp >= Date.parse(`${next.fromDate}T00:00:00`);
            const toMatches = !next.toDate || timestamp <= Date.parse(`${next.toDate}T23:59:59`);
            return sourceMatches && fromMatches && toMatches && !next.enemyKeyword.trim();
          })
        );
        setTheaterPlans(
          nextTheaterPlans.filter((entry) => {
            const sourceMatches =
              next.source === 'all' ||
              (next.source === 'llm' && entry.source === 'smart-service') ||
              (next.source === 'fallback' && entry.source === 'local-rules');
            const timestamp = Date.parse(entry.createdAt);
            const fromMatches =
              !next.fromDate || timestamp >= Date.parse(`${next.fromDate}T00:00:00`);
            const toMatches = !next.toDate || timestamp <= Date.parse(`${next.toDate}T23:59:59`);
            return sourceMatches && fromMatches && toMatches && !next.enemyKeyword.trim();
          })
        );
      } catch (err) {
        setError(localizeError(err, locale, t, 'history.error.load'));
      } finally {
        setLoading(false);
      }
    },
    [locale, state.activeUid, t]
  );

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    void load(filtersRef.current, 0);
  }, [load, filters.scope]);

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

  async function deleteAbyssEntry(id: string) {
    await api.history.deleteAbyss({ id });
    if (expandedId === id) setExpandedId(null);
    await load(filters, query.offset);
  }

  async function deleteStygianEntry(id: string) {
    await api.history.deleteStygian({ id });
    if (expandedId === id) setExpandedId(null);
    await load(filters, query.offset);
  }

  async function deleteTheaterEntry(id: string) {
    await api.history.deleteTheater({ id });
    if (expandedId === id) setExpandedId(null);
    await load(filters, query.offset);
  }

  async function clearMatching() {
    if (filters.scope !== 'active' && filters.source === 'all' && !filters.enemyKeyword.trim()) {
      setError(t('history.error.clearGuard'));
      return;
    }
    try {
      const result = await api.history.clear({
        uid: filters.scope === 'active' ? state.activeUid : undefined,
        source: filters.source === 'all' ? undefined : filters.source,
        enemyKeyword: filters.enemyKeyword.trim() || undefined
      });
      await load(filters, 0);
      setError(result.removed === 0 ? t('history.error.noMatches') : null);
    } catch (err) {
      setError(localizeError(err, locale, t, 'history.error.clear'));
    }
  }

  return (
    <section>
      <h2 className="gta-section-title">
        {t('history.title')}
        <span className="gta-section-sub">HISTORY · MAX 200</span>
      </h2>

      <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
        <div className="gta-panel-body">
          <div className="gta-form-grid">
            <label className="gta-field">
              <span className="gta-field-label">{t('history.scope')}</span>
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
                <option value="active">{t('history.scope.active')}</option>
                <option value="all">{t('history.scope.all')}</option>
              </select>
            </label>
            <label className="gta-field">
              <span className="gta-field-label">{t('history.source')}</span>
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
                <option value="all">{t('history.source.all')}</option>
                <option value="llm">{t('advisor.smartService')}</option>
                <option value="fallback">{t('history.source.fallback')}</option>
              </select>
            </label>
            <label className="gta-field">
              <span className="gta-field-label">{t('history.enemyKeyword')}</span>
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
              <span className="gta-field-label">{t('history.fromDate')}</span>
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
              <span className="gta-field-label">{t('history.toDate')}</span>
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
              <span className="gta-field-label">{t('history.perPage')}</span>
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
              {loading ? t('common.loading') : t('history.apply')}
            </button>
            <button
              type="button"
              className="gta-btn gta-btn--danger"
              onClick={() => void clearMatching()}
            >
              <span className="gta-btn-icon">
                <ButtonGlyph name="trash" />
              </span>
              {t('history.deleteMatching')}
            </button>
          </div>
        </div>
      </div>

      {error && <p className="gta-error">{error}</p>}

      <section className="gta-history-abyss" aria-labelledby="abyss-history-title">
        <h3 id="abyss-history-title">深境螺旋方案</h3>
        {abyssPlans.length === 0 ? (
          <p className="gta-hint">当前筛选下没有已保存的深境螺旋双队方案。</p>
        ) : (
          <ul className="gta-history-list">
            {abyssPlans.map((entry) => (
              <AbyssHistoryListItem
                key={entry.id}
                entry={entry}
                expanded={expandedId === entry.id}
                onToggle={() =>
                  setExpandedId((previous) => (previous === entry.id ? null : entry.id))
                }
                onDelete={() => void deleteAbyssEntry(entry.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="gta-history-abyss" aria-labelledby="stygian-history-title">
        <h3 id="stygian-history-title">幽境危战方案</h3>
        {stygianPlans.length === 0 ? (
          <p className="gta-hint">当前筛选下没有已保存的幽境危战三阶段方案。</p>
        ) : (
          <ul className="gta-history-list">
            {stygianPlans.map((entry) => (
              <StygianHistoryListItem
                key={entry.id}
                entry={entry}
                expanded={expandedId === entry.id}
                onToggle={() =>
                  setExpandedId((previous) => (previous === entry.id ? null : entry.id))
                }
                onDelete={() => void deleteStygianEntry(entry.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="gta-history-abyss" aria-labelledby="theater-history-title">
        <h3 id="theater-history-title">幻想真境剧诗方案</h3>
        {theaterPlans.length === 0 ? (
          <p className="gta-hint">当前筛选下没有已保存的剧诗演员与活力路线。</p>
        ) : (
          <ul className="gta-history-list">
            {theaterPlans.map((entry) => (
              <TheaterHistoryListItem
                key={entry.id}
                entry={entry}
                expanded={expandedId === entry.id}
                onToggle={() =>
                  setExpandedId((previous) => (previous === entry.id ? null : entry.id))
                }
                onDelete={() => void deleteTheaterEntry(entry.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <p className="gta-history-stats">
        <span>{t('history.total', { count: query.total })}</span>
        <span>
          {t('history.page', {
            range:
              query.total === 0
                ? '0-0'
                : `${query.offset + 1}-${Math.min(query.offset + query.limit, query.total)}`
          })}
        </span>
      </p>

      {query.items.length === 0 ? (
        <div className="gta-panel">
          <div className="gta-panel-body">
            <p className="gta-hint">{t('history.empty')}</p>
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
          {t('history.prev')}
        </button>
        <button
          type="button"
          className="gta-btn gta-btn--ghost"
          onClick={() => void gotoNext()}
          disabled={!query.hasMore}
        >
          {t('history.next')}
        </button>
      </div>
    </section>
  );
}

function TheaterHistoryListItem({
  entry,
  expanded,
  onToggle,
  onDelete
}: {
  entry: TheaterPlanHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const names = new Map(entry.cast.map((actor) => [actor.id, actor.name]));
  return (
    <li className={expanded ? 'gta-history-entry is-expanded' : 'gta-history-entry'}>
      <button type="button" className="gta-history-summary" onClick={onToggle}>
        <span className="gta-history-time">{formatTime(entry.createdAt)}</span>
        <span
          className={entry.source === 'smart-service' ? 'gta-tag is-llm' : 'gta-tag is-fallback'}
        >
          {entry.source === 'smart-service' ? '智能服务' : '本地规则'}
        </span>
        {entry.scenarioTrust === 'development-sample' && (
          <span className="gta-tag is-accent">演练资料</span>
        )}
        <span className="gta-history-uid">UID {entry.uid}</span>
        <span className="gta-history-enemies">
          {objectiveLabel(entry.target)} · {entry.eligibility.hardQualifiedCount} /{' '}
          {entry.eligibility.requiredHeadcount} 名可入场 ·{' '}
          {entry.act === undefined ? '全部幕次' : `第 ${entry.act} 幕`}
        </span>
      </button>
      {expanded && (
        <div className="gta-history-body gta-history-theater-body">
          <section>
            <h4>入场演员池</h4>
            <div className="gta-history-theater-cast">
              {entry.cast.map(({ id, name, source }) => (
                <span key={`${source}:${id}`}>
                  <strong>{name}</strong>
                  <small>{source === 'owned' ? '自有角色' : poolSourceLabel(source)}</small>
                </span>
              ))}
            </div>
          </section>
          <section>
            <h4>逐幕活力预算</h4>
            <div className="gta-history-theater-vigor">
              {entry.vigorBudget.map((item) => (
                <span key={`${item.act}:${item.characterId}`}>
                  第 {item.act} 幕 · {names.get(item.characterId) ?? '未命名演员'}：{item.before} →{' '}
                  {item.after}（花费 {item.spent}）
                </span>
              ))}
            </div>
          </section>
          <section>
            <h4>幕次路线</h4>
            <ol className="gta-history-theater-route">
              {entry.plan.acts.map((act) => (
                <li key={act.act}>
                  <strong>第 {act.act} 幕</strong>
                  <span>
                    {act.candidateCharacterIds
                      .map((id) => names.get(id) ?? '未命名演员')
                      .join('、')}
                  </span>
                  <small>{pathChoiceLabel(act.pathChoice)}</small>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h4>保留与分支优先级</h4>
            {entry.routeGuidance.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </section>
          <div className="gta-actions">
            <button type="button" className="gta-btn gta-btn--danger" onClick={onDelete}>
              删除这条幻想真境剧诗方案
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function StygianHistoryListItem({
  entry,
  expanded,
  onToggle,
  onDelete
}: {
  entry: StygianPlanHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const characters = new Map(entry.characters.map((character) => [character.id, character]));
  const teamNames = (ids: string[]) =>
    ids.map((id) => characters.get(id)?.name ?? '未知角色').join(' · ');
  return (
    <li className={expanded ? 'gta-history-entry is-expanded' : 'gta-history-entry'}>
      <button type="button" className="gta-history-summary" onClick={onToggle}>
        <span className="gta-history-time">{formatTime(entry.createdAt)}</span>
        <span
          className={entry.source === 'smart-service' ? 'gta-tag is-llm' : 'gta-tag is-fallback'}
        >
          {entry.source === 'smart-service' ? '智能服务' : '本地规则'}
        </span>
        {entry.scenarioTrust === 'development-sample' && (
          <span className="gta-tag is-accent">演练资料</span>
        )}
        <span className="gta-history-uid">UID {entry.uid}</span>
        <span className="gta-history-enemies">
          {entry.difficultyName} · {rewardTargetLabel(entry.target)} ·{' '}
          {entry.phase === undefined ? '' : `重点第 ${entry.phase} 阶段 · `}
          {entry.scenarioTrust === 'development-sample' ? '演练版本' : '正式版本'}
        </span>
      </button>
      {expanded && (
        <div className="gta-history-body">
          <p className="gta-hint" style={{ margin: 0 }}>
            {reuseRuleSummary(entry.reusePolicy)}
          </p>
          {entry.plan.phases
            .slice()
            .sort((left, right) => left.phase - right.phase)
            .map((phase) => (
              <article key={phase.phase} className="gta-team-card">
                <h4>第 {phase.phase} 阶段</h4>
                <p>{teamNames(phase.team.characterIds)}</p>
                <p>{phase.team.purpose}</p>
                <p>{phase.team.rotationNotes.join('；')}</p>
              </article>
            ))}
          <div className="gta-actions">
            <button type="button" className="gta-btn gta-btn--danger" onClick={onDelete}>
              删除这条幽境危战方案
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function AbyssHistoryListItem({
  entry,
  expanded,
  onToggle,
  onDelete
}: {
  entry: AbyssPlanHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const characters = new Map(
    (entry.characters ?? []).map((character) => [character.id, character])
  );
  const teamNames = (ids: string[]) =>
    ids.map((id) => characters.get(id)?.name ?? `角色 ${id}`).join(' · ');
  return (
    <li className={expanded ? 'gta-history-entry is-expanded' : 'gta-history-entry'}>
      <button type="button" className="gta-history-summary" onClick={onToggle}>
        <span className="gta-history-time">{formatTime(entry.createdAt)}</span>
        <span
          className={entry.source === 'smart-service' ? 'gta-tag is-llm' : 'gta-tag is-fallback'}
        >
          {entry.source === 'smart-service' ? '智能服务' : '本地规则'}
        </span>
        {entry.scenarioTrust === 'development-sample' && (
          <span className="gta-tag is-accent">演练资料</span>
        )}
        <span className="gta-history-uid">UID {entry.uid}</span>
        <span className="gta-history-enemies">
          {entry.target.floor} 层 ·{' '}
          {entry.target.chamber ? `第 ${entry.target.chamber} 间` : '全部房间'} ·{' '}
          {entry.scenarioTrust === 'development-sample' ? '演练版本' : entry.dataVersion}
        </span>
      </button>
      {expanded && (
        <div className="gta-history-body">
          <article className="gta-team-card">
            <h4>上半队伍</h4>
            <p>{teamNames(entry.plan.firstHalfTeam.characterIds)}</p>
            <p>{entry.plan.firstHalfTeam.rotationNotes.join('；')}</p>
          </article>
          <article className="gta-team-card">
            <h4>下半队伍</h4>
            <p>{teamNames(entry.plan.secondHalfTeam.characterIds)}</p>
            <p>{entry.plan.secondHalfTeam.rotationNotes.join('；')}</p>
          </article>
          <div className="gta-actions">
            <button type="button" className="gta-btn gta-btn--danger" onClick={onDelete}>
              删除这条深境螺旋方案
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

interface HistoryListItemProps {
  item: RecommendationHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}

function HistoryListItem({ item, expanded, onToggle, onDelete }: HistoryListItemProps) {
  const { t } = useI18n();
  const isLlm = item.result.source === 'llm';
  return (
    <li className={expanded ? 'gta-history-entry is-expanded' : 'gta-history-entry'}>
      <button type="button" className="gta-history-summary" onClick={onToggle}>
        <span className="gta-history-time">{formatTime(item.createdAt)}</span>
        <span className={isLlm ? 'gta-tag is-llm' : 'gta-tag is-fallback'}>
          {isLlm ? t('advisor.smartService') : t('history.local')}
        </span>
        {item.side !== 'single' && (
          <span className="gta-tag is-accent">
            {t('history.compareSide', {
              side: item.side === 'left' ? t('history.left') : t('history.right')
            })}
          </span>
        )}
        <span className="gta-history-uid">UID {item.uid}</span>
        <span className="gta-history-enemies">
          {item.enemyNames.length > 0 ? item.enemyNames.join(', ') : t('history.noEnemies')}
        </span>
      </button>

      {expanded && (
        <div className="gta-history-body">
          <p style={{ margin: 0 }}>{item.result.summary}</p>
          {item.result.dataNotes && item.result.dataNotes.length > 0 && (
            <p className="gta-hint" style={{ margin: 0 }}>
              {t('advisor.dataNotes', { notes: item.result.dataNotes.join('; ') })}
            </p>
          )}
          {item.preference && (
            <p className="gta-hint" style={{ margin: 0, fontSize: 'var(--gta-text-sm)' }}>
              <span className="gta-team-line-label">{t('advisor.preference')}</span>
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
                <span className="gta-team-line-label">{t('advisor.reasoning')}</span>
                {team.reasoning}
              </p>
              <p>
                <span className="gta-team-line-label">{t('advisor.rotation')}</span>
                {team.rotationTip}
              </p>
              {team.assumptions && team.assumptions.length > 0 && (
                <p className="gta-hint">
                  <span className="gta-team-line-label">{t('advisor.assumptions')}</span>
                  {team.assumptions.join('; ')}
                </p>
              )}
              {team.critiqueIssues && team.critiqueIssues.length > 0 && (
                <p className="gta-hint">
                  <span className="gta-team-line-label">{t('advisor.risks')}</span>
                  {team.critiqueIssues.join('; ')}
                </p>
              )}
            </article>
          ))}
          <div className="gta-actions">
            <button type="button" className="gta-btn gta-btn--danger" onClick={onDelete}>
              <span className="gta-btn-icon">
                <ButtonGlyph name="trash" />
              </span>
              {t('history.deleteOne')}
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
