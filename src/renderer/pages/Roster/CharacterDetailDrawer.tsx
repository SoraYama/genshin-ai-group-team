import { useEffect, useId, useRef } from 'react';
import type { CharacterProfile } from '../../../shared/domain';
import { useI18n } from '../../i18n';
import { CharacterCard } from './CharacterCard';

interface CharacterDetailDrawerProps {
  character: CharacterProfile;
  imageRevision?: string;
  onDismiss: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export function CharacterDetailDrawer({
  character,
  imageRevision,
  onDismiss
}: CharacterDetailDrawerProps) {
  const { t } = useI18n();
  const titleId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const rosterGrid = document.querySelector<HTMLElement>('.roster-grid');
    const previousShellOverflowY = shell?.style.overflowY;
    const previousGridOverflowY = rosterGrid?.style.overflowY;
    if (shell) shell.style.overflowY = 'hidden';
    if (rosterGrid) rosterGrid.style.overflowY = 'hidden';

    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      const drawer = drawerRef.current;
      if (!drawer) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismissRef.current();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = getVisibleFocusable(drawer);
        if (focusable.length === 0) {
          event.preventDefault();
          drawer.focus();
          return;
        }
        const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
        const leavingStart = event.shiftKey && activeIndex <= 0;
        const leavingEnd = !event.shiftKey && activeIndex === focusable.length - 1;
        if (activeIndex === -1 || leavingStart || leavingEnd) {
          event.preventDefault();
          focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      if (shell) shell.style.overflowY = previousShellOverflowY ?? '';
      if (rosterGrid) rosterGrid.style.overflowY = previousGridOverflowY ?? '';
    };
  }, [character.id]);

  return (
    <div
      className="character-detail-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <aside
        ref={drawerRef}
        id="character-detail-drawer"
        className="character-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="character-detail-drawer__header">
          <div>
            <span className="gta-kicker">{t('roster.completeness')}</span>
            <h2 id={titleId}>{t('roster.drawerTitle', { name: character.name })}</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="gta-icon-button"
            aria-label={t('app.close')}
            onClick={onDismiss}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="character-detail-drawer__scroll">
          <CharacterCard character={character} imageRevision={imageRevision} />
        </div>
      </aside>
    </div>
  );
}

function getVisibleFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return element.getClientRects().length > 0;
    }
  );
}
