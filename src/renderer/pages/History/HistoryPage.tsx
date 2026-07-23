import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AbyssPlanHistoryEntry,
  ProfileStateView,
  StygianPlanHistoryEntry,
  TheaterPlanHistoryEntry
} from '../../../shared/domain';
import { EmptyState } from '../../components/ui/EmptyState';
import { GtaDialog } from '../../components/ui/GtaDialog';
import { localizeError, useI18n } from '../../i18n';
import { api } from '../../ipc';
import { rewardTargetLabel, reuseRuleSummary } from '../Advisor/stygian-presentation';
import { objectiveLabel, pathChoiceLabel, poolSourceLabel } from '../Advisor/theater-presentation';
import {
  createHistoryRerunIntent,
  groupChallengeHistory,
  historyCardTitle,
  historySavedVersion,
  type ChallengeHistoryEntry,
  type ChallengeHistoryGroup,
  type HistoryRerunIntent
} from './history-presentation';

interface HistoryPageProps {
  state: ProfileStateView;
  onRerun: (intent: HistoryRerunIntent) => void;
}

type PendingDelete =
  | { kind: 'single'; entry: ChallengeHistoryEntry }
  | {
      kind: 'group';
      group: ChallengeHistoryGroup;
      count: number;
      confirmationToken: string;
    }
  | { kind: 'all'; count: number; confirmationToken: string };

export function HistoryPage({ state, onRerun }: HistoryPageProps) {
  const { locale, t } = useI18n();
  const [allEntries, setAllEntries] = useState<ChallengeHistoryEntry[]>([]);
  const [legacyCount, setLegacyCount] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const activeUid = state.activeUid;
  const isEnglish = locale === 'en-US';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [abyss, stygian, theater, legacy] = await Promise.all([
        api.history.listAbyss({}),
        api.history.listStygian({}),
        api.history.listTheater({}),
        api.history.list({ offset: 0, limit: 1 })
      ]);
      setAllEntries([...abyss, ...stygian, ...theater]);
      setLegacyCount(legacy.total);
    } catch (loadError) {
      setError(localizeError(loadError, locale, t, 'history.error.load'));
    } finally {
      setLoading(false);
    }
  }, [locale, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleEntries = useMemo(
    () => allEntries.filter((entry) => !activeUid || entry.uid === activeUid),
    [activeUid, allEntries]
  );
  const groups = useMemo(() => groupChallengeHistory(visibleEntries), [visibleEntries]);
  const totalCount = allEntries.length + legacyCount;

  async function confirmDelete() {
    if (!pendingDelete) return;
    setError('');
    try {
      if (pendingDelete.kind === 'single') {
        await deleteSingle(pendingDelete.entry);
      } else if (pendingDelete.kind === 'group') {
        const { group } = pendingDelete;
        const uid = group.entries[0]?.uid;
        if (!uid) throw new Error('History group has no owner');
        await api.history.deleteScope({
          scope: 'group',
          uid,
          mode: group.mode,
          scenarioId: group.scenarioId,
          expectedCount: pendingDelete.count,
          confirmationToken: pendingDelete.confirmationToken
        });
      } else {
        await api.history.deleteScope({
          scope: 'all',
          expectedCount: pendingDelete.count,
          confirmationToken: pendingDelete.confirmationToken
        });
      }
      setExpandedId(null);
      setPendingDelete(null);
      await load();
    } catch (deleteError) {
      setPendingDelete(null);
      setError(localizeError(deleteError, locale, t, 'history.error.clear'));
    }
  }

  async function prepareGroupDelete(group: ChallengeHistoryGroup) {
    const uid = group.entries[0]?.uid;
    if (!uid) return;
    try {
      const confirmation = await api.history.prepareDeleteScope({
        scope: 'group',
        uid,
        mode: group.mode,
        scenarioId: group.scenarioId
      });
      setPendingDelete({ kind: 'group', group, ...confirmation });
    } catch (prepareError) {
      setError(localizeError(prepareError, locale, t, 'history.error.clear'));
    }
  }

  async function prepareAllDelete() {
    try {
      const confirmation = await api.history.prepareDeleteScope({ scope: 'all' });
      if (confirmation.count > 0) setPendingDelete({ kind: 'all', ...confirmation });
    } catch (prepareError) {
      setError(localizeError(prepareError, locale, t, 'history.error.clear'));
    }
  }

  async function deleteSingle(entry: ChallengeHistoryEntry) {
    switch (entry.mode) {
      case 'spiral-abyss':
        await api.history.deleteAbyss({ id: entry.id });
        break;
      case 'stygian-onslaught':
        await api.history.deleteStygian({ id: entry.id });
        break;
      case 'imaginarium-theater':
        await api.history.deleteTheater({ id: entry.id });
        break;
    }
  }

  return (
    <section className="gta-history-page">
      <header className="gta-page-head gta-history-head">
        <div>
          <span className="gta-page-kicker">
            {activeUid ? `UID ${activeUid}` : isEnglish ? 'Local records' : '本机记录'}
          </span>
          <h2 className="gta-section-title">{isEnglish ? 'Recommendation history' : '推荐记录'}</h2>
          <p className="gta-page-lead">
            {isEnglish
              ? 'Plans are preserved with the challenge rules and character choices used at the time.'
              : '旧方案会连同当时的挑战规则与角色选择一起保存，不会被本期资料改写。'}
          </p>
        </div>
        {totalCount > 0 && (
          <button
            type="button"
            className="gta-btn gta-btn--danger"
            onClick={() => void prepareAllDelete()}
          >
            {isEnglish ? `Clear all ${totalCount} records` : `清除全部 ${totalCount} 条记录`}
          </button>
        )}
      </header>

      {error && (
        <div className="gta-history-error" role="alert">
          <strong>{isEnglish ? 'History could not be updated' : '推荐记录未能更新'}</strong>
          <span>{error}</span>
          <button type="button" className="gta-text-action" onClick={() => void load()}>
            {isEnglish ? 'Try again' : '重新读取'}
          </button>
        </div>
      )}

      {loading ? (
        <p className="gta-hint gta-on-bg">{t('common.loading')}</p>
      ) : visibleEntries.length === 0 ? (
        <EmptyState kind="history" locale={isEnglish ? 'en' : 'zh'} />
      ) : (
        <div className="gta-history-groups">
          {groups.map((group) => (
            <section key={group.key} className="gta-history-group">
              <header>
                <div>
                  <span className="gta-page-kicker">
                    {group.entries.length} {isEnglish ? 'plans' : '份方案'}
                  </span>
                  <h3>{group.title}</h3>
                </div>
                <button
                  type="button"
                  className="gta-text-action is-danger"
                  onClick={() => void prepareGroupDelete(group)}
                >
                  {isEnglish ? 'Delete this cycle' : '删除这一周期'}
                </button>
              </header>
              <ul className="gta-history-list">
                {group.entries.map((entry) => (
                  <HistoryEntry
                    key={`${entry.mode}:${entry.id}`}
                    entry={entry}
                    expanded={expandedId === `${entry.mode}:${entry.id}`}
                    isEnglish={isEnglish}
                    onDelete={() => setPendingDelete({ kind: 'single', entry })}
                    onRerun={() => onRerun(createHistoryRerunIntent(entry))}
                    onToggle={() =>
                      setExpandedId((previous) =>
                        previous === `${entry.mode}:${entry.id}`
                          ? null
                          : `${entry.mode}:${entry.id}`
                      )
                    }
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {legacyCount > 0 && (
        <p className="gta-history-legacy-note">
          {isEnglish
            ? `${legacyCount} early-format records remain preserved locally. They can be removed from Data management.`
            : `另有 ${legacyCount} 条早期格式记录保留在本机，可在“数据管理”中一并清除。`}
        </p>
      )}

      <GtaDialog
        open={pendingDelete !== null}
        title={deleteDialogTitle(pendingDelete, isEnglish)}
        closeLabel={isEnglish ? 'Close confirmation' : '关闭确认框'}
        initialFocusRef={cancelDeleteRef}
        onClose={() => setPendingDelete(null)}
      >
        {pendingDelete && (
          <div className="gta-destructive-confirmation">
            <p>{deleteDialogBody(pendingDelete, isEnglish)}</p>
            <p>
              {isEnglish
                ? 'Character data, challenge cache, and smart-service settings will not be deleted. This cannot be undone.'
                : '不会删除角色资料、挑战资料或智能服务设置。此操作无法撤销。'}
            </p>
            <div className="gta-actions">
              <button
                type="button"
                className="gta-btn gta-btn--danger"
                onClick={() => void confirmDelete()}
              >
                {deleteDialogAction(pendingDelete, isEnglish)}
              </button>
              <button
                ref={cancelDeleteRef}
                type="button"
                className="gta-btn gta-btn--ghost"
                onClick={() => setPendingDelete(null)}
              >
                {isEnglish ? 'Keep and go back' : '保留并返回'}
              </button>
            </div>
          </div>
        )}
      </GtaDialog>
    </section>
  );
}

function HistoryEntry({
  entry,
  expanded,
  isEnglish,
  onDelete,
  onRerun,
  onToggle
}: {
  entry: ChallengeHistoryEntry;
  expanded: boolean;
  isEnglish: boolean;
  onDelete: () => void;
  onRerun: () => void;
  onToggle: () => void;
}) {
  const savedVersion = historySavedVersion(entry, isEnglish ? 'en' : 'zh');
  return (
    <li className={expanded ? 'gta-history-entry is-expanded' : 'gta-history-entry'}>
      <button
        type="button"
        className="gta-history-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="gta-history-entry-title">{historyCardTitle(entry)}</span>
        <span className={`gta-history-source is-${entry.source}`}>
          {entry.source === 'smart-service'
            ? isEnglish
              ? 'Smart suggestion'
              : '智能建议'
            : isEnglish
              ? 'Local rules'
              : '本地规则'}
        </span>
        <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
        {entry.scenarioTrust === 'development-sample' && (
          <span className="gta-history-sample">{isEnglish ? 'Practice data' : '演练资料'}</span>
        )}
      </button>
      {expanded && (
        <div className="gta-history-body">
          {entry.mode === 'spiral-abyss' ? (
            <AbyssDetails entry={entry} isEnglish={isEnglish} />
          ) : entry.mode === 'stygian-onslaught' ? (
            <StygianDetails entry={entry} isEnglish={isEnglish} />
          ) : (
            <TheaterDetails entry={entry} isEnglish={isEnglish} />
          )}
          <details className="gta-history-version">
            <summary>{isEnglish ? 'Saved version details' : '保存版本详情'}</summary>
            <dl>
              <div>
                <dt>{isEnglish ? 'Challenge record' : '挑战记录'}</dt>
                <dd>{savedVersion.scenario}</dd>
              </div>
              <div>
                <dt>{isEnglish ? 'Data version' : '资料版本'}</dt>
                <dd>{savedVersion.data}</dd>
              </div>
              <div>
                <dt>{isEnglish ? 'Record format' : '记录格式'}</dt>
                <dd>v{entry.schemaVersion}</dd>
              </div>
            </dl>
          </details>
          <div className="gta-history-entry-actions">
            <button type="button" className="gta-btn" onClick={onRerun}>
              {isEnglish ? 'Recalculate from this plan' : '基于这次方案重新计算'}
            </button>
            <button type="button" className="gta-text-action is-danger" onClick={onDelete}>
              {isEnglish ? 'Delete this plan' : '删除这份方案'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function AbyssDetails({ entry, isEnglish }: { entry: AbyssPlanHistoryEntry; isEnglish: boolean }) {
  const names = new Map(entry.characters.map((character) => [character.id, character.name]));
  const teamNames = (ids: string[]) =>
    ids.map((id) => names.get(id) ?? (isEnglish ? 'Saved character' : '已保存角色')).join(' · ');
  return (
    <div className="gta-history-plan-grid">
      <article>
        <span>{isEnglish ? 'First half' : '上半队伍'}</span>
        <strong>{teamNames(entry.plan.firstHalfTeam.characterIds)}</strong>
        <p>{entry.plan.firstHalfTeam.rotationNotes.join(isEnglish ? '; ' : '；')}</p>
      </article>
      <article>
        <span>{isEnglish ? 'Second half' : '下半队伍'}</span>
        <strong>{teamNames(entry.plan.secondHalfTeam.characterIds)}</strong>
        <p>{entry.plan.secondHalfTeam.rotationNotes.join(isEnglish ? '; ' : '；')}</p>
      </article>
      <InterventionSummary
        locked={entry.interventions.lockedCharacterIds.length}
        excluded={entry.interventions.excludedCharacterIds.length}
        isEnglish={isEnglish}
      />
    </div>
  );
}

function StygianDetails({
  entry,
  isEnglish
}: {
  entry: StygianPlanHistoryEntry;
  isEnglish: boolean;
}) {
  const characters = new Map(entry.characters.map((character) => [character.id, character.name]));
  return (
    <>
      <p className="gta-history-rule">
        {rewardTargetLabel(entry.target)} · {reuseRuleSummary(entry.reusePolicy)}
      </p>
      <div className="gta-history-plan-grid is-three">
        {entry.plan.phases
          .slice()
          .sort((left, right) => left.phase - right.phase)
          .map((phase) => (
            <article key={phase.phase}>
              <span>{isEnglish ? `Phase ${phase.phase}` : `第 ${phase.phase} 阶段`}</span>
              <strong>
                {phase.team.characterIds
                  .map((id) => characters.get(id) ?? (isEnglish ? 'Saved character' : '已保存角色'))
                  .join(' · ')}
              </strong>
              <p>{phase.team.purpose}</p>
            </article>
          ))}
      </div>
      <InterventionSummary
        locked={entry.interventions.lockedCharacterIds.length}
        excluded={entry.interventions.excludedCharacterIds.length}
        isEnglish={isEnglish}
      />
    </>
  );
}

function TheaterDetails({
  entry,
  isEnglish
}: {
  entry: TheaterPlanHistoryEntry;
  isEnglish: boolean;
}) {
  const names = new Map(entry.cast.map((actor) => [actor.id, actor.name]));
  return (
    <>
      <p className="gta-history-rule">
        {objectiveLabel(entry.target)} · {entry.eligibility.hardQualifiedCount}/
        {entry.eligibility.requiredHeadcount} {isEnglish ? 'eligible actors' : '名可入场'}
      </p>
      <div className="gta-history-theater-cast">
        {entry.cast.map((actor) => (
          <span key={`${actor.source}:${actor.id}`}>
            <strong>{actor.name}</strong>
            <small>
              {actor.source === 'owned'
                ? isEnglish
                  ? 'Owned'
                  : '自有角色'
                : poolSourceLabel(actor.source)}
            </small>
          </span>
        ))}
      </div>
      <ol className="gta-history-theater-route">
        {entry.plan.acts.map((act) => (
          <li key={act.act}>
            <strong>{isEnglish ? `Act ${act.act}` : `第 ${act.act} 幕`}</strong>
            <span>
              {act.candidateCharacterIds
                .map((id) => names.get(id) ?? (isEnglish ? 'Saved actor' : '已保存演员'))
                .join(isEnglish ? ', ' : '、')}
            </span>
            <small>{pathChoiceLabel(act.pathChoice)}</small>
          </li>
        ))}
      </ol>
      {entry.vigorBudget.length > 0 && (
        <div className="gta-history-theater-vigor">
          {entry.vigorBudget.map((item) => (
            <span key={`${item.act}:${item.characterId}`}>
              {isEnglish ? `Act ${item.act}` : `第 ${item.act} 幕`} ·{' '}
              {names.get(item.characterId) ?? (isEnglish ? 'Saved actor' : '已保存演员')}：
              {item.before} → {item.after}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function InterventionSummary({
  excluded,
  isEnglish,
  locked
}: {
  excluded: number;
  isEnglish: boolean;
  locked: number;
}) {
  return (
    <p className="gta-history-interventions">
      {isEnglish
        ? `Saved choices: ${locked} locked, ${excluded} excluded.`
        : `当时的角色选择：锁定 ${locked} 名，排除 ${excluded} 名。`}
    </p>
  );
}

function deleteDialogTitle(pending: PendingDelete | null, isEnglish: boolean): string {
  if (!pending) return '';
  if (pending.kind === 'single')
    return isEnglish ? 'Delete this recommendation?' : '删除这份推荐方案？';
  if (pending.kind === 'group')
    return isEnglish ? `Delete ${pending.group.title}?` : `删除${pending.group.title}？`;
  return isEnglish ? 'Clear all recommendation history?' : '清除全部推荐记录？';
}

function deleteDialogBody(pending: PendingDelete, isEnglish: boolean): string {
  const count =
    pending.kind === 'single' ? 1 : pending.kind === 'group' ? pending.count : pending.count;
  return isEnglish
    ? `This removes ${count} recommendation ${count === 1 ? 'record' : 'records'} from this device.`
    : `这会从本机删除 ${count} 条推荐记录。`;
}

function deleteDialogAction(pending: PendingDelete, isEnglish: boolean): string {
  const count =
    pending.kind === 'single' ? 1 : pending.kind === 'group' ? pending.count : pending.count;
  return isEnglish
    ? `Delete ${count} ${count === 1 ? 'record' : 'records'}`
    : `删除 ${count} 条记录`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
