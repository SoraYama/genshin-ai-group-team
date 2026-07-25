import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PersistedProfile, ProfileStateView, RefreshSummary } from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';
import { normalizeElement } from '../../design/tokens';
import { api } from '../../ipc';
import { localizeError, useI18n } from '../../i18n';
import { AccountMaintenanceMenu } from './AccountMaintenanceMenu';
import { CharacterDetailDrawer } from './CharacterDetailDrawer';
import { CharacterTile } from './CharacterTile';
import { ProfileSummary } from './ProfileSummary';
import { RosterToolbar, type ElementFilter } from './RosterToolbar';
import { sortCharacters, type RosterSortMode } from './character-presentation';

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

interface ProfileRequestToken {
  generation: number;
  uid: string;
}

export function RosterPage({ state, onStateChange, onGotoOnboarding }: RosterPageProps) {
  const { locale, t } = useI18n();
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [lastRefresh, setLastRefresh] = useState<RefreshSummary | null>(null);
  const [query, setQuery] = useState('');
  const [elementFilter, setElementFilter] = useState<ElementFilter>('all');
  const [sortMode, setSortMode] = useState<RosterSortMode>('default');
  const [selectedCharacterId, setSelectedCharacterId] = useState<number | null>(null);
  const selectedTileRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rosterGridRef = useRef<HTMLDivElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const activeUid = state.activeUid;
  const activeUidRef = useRef(activeUid);
  const mountedRef = useRef(true);
  const requestGenerationRef = useRef(0);
  activeUidRef.current = activeUid;

  const beginProfileRequest = useCallback(
    (uid: string): ProfileRequestToken => ({
      generation: ++requestGenerationRef.current,
      uid
    }),
    []
  );
  const canCommitProfileRequest = useCallback(
    (token: ProfileRequestToken, responseUid?: string): boolean =>
      mountedRef.current &&
      token.generation === requestGenerationRef.current &&
      token.uid === activeUidRef.current &&
      (responseUid === undefined || responseUid === token.uid),
    []
  );
  const restorePersistedActiveUid = useCallback(async () => {
    while (mountedRef.current) {
      const uid = activeUidRef.current;
      const generation = requestGenerationRef.current;
      if (!uid) return;
      await api.profile.setActive({ uid });
      if (!mountedRef.current) return;
      if (uid === activeUidRef.current && generation === requestGenerationRef.current) return;
    }
  }, []);
  const loadProfile = useCallback(
    async (uid: string) => {
      const token = beginProfileRequest(uid);
      setStatus({ kind: 'loading', label: t('common.loading') });
      try {
        const next = await api.profile.get({ uid });
        if (!canCommitProfileRequest(token, next?.uid)) return;
        setProfile(next);
        setStatus({ kind: 'idle' });
      } catch (error) {
        if (!canCommitProfileRequest(token)) return;
        setStatus({ kind: 'error', message: localizeError(error, locale, t, 'roster.error.load') });
      }
    },
    [beginProfileRequest, canCommitProfileRequest, locale, t]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    };
  }, []);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setProfile(null);
    setLastRefresh(null);
    setStatus({ kind: 'idle' });
  }, [activeUid]);

  useEffect(() => {
    if (activeUid) void loadProfile(activeUid);
  }, [activeUid, loadProfile]);

  const verifiedProfile = profile?.uid === activeUid ? profile : null;
  const filteredCharacters = useMemo(() => {
    if (!verifiedProfile) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    return verifiedProfile.characters.filter((character) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        character.name.toLocaleLowerCase(locale).includes(normalizedQuery);
      const matchesElement =
        elementFilter === 'all' || normalizeElement(character.element) === elementFilter;
      return matchesQuery && matchesElement;
    });
  }, [elementFilter, locale, query, verifiedProfile]);
  const sortedCharacters = useMemo(
    () => sortCharacters(filteredCharacters, sortMode, locale),
    [filteredCharacters, locale, sortMode]
  );
  const selectedCharacter =
    selectedCharacterId === null
      ? undefined
      : verifiedProfile?.characters.find((character) => character.id === selectedCharacterId);

  const scheduleRosterFocus = useCallback((resolveTarget: () => HTMLElement | null) => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = requestAnimationFrame(() => {
        focusFrameRef.current = null;
        if (!mountedRef.current) return;
        resolveTarget()?.focus();
      });
    });
  }, []);
  const restoreRosterFocus = useCallback(
    (preferred?: HTMLElement | null) => {
      scheduleRosterFocus(() => {
        const activeTab =
          document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
          (activeUidRef.current
            ? document.getElementById(`profile-tab-${activeUidRef.current}`)
            : null);
        const target =
          (preferred?.isConnected ? preferred : null) ??
          (searchInputRef.current?.isConnected ? searchInputRef.current : null) ??
          (rosterGridRef.current?.isConnected ? rosterGridRef.current : null) ??
          activeTab;
        return target;
      });
    },
    [scheduleRosterFocus]
  );

  useEffect(() => {
    if (selectedCharacterId === null) return;
    const stillExists = verifiedProfile?.characters.some(
      (character) => character.id === selectedCharacterId
    );
    if (stillExists) return;
    const trigger = selectedTileRef.current;
    selectedTileRef.current = null;
    setSelectedCharacterId(null);
    restoreRosterFocus(trigger);
  }, [restoreRosterFocus, selectedCharacterId, verifiedProfile]);

  async function handleSetActive(uid: string): Promise<boolean> {
    const previousUid = activeUidRef.current;
    if (uid === previousUid) return true;
    const generation = ++requestGenerationRef.current;
    setStatus({ kind: 'loading', label: t('common.loading') });
    try {
      await api.profile.setActive({ uid });
      if (!mountedRef.current) return false;
      if (generation !== requestGenerationRef.current || activeUidRef.current !== previousUid) {
        await restorePersistedActiveUid();
        return false;
      }
      try {
        await onStateChange();
      } catch (error) {
        if (previousUid) {
          try {
            await api.profile.setActive({ uid: previousUid });
          } catch {
            // Preserve the already rendered profile even if rollback cannot
            // reach main; the next explicit retry reconciles both processes.
          }
        }
        if (
          mountedRef.current &&
          generation === requestGenerationRef.current &&
          activeUidRef.current === previousUid
        ) {
          setStatus({
            kind: 'error',
            message: localizeError(error, locale, t, 'roster.error.activate')
          });
        }
        return false;
      }
      if (!mountedRef.current || generation !== requestGenerationRef.current) return false;
      setQuery('');
      setElementFilter('all');
      setSortMode('default');
      setLastRefresh(null);
      selectedTileRef.current = null;
      setSelectedCharacterId(null);
      setStatus({ kind: 'idle' });
      return true;
    } catch (error) {
      if (
        mountedRef.current &&
        generation === requestGenerationRef.current &&
        activeUidRef.current === previousUid
      ) {
        setStatus({
          kind: 'error',
          message: localizeError(error, locale, t, 'roster.error.activate')
        });
      }
      return false;
    }
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
      void handleSetActive(nextProfile.uid).then((switched) => {
        scheduleRosterFocus(() =>
          document.getElementById(
            `profile-tab-${switched ? nextProfile.uid : (activeUidRef.current ?? nextProfile.uid)}`
          )
        );
      });
    }
  }

  async function handleRefresh() {
    if (!activeUid) return;
    const token = beginProfileRequest(activeUid);
    setStatus({ kind: 'loading', label: t('roster.action.refreshing') });
    try {
      const outcome = await api.profile.refresh({ uid: activeUid });
      if (!canCommitProfileRequest(token, outcome.profile.uid)) return;
      setProfile(outcome.profile);
      setLastRefresh(outcome.summary);
      setStatus({ kind: 'success', message: t('roster.updateDone') });
      await onStateChange();
    } catch (error) {
      if (!canCommitProfileRequest(token)) return;
      setStatus({
        kind: 'error',
        message: localizeError(error, locale, t, 'roster.error.refresh')
      });
    }
  }

  async function handleReloginAndRefresh() {
    if (!activeUid) return;
    const token = beginProfileRequest(activeUid);
    setStatus({ kind: 'loading', label: t('roster.action.waitLogin') });
    try {
      const login = await api.miyoushe.loginViaBrowser();
      if (!canCommitProfileRequest(token)) return;
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
      const match = login.bind.roles.find((role) => role.gameUid === token.uid);
      if (!match) {
        setStatus({ kind: 'error', message: t('roster.error.uidMismatch') });
        return;
      }
      setStatus({ kind: 'loading', label: t('roster.action.fetchingAll') });
      const refreshed = await api.profile.importFromSession({
        sessionId: login.sessionId,
        uid: token.uid
      });
      if (!canCommitProfileRequest(token, refreshed.uid)) {
        await restorePersistedActiveUid();
        return;
      }
      setProfile(refreshed);
      setLastRefresh(null);
      setStatus({ kind: 'success', message: t('roster.accountUpdated') });
      await onStateChange();
    } catch (error) {
      if (!canCommitProfileRequest(token)) return;
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
    if (status.kind === 'loading' || !activeUid || verifiedProfile?.uid !== activeUid) return;
    await api.profile.delete({ uid: activeUid });
    if (!mountedRef.current) return;
    await onStateChange();
    restoreRosterFocus();
  }

  function handleSelectCharacter(characterId: number, trigger: HTMLButtonElement) {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    }
    selectedTileRef.current = trigger;
    setSelectedCharacterId(characterId);
  }

  function handleDismissCharacter() {
    const trigger = selectedTileRef.current;
    selectedTileRef.current = null;
    setSelectedCharacterId(null);
    restoreRosterFocus(trigger);
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
    <section className="gta-roster-page roster-page">
      <div className="gta-roster-heading">
        <h2 className="gta-section-title">{t('roster.title')}</h2>
        {verifiedProfile && (
          <AccountMaintenanceMenu
            busy={status.kind === 'loading'}
            profile={verifiedProfile}
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

        {verifiedProfile && (
          <>
            <ProfileSummary
              profile={verifiedProfile}
              loading={status.kind === 'loading'}
              onRefresh={() => void handleRefresh()}
            />
            {verifiedProfile.characters.length === 0 ? (
              <div className="gta-roster-empty">
                <p>{t('roster.emptyProfile')}</p>
              </div>
            ) : (
              <>
                <RosterToolbar
                  query={query}
                  searchInputRef={searchInputRef}
                  filter={elementFilter}
                  sort={sortMode}
                  totalCount={verifiedProfile.characters.length}
                  filteredCount={filteredCharacters.length}
                  onQueryChange={setQuery}
                  onFilterChange={setElementFilter}
                  onSortChange={setSortMode}
                />
                {filteredCharacters.length === 0 ? (
                  <p className="gta-roster-no-results">{t('roster.noResults')}</p>
                ) : (
                  <div
                    ref={rosterGridRef}
                    className="roster-grid"
                    aria-label={t('roster.characterGrid')}
                    tabIndex={-1}
                  >
                    {sortedCharacters.map((character) => (
                      <CharacterTile
                        key={character.id}
                        character={character}
                        imageRevision={verifiedProfile.fetchedAt}
                        selected={character.id === selectedCharacterId}
                        onSelect={(trigger) => handleSelectCharacter(character.id, trigger)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
      {selectedCharacter && (
        <CharacterDetailDrawer
          character={selectedCharacter}
          imageRevision={verifiedProfile?.fetchedAt}
          onDismiss={handleDismissCharacter}
        />
      )}
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
