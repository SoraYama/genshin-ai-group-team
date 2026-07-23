import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { PersistedProfile, ProfileStateView, RefreshSummary } from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';
import { normalizeElement } from '../../design/tokens';
import { api } from '../../ipc';
import { localizeError, useI18n } from '../../i18n';
import { AccountMaintenanceMenu } from './AccountMaintenanceMenu';
import { CharacterCard } from './CharacterCard';
import { ProfileSummary } from './ProfileSummary';
import { RosterToolbar, type ElementFilter } from './RosterToolbar';

interface RosterPageProps {
  state: ProfileStateView;
  onStateChange: () => Promise<void>;
  onGotoOnboarding: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; label: string }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

export function RosterPage({ state, onStateChange, onGotoOnboarding }: RosterPageProps) {
  const { locale, t } = useI18n();
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [lastRefresh, setLastRefresh] = useState<RefreshSummary | null>(null);
  const [query, setQuery] = useState('');
  const [elementFilter, setElementFilter] = useState<ElementFilter>('all');
  const activeUid = state.activeUid;

  const loadProfile = useCallback(
    async (uid: string) => {
      setStatus({ kind: 'loading', label: t('common.loading') });
      try {
        setProfile(await api.profile.get({ uid }));
        setStatus({ kind: 'idle' });
      } catch (error) {
        setStatus({ kind: 'error', message: localizeError(error, locale, t, 'roster.error.load') });
      }
    },
    [locale, t]
  );

  useEffect(() => {
    if (!activeUid) {
      setProfile(null);
      return;
    }
    void loadProfile(activeUid);
  }, [activeUid, loadProfile]);

  const filteredCharacters = useMemo(() => {
    if (!profile) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    return profile.characters.filter((character) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        character.name.toLocaleLowerCase(locale).includes(normalizedQuery);
      const matchesElement =
        elementFilter === 'all' || normalizeElement(character.element) === elementFilter;
      return matchesQuery && matchesElement;
    });
  }, [elementFilter, locale, profile, query]);

  async function handleSetActive(uid: string) {
    await api.profile.setActive({ uid });
    setQuery('');
    setElementFilter('all');
    await onStateChange();
  }

  function handleAccountTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const lastIndex = state.profiles.length - 1;
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') nextIndex = index === lastIndex ? 0 : index + 1;
    if (event.key === 'ArrowLeft') nextIndex = index === 0 ? lastIndex : index - 1;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = lastIndex;
    if (nextIndex === undefined || nextIndex === index) return;
    event.preventDefault();
    const nextProfile = state.profiles[nextIndex];
    if (nextProfile) {
      void handleSetActive(nextProfile.uid).then(() => {
        requestAnimationFrame(() =>
          document.getElementById(`profile-tab-${nextProfile.uid}`)?.focus()
        );
      });
    }
  }

  async function handleRefresh() {
    if (!activeUid) return;
    setStatus({ kind: 'loading', label: t('roster.action.refreshing') });
    try {
      const outcome = await api.profile.refresh({ uid: activeUid });
      setProfile(outcome.profile);
      setLastRefresh(outcome.summary);
      setStatus({ kind: 'success', message: t('roster.updateDone') });
      await onStateChange();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: localizeError(error, locale, t, 'roster.error.refresh')
      });
    }
  }

  async function handleReloginAndRefresh() {
    if (!activeUid) return;
    setStatus({ kind: 'loading', label: t('roster.action.waitLogin') });
    try {
      const login = await api.miyoushe.loginViaBrowser();
      if (!login.ok) {
        setStatus({
          kind: 'error',
          message:
            login.reason === 'cancelled'
              ? t('roster.error.cancelled')
              : ((locale === 'zh-CN' ? login.message : undefined) ??
                t('roster.error.login', { reason: login.reason }))
        });
        return;
      }
      const match = login.bind.roles.find((role) => role.gameUid === activeUid);
      if (!match) {
        setStatus({ kind: 'error', message: t('roster.error.uidMismatch') });
        return;
      }
      setStatus({ kind: 'loading', label: t('roster.action.fetchingAll') });
      const refreshed = await api.profile.importFromSession({
        sessionId: login.sessionId,
        uid: activeUid
      });
      setProfile(refreshed);
      setLastRefresh(null);
      setStatus({ kind: 'success', message: t('roster.accountUpdated') });
      await onStateChange();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: localizeError(error, locale, t, 'roster.error.relogin')
      });
    }
  }

  async function handleLogout() {
    setStatus({ kind: 'loading', label: t('roster.action.loggingOut') });
    try {
      await api.miyoushe.logout();
      setLastRefresh(null);
      setStatus({ kind: 'success', message: t('roster.logoutDone') });
    } catch (error) {
      setStatus({ kind: 'error', message: localizeError(error, locale, t, 'roster.error.logout') });
    }
  }

  async function handlePing() {
    if (!activeUid) return;
    setStatus({ kind: 'loading', label: t('roster.action.testing') });
    try {
      const result = await api.miyoushe.ping({ uid: activeUid });
      setStatus(
        result.ok
          ? { kind: 'success', message: t('roster.ping.playerOk') }
          : { kind: 'error', message: t('roster.ping.playerFailed') }
      );
    } catch (error) {
      setStatus({ kind: 'error', message: localizeError(error, locale, t, 'roster.error.test') });
    }
  }

  async function handleDelete() {
    if (!profile) return;
    await api.profile.delete({ uid: profile.uid });
    await onStateChange();
  }

  if (state.profiles.length === 0) {
    return (
      <section className="gta-roster-empty">
        <h2 className="gta-section-title">{t('roster.title')}</h2>
        <p>{t('roster.emptyAccounts')}</p>
        <button type="button" className="gta-btn" onClick={onGotoOnboarding}>
          <span className="gta-btn-icon">
            <ButtonGlyph name="plus" />
          </span>
          {t('roster.gotoBind')}
        </button>
      </section>
    );
  }

  return (
    <section className="gta-roster-page">
      <div className="gta-roster-heading">
        <h2 className="gta-section-title">{t('roster.title')}</h2>
        {profile && (
          <AccountMaintenanceMenu
            busy={status.kind === 'loading'}
            profile={profile}
            onDelete={handleDelete}
            onDiagnose={handlePing}
            onGotoOnboarding={onGotoOnboarding}
            onLogout={handleLogout}
            onRelogin={handleReloginAndRefresh}
          />
        )}
      </div>

      <div className="gta-uid-tabs" role="tablist" aria-label={t('roster.accountList')}>
        {state.profiles.map((item, index) => (
          <button
            key={item.uid}
            id={`profile-tab-${item.uid}`}
            type="button"
            role="tab"
            aria-selected={item.uid === activeUid}
            aria-controls="profile-panel"
            tabIndex={item.uid === activeUid ? 0 : -1}
            className={item.uid === activeUid ? 'gta-uid-tab is-active' : 'gta-uid-tab'}
            onClick={() => void handleSetActive(item.uid)}
            onKeyDown={(event) => handleAccountTabKeyDown(event, index)}
          >
            <span>{item.nickname ?? t('roster.unnamedAccount')}</span>
            <small>
              UID {item.uid} · {t('roster.characters', { count: item.characterCount })}
            </small>
          </button>
        ))}
      </div>

      <div
        id="profile-panel"
        role="tabpanel"
        aria-labelledby={activeUid ? `profile-tab-${activeUid}` : undefined}
        className="gta-roster-tabpanel"
      >
        {status.kind === 'error' && (
          <p className="gta-error" role="alert">
            {status.message}
          </p>
        )}
        {status.kind === 'success' && (
          <p className="gta-success" role="status">
            {status.message}
          </p>
        )}
        {status.kind === 'loading' && (
          <p className="gta-hint" role="status">
            {status.label}
          </p>
        )}
        {lastRefresh && status.kind !== 'loading' && <RefreshNotice summary={lastRefresh} />}

        {profile && (
          <>
            <ProfileSummary
              profile={profile}
              loading={status.kind === 'loading'}
              onRefresh={() => void handleRefresh()}
            />
            {profile.characters.length === 0 ? (
              <div className="gta-roster-empty">
                <p>{t('roster.emptyProfile')}</p>
              </div>
            ) : (
              <>
                <RosterToolbar
                  query={query}
                  filter={elementFilter}
                  totalCount={profile.characters.length}
                  filteredCount={filteredCharacters.length}
                  onQueryChange={setQuery}
                  onFilterChange={setElementFilter}
                />
                {filteredCharacters.length === 0 ? (
                  <p className="gta-roster-no-results">{t('roster.noResults')}</p>
                ) : (
                  <div className="gta-character-list">
                    {filteredCharacters.map((character) => (
                      <CharacterCard key={character.id} character={character} />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function RefreshNotice({ summary }: { summary: RefreshSummary }) {
  const { t } = useI18n();
  const accountIssue = summary.miyoushe !== 'ok';
  const panelIssue = summary.enka !== 'ok';
  if (!accountIssue && !panelIssue) return null;
  return (
    <aside className="gta-roster-notice" aria-label={t('roster.refresh.notice')}>
      <strong>
        {accountIssue ? t('roster.refresh.accountCause') : t('roster.refresh.panelCause')}
      </strong>
      <span>
        {accountIssue
          ? t('roster.refresh.accountImpact', { count: summary.totalCharacterCount })
          : t('roster.refresh.panelImpact', { count: summary.totalCharacterCount })}
      </span>
      <span>
        {accountIssue ? t('roster.refresh.accountAction') : t('roster.refresh.panelAction')}
      </span>
    </aside>
  );
}
