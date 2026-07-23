import { EmptyState } from '../../components/ui/EmptyState';
import { settingsLoadPresentation } from './settings-presentation';

export function SettingsLoadState({
  failure,
  isEnglish,
  onRetry
}: {
  failure: string;
  isEnglish: boolean;
  onRetry: () => void;
}) {
  const presentation = settingsLoadPresentation(failure, isEnglish ? 'en' : 'zh');
  if (presentation.state === 'loading')
    return <p className="gta-hint gta-on-bg">{presentation.loadingLabel}</p>;
  return (
    <section className="gta-settings-page" role="alert">
      <EmptyState
        kind="offline"
        locale={isEnglish ? 'en' : 'zh'}
        action={
          <button type="button" className="gta-btn" onClick={onRetry}>
            {presentation.retryLabel}
          </button>
        }
      />
      <p className="gta-error">{failure}</p>
    </section>
  );
}
