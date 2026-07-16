import { useCallback, useEffect, useState } from 'react';
import { api } from '../../ipc';
import type {
  CharacterProfile,
  PersistedProfile,
  ProfileStateView,
  RefreshSummary
} from '../../../shared/domain';
import { ButtonGlyph, ElementIcon, PortraitFallback, StarIcon } from '../../design/Icons';
import { normalizeElement } from '../../design/tokens';
import { localizeError, useI18n } from '../../i18n';

interface RosterPageProps {
  state: ProfileStateView;
  onStateChange: () => Promise<void>;
  onGotoOnboarding: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; label?: string }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

function formatTime(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function RosterPage({ state, onStateChange, onGotoOnboarding }: RosterPageProps) {
  const { locale, t } = useI18n();
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [lastRefresh, setLastRefresh] = useState<RefreshSummary | null>(null);
  const [authHasCookie, setAuthHasCookie] = useState<boolean>(false);

  const activeUid = state.activeUid;

  const refreshAuthState = useCallback(async () => {
    try {
      const auth = await api.miyoushe.authState();
      setAuthHasCookie(auth.hasCookie);
    } catch {
      setAuthHasCookie(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuthState();
  }, [refreshAuthState]);

  const loadProfile = useCallback(async (uid: string) => {
    setStatus({ kind: 'loading' });
    try {
      const next = await api.profile.get({ uid });
      setProfile(next);
      setStatus({ kind: 'idle' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: localizeError(error, locale, t, 'roster.error.load')
      });
    }
  }, [locale, t]);

  useEffect(() => {
    if (!activeUid) {
      setProfile(null);
      return;
    }
    void loadProfile(activeUid);
  }, [activeUid, loadProfile]);

  async function handleSetActive(uid: string) {
    await api.profile.setActive({ uid });
    await onStateChange();
  }

  async function handleRefresh() {
    if (!activeUid) {
      return;
    }
    setStatus({ kind: 'loading', label: t('roster.action.refreshing') });
    try {
      const outcome = await api.profile.refresh({ uid: activeUid });
      setProfile(outcome.profile);
      setLastRefresh(outcome.summary);
      setStatus({ kind: 'idle' });
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
              : (locale === 'zh-CN' ? login.message : undefined) ??
                t('roster.error.login', { reason: login.reason })
        });
        return;
      }
      const match = login.bind.roles.find((r) => r.gameUid === activeUid);
      if (!match) {
        setStatus({
          kind: 'error',
          message: t('roster.error.uidMismatch')
        });
        return;
      }
      setStatus({ kind: 'loading', label: t('roster.action.fetchingAll') });
      const refreshed = await api.profile.importFromSession({
        sessionId: login.sessionId,
        uid: activeUid
      });
      setProfile(refreshed);
      setLastRefresh({
        enka: refreshed.characters.some((c) => c.source !== 'miyoushe') ? 'ok' : 'failed',
        enkaCharacterCount: refreshed.characters.filter((c) => c.source !== 'miyoushe').length,
        miyoushe: 'ok',
        miyousheCharacterCount: refreshed.characters.filter(
          (c) => c.source === 'miyoushe' || c.source === 'merged'
        ).length,
        totalCharacterCount: refreshed.characters.length
      });
      setStatus({ kind: 'idle' });
      await onStateChange();
      await refreshAuthState();
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
      setStatus({ kind: 'idle' });
      await refreshAuthState();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: localizeError(error, locale, t, 'roster.error.logout')
      });
    }
  }

  async function handlePing() {
    if (!activeUid) return;
    setStatus({ kind: 'loading', label: t('roster.action.testing') });
    try {
      const result = await api.miyoushe.ping({ uid: activeUid });
      if (result.ok) {
        setStatus({
          kind: 'success',
          message: t('roster.ping.ok', {
            nickname: result.nickname ?? '?',
            level: result.worldLevel ?? '?',
            count: result.totalCharacters ?? '?'
          })
        });
      } else {
        setStatus({
          kind: 'error',
          message: t('roster.ping.failed', {
            reason: result.reason,
            retcode: result.retcode !== undefined ? ` (retcode=${result.retcode})` : ''
          })
        });
      }
    } catch (error) {
      setStatus({
        kind: 'error',
        message: localizeError(error, locale, t, 'roster.error.test')
      });
    }
  }

  async function handleDelete(uid: string) {
    await api.profile.delete({ uid });
    await onStateChange();
  }

  if (state.profiles.length === 0) {
    return (
      <section>
        <h2 className="gta-section-title">
          {t('roster.title')}
          <span className="gta-section-sub">ROSTER</span>
        </h2>
        <div className="gta-panel">
          <div className="gta-panel-body">
            <p className="gta-hint">{t('roster.emptyAccounts')}</p>
            <div className="gta-actions">
              <button type="button" className="gta-btn" onClick={onGotoOnboarding}>
                <span className="gta-btn-icon">
                  <ButtonGlyph name="plus" />
                </span>
                {t('roster.gotoBind')}
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="gta-section-title">
        {t('roster.title')}
        <span className="gta-section-sub">ROSTER</span>
      </h2>

      <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
        <div className="gta-panel-body">
          <div className="gta-uid-tabs">
            {state.profiles.map((item) => {
              const isActive = item.uid === activeUid;
              return (
                <button
                  key={item.uid}
                  type="button"
                  className={isActive ? 'gta-uid-tab is-active' : 'gta-uid-tab'}
                  onClick={() => void handleSetActive(item.uid)}
                >
                  <span className="uid">UID {item.uid}</span>
                  <span className="nickname">{item.nickname ?? '—'}</span>
                  <span className="count">
                    {t('roster.characters', { count: item.characterCount })}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {status.kind === 'error' && <p className="gta-error">{status.message}</p>}
      {status.kind === 'success' && <p className="gta-hint">{status.message}</p>}
      {status.kind === 'loading' && status.label && (
        <p className="gta-hint">{status.label}</p>
      )}
      {lastRefresh && status.kind === 'idle' && (
        <RefreshBanner summary={lastRefresh} onRelogin={() => void handleReloginAndRefresh()} />
      )}

      {profile && (
        <>
          <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
            <div className="gta-panel-body">
              <div className="gta-profile-row">
                <dl className="gta-meta-grid" style={{ margin: 0 }}>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">UID</dt>
                    <dd className="gta-meta-value is-mono" style={{ margin: 0 }}>
                      {profile.uid}
                    </dd>
                  </div>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">{t('roster.nickname')}</dt>
                    <dd className="gta-meta-value" style={{ margin: 0 }}>
                      {profile.nickname ?? '—'}
                    </dd>
                  </div>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">{t('roster.worldLevel')}</dt>
                    <dd className="gta-meta-value is-mono" style={{ margin: 0 }}>
                      {profile.level ?? '—'}
                    </dd>
                  </div>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">{t('roster.source')}</dt>
                    <dd className="gta-meta-value" style={{ margin: 0 }}>
                      {sourceLabel(profile.source, t)}
                    </dd>
                  </div>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">{t('roster.refreshedAt')}</dt>
                    <dd className="gta-meta-value is-mono" style={{ margin: 0 }}>
                      {formatTime(profile.fetchedAt)}
                    </dd>
                  </div>
                  <div className="gta-meta-cell" data-testid="profile-coverage-summary">
                    <dt className="gta-meta-label">{t('roster.completeness')}</dt>
                    <dd className="gta-meta-value" style={{ margin: 0 }}>
                      {profile.coverage.partial ? t('roster.partial') : t('roster.complete')}
                    </dd>
                    <span className="gta-meta-detail">
                      {t('roster.coverage', {
                        owned: profile.coverage.ownedCount,
                        expected:
                          profile.coverage.expectedOwnedCount !== undefined
                            ? ` / ${profile.coverage.expectedOwnedCount}`
                            : '',
                        detailed: profile.coverage.detailedCount
                      })}
                    </span>
                  </div>
                </dl>
                <div className="gta-actions">
                  <button
                    type="button"
                    className="gta-btn"
                    onClick={() => void handleRefresh()}
                    disabled={!activeUid || status.kind === 'loading'}
                  >
                    <span className="gta-btn-icon">
                      <ButtonGlyph name="refresh" />
                    </span>
                    {status.kind === 'loading' ? t('roster.refreshing') : t('roster.refresh')}
                  </button>
                  <button
                    type="button"
                    className="gta-btn gta-btn--ghost"
                    onClick={() => void handleReloginAndRefresh()}
                    disabled={!activeUid || status.kind === 'loading'}
                    title={t('roster.loginTitle')}
                  >
                    <span className="gta-btn-icon">
                      <ButtonGlyph name="refresh" />
                    </span>
                    {authHasCookie ? t('roster.switchAccount') : t('roster.login')}
                  </button>
                  {authHasCookie && (
                    <>
                      <button
                        type="button"
                        className="gta-btn gta-btn--ghost"
                        onClick={() => void handlePing()}
                        disabled={status.kind === 'loading'}
                        title={t('roster.pingTitle')}
                      >
                        {t('roster.ping')}
                      </button>
                      <button
                        type="button"
                        className="gta-btn gta-btn--ghost"
                        onClick={() => void handleLogout()}
                        disabled={status.kind === 'loading'}
                        title={t('roster.logoutTitle')}
                      >
                        {t('roster.logout')}
                      </button>
                    </>
                  )}
                  <button type="button" className="gta-btn gta-btn--ghost" onClick={onGotoOnboarding}>
                    {t('roster.bindNew')}
                  </button>
                  <button
                    type="button"
                    className="gta-btn gta-btn--danger"
                    onClick={() => void handleDelete(profile.uid)}
                  >
                    <span className="gta-btn-icon">
                      <ButtonGlyph name="trash" />
                    </span>
                    {t('roster.deleteCache')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {profile.characters.length === 0 ? (
            <div className="gta-panel">
              <div className="gta-panel-body">
                <p className="gta-hint">
                  {t('roster.emptyProfile')}
                </p>
              </div>
            </div>
          ) : (
            <div className="gta-grid">
              {profile.characters.map((character) => (
                <CharacterCard key={character.id} character={character} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface CharacterCardProps {
  character: CharacterProfile;
}

function CharacterCard({ character }: CharacterCardProps) {
  const { t } = useI18n();
  const element = normalizeElement(character.element);
  const stars = Math.max(1, Math.min(5, character.rarity));
  const stats = character.build?.stats;
  const completenessLabel = {
    basic: t('roster.basic'),
    build: t('roster.build'),
    detailed: t('roster.detailed')
  }[character.completeness];
  return (
    <article className={`gta-card r${stars}`}>
      <div className="gta-card-head">
        <div className="gta-portrait">
          <div className="gta-portrait-frame">
            {character.imageUrl ? (
              <img src={character.imageUrl} alt={character.name} loading="lazy" />
            ) : (
              <PortraitFallback />
            )}
          </div>
          <div className="gta-portrait-element">
            <ElementIcon element={element} size={18} />
          </div>
        </div>
        <div className="gta-identity">
          <h3 className="gta-name">{character.name}</h3>
          <div className="gta-rank-row">
            <span className={stars === 5 ? 'gta-rank-stars r5' : 'gta-rank-stars'}>
              {Array.from({ length: stars }).map((_, i) => (
                <StarIcon key={i} />
              ))}
            </span>
            <span className="gta-level">
              Lv <span className="num">{character.level ?? t('common.unknown')}</span>
            </span>
          </div>
          <span
            className="gta-tag"
            title={t('roster.missing', {
              fields: character.missingFields.join(', ') || t('common.none')
            })}
          >
            {completenessLabel}
          </span>
        </div>
      </div>
      <div className="gta-card-divider" />
      <dl className="gta-stats">
        <Stat label={t('roster.atk')} value={stats?.atk} />
        <Stat label={t('roster.hp')} value={stats?.hp} />
        <Stat label={t('roster.def')} value={stats?.def} />
        <Stat label={t('roster.critRate')} value={stats?.critRate} suffix="%" />
        <Stat label={t('roster.critDmg')} value={stats?.critDmg} suffix="%" />
        <Stat label={t('roster.energyRecharge')} value={stats?.energyRecharge} suffix="%" />
        <Stat label={t('roster.elementalMastery')} value={stats?.elementalMastery} />
      </dl>
      <div className="gta-build-summary">
        <BuildLine
          label={t('roster.weapon')}
          value={
            character.build?.weapon
              ? `${character.build.weapon.name} · Lv ${character.build.weapon.level} · ${t('roster.refinement', { level: character.build.weapon.refinement })}`
              : t('common.unknown')
          }
        />
        <BuildLine
          label={t('roster.talents')}
          value={
            character.build?.talents
              ? `${character.build.talents.normalAttack} / ${character.build.talents.elementalSkill} / ${character.build.talents.elementalBurst}`
              : t('common.unknown')
          }
        />
        <BuildLine label={t('roster.artifacts')} value={formatArtifactSummary(character, t)} />
      </div>
    </article>
  );
}

function BuildLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="gta-build-line">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function formatArtifactSummary(
  character: CharacterProfile,
  t: ReturnType<typeof useI18n>['t']
): string {
  const artifacts = character.build?.artifacts;
  if (!artifacts || artifacts.length === 0) return t('common.unknown');
  const sets = new Map<string, number>();
  for (const artifact of artifacts) {
    sets.set(artifact.setName, (sets.get(artifact.setName) ?? 0) + 1);
  }
  const setSummary = [...sets.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(' · ');
  return t('roster.artifactCount', {
    count: artifacts.length,
    sets: setSummary ? ` · ${setSummary}` : ''
  });
}

function Stat({ label, value, suffix }: { label: string; value?: number; suffix?: string }) {
  const { t } = useI18n();
  return (
    <div className="gta-stat">
      <dt className="gta-stat-label">{label}</dt>
      <dd className="gta-stat-value" style={{ margin: 0 }}>
        {value ?? t('common.unknown')}
        {value !== undefined && suffix && <span className="pct">{suffix}</span>}
      </dd>
    </div>
  );
}

interface RefreshBannerProps {
  summary: RefreshSummary;
  onRelogin: () => void;
}

function RefreshBanner({ summary, onRelogin }: RefreshBannerProps) {
  const { locale, t } = useI18n();
  const needsRelogin =
    summary.miyoushe === 'no-cookie' || summary.miyoushe === 'auth-expired';
  return (
    <div
      className="gta-panel"
      style={{ marginBottom: 'var(--gta-s4)', borderColor: 'var(--gta-accent-soft)' }}
    >
      <div className="gta-panel-body" style={{ paddingTop: 'var(--gta-s3)', paddingBottom: 'var(--gta-s3)' }}>
        <div className="gta-meta-grid" style={{ margin: 0 }}>
          <div className="gta-meta-cell">
            <dt className="gta-meta-label">{t('roster.refresh.miyoushe')}</dt>
            <dd className="gta-meta-value" style={{ margin: 0 }}>
              {refreshStatusLabel(summary.miyoushe, t, true)}
              {summary.miyoushe === 'ok' && (
                <span className="gta-mono">
                  {t('roster.refresh.count', { count: summary.miyousheCharacterCount })}
                </span>
              )}
            </dd>
            {summary.miyousheError && summary.miyoushe !== 'ok' && (
              <p className="gta-hint" style={{ marginTop: 4 }}>
                {locale === 'en-US' && /[\u3400-\u9fff]/u.test(summary.miyousheError)
                  ? t('common.error.upstream')
                  : summary.miyousheError}
              </p>
            )}
          </div>
          <div className="gta-meta-cell">
            <dt className="gta-meta-label">{t('roster.refresh.enka')}</dt>
            <dd className="gta-meta-value" style={{ margin: 0 }}>
              {refreshStatusLabel(summary.enka, t, false)}
              {summary.enka === 'ok' && (
                <span className="gta-mono">
                  {t('roster.refresh.count', { count: summary.enkaCharacterCount })}
                </span>
              )}
            </dd>
            {summary.enkaError && summary.enka !== 'ok' && (
              <p className="gta-hint" style={{ marginTop: 4 }}>
                {locale === 'en-US' && /[\u3400-\u9fff]/u.test(summary.enkaError)
                  ? t('common.error.upstream')
                  : summary.enkaError}
              </p>
            )}
          </div>
          <div className="gta-meta-cell">
            <dt className="gta-meta-label">{t('roster.refresh.merged')}</dt>
            <dd className="gta-meta-value is-mono" style={{ margin: 0 }}>
              {summary.totalCharacterCount}
            </dd>
          </div>
        </div>
        {needsRelogin && (
          <div className="gta-actions" style={{ marginTop: 'var(--gta-s3)' }}>
            <p className="gta-hint" style={{ margin: 0, flex: 1 }}>
              {summary.miyoushe === 'no-cookie'
                ? t('roster.refresh.noCookie')
                : t('roster.refresh.expired')}
            </p>
            <button
              type="button"
              className="gta-btn"
              onClick={onRelogin}
            >
              <span className="gta-btn-icon">
                <ButtonGlyph name="refresh" />
              </span>
              {t('roster.relogin')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function sourceLabel(
  source: PersistedProfile['source'],
  t: ReturnType<typeof useI18n>['t']
): string {
  return {
    miyoushe: t('roster.source.miyoushe'),
    'miyoushe+enka': t('roster.source.miyousheEnka'),
    enka: t('roster.source.enka'),
    merged: t('roster.source.merged'),
    'miyoushe-stale': t('roster.source.stale')
  }[source];
}

function refreshStatusLabel(
  status: RefreshSummary['miyoushe'],
  t: ReturnType<typeof useI18n>['t'],
  isMiyoushe: boolean
): string {
  if (!isMiyoushe && !['ok', 'failed', 'skipped'].includes(status)) return '—';
  return {
    ok: t('roster.status.ok'),
    failed: t('roster.status.failed'),
    skipped: t('roster.status.skipped'),
    'no-cookie': t('roster.status.noCookie'),
    'auth-expired': t('roster.status.authExpired'),
    'captcha-required': t('roster.status.captcha'),
    'rate-limited': t('roster.status.rateLimited')
  }[status];
}
