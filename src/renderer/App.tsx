import { useEffect, useState } from 'react';
import { SettingsPage } from './pages/Settings/SettingsPage';
import { OnboardingPage } from './pages/Onboarding/OnboardingPage';
import { RosterPage } from './pages/Roster/RosterPage';
import { AdvisorPage } from './pages/Advisor/AdvisorPage';
import { HistoryPage } from './pages/History/HistoryPage';
import { useProfileState } from './hooks/useProfileState';

type View = 'roster' | 'advisor' | 'history' | 'onboarding' | 'settings';

export default function App() {
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
    <div className="app-shell">
      <header className="app-header">
        <h1>Genshin Team Advisor</h1>
        <nav className="app-nav">
          <button
            type="button"
            className={view === 'roster' ? 'nav-active' : ''}
            onClick={() => setView('roster')}
          >
            角色
          </button>
          <button
            type="button"
            className={view === 'advisor' ? 'nav-active' : ''}
            onClick={() => setView('advisor')}
          >
            推荐
          </button>
          <button
            type="button"
            className={view === 'history' ? 'nav-active' : ''}
            onClick={() => setView('history')}
          >
            历史
          </button>
          <button
            type="button"
            className={view === 'onboarding' ? 'nav-active' : ''}
            onClick={() => setView('onboarding')}
          >
            绑定
          </button>
          <button
            type="button"
            className={view === 'settings' ? 'nav-active' : ''}
            onClick={() => setView('settings')}
          >
            设置
          </button>
        </nav>
      </header>
      <main>
        {loading || !state ? (
          <p>Loading…</p>
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
  );
}
