import { useEffect, useRef, useState } from 'react';
import type { PersistedProfile } from '../../../shared/domain';
import { GtaDialog } from '../../components/ui/GtaDialog';
import { useI18n } from '../../i18n';

type DialogKind = 'logout' | 'delete' | null;

interface AccountMaintenanceMenuProps {
  busy: boolean;
  profile: PersistedProfile;
  onDelete: () => Promise<void>;
  onDiagnose: () => Promise<void>;
  onGotoOnboarding: () => void;
  onLogout: () => Promise<void>;
  onRelogin: () => Promise<void>;
}

export function AccountMaintenanceMenu({
  busy,
  onDelete,
  onDiagnose,
  onGotoOnboarding,
  onLogout,
  onRelogin,
  profile
}: AccountMaintenanceMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const openMenu = () => {
    setOpen(true);
    requestAnimationFrame(() => getItems(menuRef.current)[0]?.focus());
  };
  const runMenuAction = (action: () => void | Promise<void>) => {
    closeMenu();
    void action();
  };
  const openDialog = (kind: Exclude<DialogKind, null>) => {
    closeMenu();
    setDialog(kind);
  };

  return (
    <>
      <div className="gta-maintenance" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          className="gta-maintenance-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            openMenu();
          }}
        >
          {t('roster.maintenance')}
          <span aria-hidden="true">⌄</span>
        </button>
        {open && (
          <div
            className="gta-maintenance-menu"
            ref={menuRef}
            role="menu"
            aria-label={t('roster.maintenance')}
            onKeyDown={(event) =>
              handleMenuKey(
                event,
                menuRef.current,
                () => closeMenu(true),
                (direction) => {
                  setOpen(false);
                  focusOutsideMenu(triggerRef.current, menuRef.current, direction);
                }
              )
            }
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={busy}
              onClick={() => runMenuAction(onRelogin)}
            >
              {t('roster.maintenance.relogin')}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={busy}
              onClick={() => runMenuAction(onDiagnose)}
            >
              {t('roster.maintenance.diagnose')}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={busy}
              onClick={() => openDialog('logout')}
            >
              {t('roster.maintenance.logout')}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => runMenuAction(onGotoOnboarding)}
            >
              {t('roster.maintenance.bindUid')}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="is-danger"
              onClick={() => openDialog('delete')}
            >
              {t('roster.maintenance.delete')}
            </button>
          </div>
        )}
      </div>

      <GtaDialog
        open={dialog === 'logout'}
        title={t('roster.logoutDialog.title')}
        closeLabel={t('app.close')}
        initialFocusRef={cancelRef}
        onClose={() => setDialog(null)}
      >
        <p>{t('roster.logoutDialog.body')}</p>
        <div className="gta-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="gta-btn gta-btn--ghost"
            onClick={() => setDialog(null)}
          >
            {t('common.keepAndReturn')}
          </button>
          <button
            type="button"
            className="gta-btn gta-btn--danger"
            onClick={() => {
              setDialog(null);
              void onLogout();
            }}
          >
            {t('roster.logoutDialog.action')}
          </button>
        </div>
      </GtaDialog>

      <GtaDialog
        open={dialog === 'delete'}
        title={t('roster.deleteDialog.title', { nickname: profile.nickname ?? profile.uid })}
        closeLabel={t('app.close')}
        initialFocusRef={cancelRef}
        onClose={() => setDialog(null)}
      >
        <p>{t('roster.deleteDialog.target', { uid: profile.uid })}</p>
        <p>{t('roster.deleteDialog.body')}</p>
        <p className="gta-error">{t('roster.deleteDialog.irreversible')}</p>
        <div className="gta-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="gta-btn gta-btn--ghost"
            onClick={() => setDialog(null)}
          >
            {t('common.keepAndReturn')}
          </button>
          <button
            type="button"
            className="gta-btn gta-btn--danger"
            onClick={() => {
              setDialog(null);
              void onDelete();
            }}
          >
            {t('roster.deleteDialog.action', { nickname: profile.nickname ?? profile.uid })}
          </button>
        </div>
      </GtaDialog>
    </>
  );
}

function getItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return menu
    ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'))
    : [];
}

function handleMenuKey(
  event: React.KeyboardEvent<HTMLDivElement>,
  menu: HTMLElement | null,
  close: () => void,
  moveOutside: (direction: -1 | 1) => void
) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    moveOutside(event.shiftKey ? -1 : 1);
    return;
  }
  const items = getItems(menu);
  const index = items.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  let next: number | undefined;
  if (event.key === 'ArrowDown') next = (index + 1) % items.length;
  if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = items.length - 1;
  if (next === undefined) return;
  event.preventDefault();
  items[next]?.focus();
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
  requestAnimationFrame(() => focusable[triggerIndex + direction]?.focus());
}
