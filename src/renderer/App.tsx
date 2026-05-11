import { useEffect, useState } from 'react';
import { SettingsPage } from './pages/Settings/SettingsPage';
import { OnboardingPage } from './pages/Onboarding/OnboardingPage';
import { RosterPage } from './pages/Roster/RosterPage';
import { AdvisorPage } from './pages/Advisor/AdvisorPage';
import { HistoryPage } from './pages/History/HistoryPage';
import { useProfileState } from './hooks/useProfileState';

type View = 'roster' | 'advisor' | 'history' | 'onboarding' | 'settings';

const NAV_ITEMS: Array<{ key: View; label: string }> = [
  { key: 'roster', label: '角色' },
  { key: 'advisor', label: '推荐' },
  { key: 'history', label: '历史' },
  { key: 'onboarding', label: '绑定' },
  { key: 'settings', label: '设置' }
];

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
    <>
      <div className="app-bg" aria-hidden="true" />
      <div className="app-shell">
        <header className="gta-topbar">
          <div className="gta-brand">
            <span className="gta-brand-mark">Genshin Team Advisor</span>
            <span className="gta-brand-sub">v0.5 · BYOK</span>
          </div>
          <nav className="gta-nav" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={view === item.key ? 'is-active' : ''}
                onClick={() => setView(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </header>
        <main>
          {loading || !state ? (
            <p className="gta-hint gta-on-bg">Loading…</p>
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
