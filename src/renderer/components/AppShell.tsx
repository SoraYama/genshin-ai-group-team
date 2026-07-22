import { useEffect, useRef, useState, type ReactNode } from 'react';
import appBackground from '../../../resources/backgrounds/app-global.webp';
import appBackground2x from '../../../resources/backgrounds/app-global@2x.webp';
import { useI18n } from '../i18n';
import { GtaDialog } from './ui/GtaDialog';

export type AppView = 'roster' | 'advisor' | 'history' | 'onboarding' | 'settings';

interface AppShellProps {
  activeUid?: string;
  children: ReactNode;
  view: AppView;
  onNavigate: (view: AppView) => void;
}

const NAV_ITEMS = [
  { key: 'roster', label: 'app.nav.roster' },
  { key: 'advisor', label: 'app.nav.advisor' },
  { key: 'history', label: 'app.nav.history' }
] as const;

export function AppShell({ activeUid, children, onNavigate, view }: AppShellProps) {
  const { locale, setLocale, t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const menuRootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  const closeMenu = (restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!menuOpen) return;
    firstItemRef.current?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const navigateFromMenu = (next: AppView) => {
    onNavigate(next);
    closeMenu();
  };

  return (
    <>
      <div
        className="app-bg"
        style={{
          backgroundImage: `linear-gradient(180deg, rgba(6, 14, 24, 0.2), rgba(4, 10, 18, 0.82)), image-set(url("${appBackground}") 1x, url("${appBackground2x}") 2x)`
        }}
        aria-hidden="true"
      />
      <div className="app-shell">
        <header className="gta-topbar">
          <button type="button" className="gta-brand" onClick={() => onNavigate('roster')}>
            <span className="gta-brand-emblem" aria-hidden="true">
              ✦
            </span>
            <span>
              <strong className="gta-brand-mark">{t('app.brand')}</strong>
              <small className="gta-brand-sub">{t('app.brandSub')}</small>
            </span>
          </button>

          <nav className="gta-nav" aria-label={t('app.navLabel')}>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={view === item.key ? 'is-active' : ''}
                aria-current={view === item.key ? 'page' : undefined}
                onClick={() => onNavigate(item.key)}
              >
                {t(item.label)}
              </button>
            ))}
          </nav>

          <div className="gta-account" ref={menuRootRef}>
            <button
              ref={triggerRef}
              type="button"
              className="gta-account-trigger"
              aria-label={t('app.accountMenu')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="gta-account-mark" aria-hidden="true">
                ◇
              </span>
              <span className="gta-account-copy">
                <strong>{t('app.account')}</strong>
                <small>{activeUid ? `UID ${activeUid}` : t('app.noProfile')}</small>
              </span>
              <span className="gta-account-caret" aria-hidden="true">
                ⌄
              </span>
            </button>

            {menuOpen && (
              <div className="gta-account-menu" role="menu" aria-label={t('app.accountMenu')}>
                <div className="gta-account-menu-head">
                  <span>{t('app.localProfile')}</span>
                  <strong>{activeUid ? `UID ${activeUid}` : t('app.notConnected')}</strong>
                </div>
                <button
                  ref={firstItemRef}
                  type="button"
                  role="menuitem"
                  onClick={() => navigateFromMenu('onboarding')}
                >
                  {t('app.profileBinding')}
                </button>
                <button type="button" role="menuitem" onClick={() => navigateFromMenu('settings')}>
                  {t('app.nav.settings')}
                </button>
                <div className="gta-account-language" role="none">
                  <label htmlFor="gta-language">{t('app.language')}</label>
                  <select
                    id="gta-language"
                    aria-label={t('app.language')}
                    value={locale}
                    onChange={(event) =>
                      setLocale(event.target.value === 'en-US' ? 'en-US' : 'zh-CN')
                    }
                  >
                    <option value="zh-CN">中文</option>
                    <option value="en-US">English</option>
                  </select>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    setAboutOpen(true);
                  }}
                >
                  {t('app.about')}
                </button>
              </div>
            )}
          </div>
        </header>
        <main>{children}</main>
      </div>

      <GtaDialog
        open={aboutOpen}
        title={t('app.aboutTitle')}
        closeLabel={t('app.close')}
        onClose={() => setAboutOpen(false)}
      >
        <p>{t('app.aboutBody')}</p>
        <p className="gta-hint">{t('app.aboutPrivacy')}</p>
      </GtaDialog>
    </>
  );
}
