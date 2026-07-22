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
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requestedMenuFocusRef = useRef<'first' | 'last'>('first');

  const closeMenu = (restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = (focus: 'first' | 'last' = 'first') => {
    requestedMenuFocusRef.current = focus;
    setMenuOpen(true);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const menuItems = getMenuItems(menuRef.current);
    menuItems[requestedMenuFocusRef.current === 'last' ? menuItems.length - 1 : 0]?.focus();
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

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    openMenu('first');
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      setMenuOpen(false);
      focusOutsideMenu(triggerRef.current, menuRef.current, event.shiftKey ? -1 : 1);
      return;
    }

    const menuItems = getMenuItems(menuRef.current);
    const currentItem = (event.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
    const currentIndex = currentItem ? menuItems.indexOf(currentItem) : -1;
    if (currentIndex === -1) return;

    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % menuItems.length;
    if (event.key === 'ArrowUp')
      nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = menuItems.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    menuItems[nextIndex]?.focus();
  };

  const openAbout = () => {
    setMenuOpen(false);
    triggerRef.current?.focus();
    setAboutOpen(true);
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
              onClick={() => (menuOpen ? closeMenu() : openMenu('first'))}
              onKeyDown={handleTriggerKeyDown}
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
              <div
                ref={menuRef}
                className="gta-account-menu"
                role="menu"
                aria-label={t('app.accountMenu')}
                onKeyDown={handleMenuKeyDown}
              >
                <div className="gta-account-menu-head">
                  <span>{t('app.localProfile')}</span>
                  <strong>{activeUid ? `UID ${activeUid}` : t('app.notConnected')}</strong>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => navigateFromMenu('onboarding')}
                >
                  {t('app.profileBinding')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => navigateFromMenu('settings')}
                >
                  {t('app.nav.settings')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN');
                    closeMenu();
                  }}
                >
                  {t('app.languageSwitch', {
                    language: locale === 'zh-CN' ? t('app.language.zh') : t('app.language.en')
                  })}
                </button>
                <button type="button" role="menuitem" tabIndex={-1} onClick={openAbout}>
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

function getMenuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
}

function focusOutsideMenu(
  trigger: HTMLElement | null,
  menu: HTMLElement | null,
  direction: -1 | 1
) {
  if (!trigger) return;
  const focusable = Array.from(
    document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !menu?.contains(element));
  const triggerIndex = focusable.indexOf(trigger);
  const target = focusable[triggerIndex + direction];
  requestAnimationFrame(() => target?.focus());
}
