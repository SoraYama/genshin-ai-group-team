import type { PersistedProfile } from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';
import { useI18n } from '../../i18n';

interface ProfileSummaryProps {
  loading: boolean;
  profile: PersistedProfile;
  onRefresh: () => void;
}

export function ProfileSummary({ loading, onRefresh, profile }: ProfileSummaryProps) {
  const { locale, t } = useI18n();
  return (
    <section className="gta-profile-summary" aria-labelledby="current-profile-title">
      <div className="gta-profile-summary-account">
        <span className="gta-kicker">{t('roster.currentAccount')}</span>
        <h3 id="current-profile-title">{profile.nickname ?? t('roster.unnamedAccount')}</h3>
        <p>
          <span className="gta-mono">UID {profile.uid}</span>
          <span aria-hidden="true"> · </span>
          {t('roster.adventureRankValue', { level: profile.level ?? '—' })}
        </p>
      </div>
      <div className="gta-profile-summary-status" data-testid="profile-coverage-summary">
        <strong>
          {t('roster.coveragePlayer', {
            owned: profile.coverage.ownedCount,
            detailed: profile.coverage.detailedCount
          })}
        </strong>
        <p>{nextStep(profile, t)}</p>
        <details>
          <summary>{t('roster.dataDetails')}</summary>
          <p>{t('roster.dataDetailsBody')}</p>
        </details>
      </div>
      <div className="gta-profile-summary-action">
        <span>{t('roster.updatedAt', { date: formatTime(profile.fetchedAt, locale) })}</span>
        <button type="button" className="gta-btn" disabled={loading} onClick={onRefresh}>
          <span className="gta-btn-icon">
            <ButtonGlyph name="refresh" />
          </span>
          {loading ? t('roster.refreshing') : t('roster.updateProfile')}
        </button>
      </div>
    </section>
  );
}

function formatTime(iso: string, locale: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function nextStep(profile: PersistedProfile, t: ReturnType<typeof useI18n>['t']): string {
  if (profile.coverage.detailedCount === 0) return t('roster.nextStep.showcase');
  if (profile.coverage.partial) return t('roster.nextStep.update');
  return t('roster.nextStep.ready');
}
