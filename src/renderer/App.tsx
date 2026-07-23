import { useEffect, useState } from 'react';
import { SettingsPage } from './pages/Settings/SettingsPage';
import { OnboardingPage } from './pages/Onboarding/OnboardingPage';
import { RosterPage } from './pages/Roster/RosterPage';
import { AdvisorPage } from './pages/Advisor/AdvisorPage';
import { HistoryPage } from './pages/History/HistoryPage';
import { useProfileState } from './hooks/useProfileState';
import { useI18n } from './i18n';
import { AppShell, type AppView } from './components/AppShell';
import type { HistoryRerunIntent } from './pages/History/history-presentation';

export default function App() {
  const { t } = useI18n();
  const { state, loading, refresh } = useProfileState();
  const [view, setView] = useState<AppView>('roster');
  const [hasInitialized, setHasInitialized] = useState(false);
  const [historyRerun, setHistoryRerun] = useState<HistoryRerunIntent | null>(null);

  useEffect(() => {
    if (hasInitialized || loading || !state) {
      return;
    }
    setView(state.profiles.length === 0 ? 'onboarding' : 'roster');
    setHasInitialized(true);
  }, [hasInitialized, loading, state]);

  return (
    <AppShell activeUid={state?.activeUid} view={view} onNavigate={setView}>
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
          onCancel={state.profiles.length > 0 ? () => setView('roster') : undefined}
        />
      ) : view === 'advisor' ? (
        <AdvisorPage
          state={state}
          historyRerun={historyRerun}
          onGotoOnboarding={() => setView('onboarding')}
        />
      ) : view === 'history' ? (
        <HistoryPage
          state={state}
          onRerun={(intent) => {
            setHistoryRerun(intent);
            setView('advisor');
          }}
        />
      ) : (
        <RosterPage
          state={state}
          onStateChange={refresh}
          onGotoOnboarding={() => setView('onboarding')}
        />
      )}
    </AppShell>
  );
}
