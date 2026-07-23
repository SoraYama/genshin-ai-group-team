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
import {
  consumeHistoryRerun,
  historyRerunAfterNavigation,
  historyRerunForActiveUid
} from './pages/Advisor/history-rerun-state';

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

  useEffect(() => {
    setHistoryRerun((current) => historyRerunForActiveUid(current, state?.activeUid));
  }, [state?.activeUid]);

  const navigate = (nextView: AppView) => {
    setHistoryRerun((current) => historyRerunAfterNavigation(current, nextView));
    setView(nextView);
  };

  return (
    <AppShell activeUid={state?.activeUid} view={view} onNavigate={navigate}>
      {loading || !state ? (
        <p className="gta-hint gta-on-bg">{t('common.loading')}</p>
      ) : view === 'settings' ? (
        <SettingsPage onProfileDataChange={refresh} />
      ) : view === 'onboarding' ? (
        <OnboardingPage
          onBound={async () => {
            await refresh();
            navigate('roster');
          }}
          onCancel={state.profiles.length > 0 ? () => navigate('roster') : undefined}
        />
      ) : view === 'advisor' ? (
        <AdvisorPage
          state={state}
          historyRerun={historyRerun}
          onHistoryRerunConsumed={(historyId) =>
            setHistoryRerun((current) => consumeHistoryRerun(current, historyId))
          }
          onGotoOnboarding={() => navigate('onboarding')}
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
          onGotoOnboarding={() => navigate('onboarding')}
        />
      )}
    </AppShell>
  );
}
