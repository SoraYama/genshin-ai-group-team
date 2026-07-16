import { useEffect, useState } from 'react';
import { SettingsPage } from './pages/Settings/SettingsPage';
import { OnboardingPage } from './pages/Onboarding/OnboardingPage';
import { RosterPage } from './pages/Roster/RosterPage';
import { AdvisorPage } from './pages/Advisor/AdvisorPage';
import { HistoryPage } from './pages/History/HistoryPage';
import { useProfileState } from './hooks/useProfileState';
import { useI18n } from './i18n';

type View = 'roster' | 'advisor' | 'history' | 'onboarding' | 'settings';

const NAV_ITEMS = [
  { key: 'roster', label: 'app.nav.roster' },
  { key: 'advisor', label: 'app.nav.advisor' },
  { key: 'history', label: 'app.nav.history' },
  { key: 'onboarding', label: 'app.nav.onboarding' },
  { key: 'settings', label: 'app.nav.settings' }
] as const satisfies ReadonlyArray<{
  key: View;
  label:
    | 'app.nav.roster'
    | 'app.nav.advisor'
    | 'app.nav.history'
    | 'app.nav.onboarding'
    | 'app.nav.settings';
}>;

export default function App() {
  const { locale, setLocale, t } = useI18n();
  const { state, loading, refresh } = useProfileState();
  const [view, setView] = useState<View>('roster');
  const [hasInitialized, setHasInitialized] = useState(false);

  useEffect(() => {
    if (hasInitialized || loading || !state) {
      return;
    }
    setView(state.profiles.length === 0 ? 'onboarding' : 'roster');
    setHasInitialized(true);
  }, [hasInitialized, loading, state]);

  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      <div className="app-shell">
        <header className="gta-topbar">
          <div className="gta-brand">
            <span className="gta-brand-mark">Genshin Team Advisor</span>
            <span className="gta-brand-sub">LOCAL · BYOK</span>
          </div>
          <nav className="gta-nav" aria-label={t('app.navLabel')}>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={view === item.key ? 'is-active' : ''}
                onClick={() => setView(item.key)}
              >
                {t(item.label)}
              </button>
            ))}
            <label className="gta-language-select">
              <span className="sr-only">{t('app.language')}</span>
              <select
                aria-label={t('app.language')}
                value={locale}
                onChange={(event) => setLocale(event.target.value === 'en-US' ? 'en-US' : 'zh-CN')}
              >
                <option value="zh-CN">中文</option>
                <option value="en-US">English</option>
              </select>
            </label>
          </nav>
        </header>
        <main>
          {loading || !state ? (
            <p className="gta-hint gta-on-bg">{t('common.loading')}</p>
          ) : view === 'settings' ? (
            <SettingsPage />
          ) : view === 'onboarding' ? (
            <OnboardingPage
              onBound={async () => {
                await refresh();
                setView('roster');
              }}
            />
          ) : view === 'advisor' ? (
            <AdvisorPage state={state} onGotoOnboarding={() => setView('onboarding')} />
          ) : view === 'history' ? (
            <HistoryPage state={state} />
          ) : (
            <RosterPage
              state={state}
              onStateChange={refresh}
              onGotoOnboarding={() => setView('onboarding')}
            />
          )}
        </main>
      </div>
    </>
  );
}
