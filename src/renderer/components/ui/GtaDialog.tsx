import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

interface GtaDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  closeLabel: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export function GtaDialog({
  children,
  closeLabel,
  initialFocusRef,
  onClose,
  open,
  title
}: GtaDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const initialFocus = initialFocusRef?.current;
      const firstFocusable = getFocusable(dialog)[0];
      const target = initialFocus && dialog.contains(initialFocus) ? initialFocus : firstFocusable;
      (target ?? dialog).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusable(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const leavesFromStart = event.shiftKey && currentIndex <= 0;
      const leavesFromEnd = !event.shiftKey && currentIndex === focusable.length - 1;
      const focusIsOutside = currentIndex === -1;
      if (leavesFromStart || leavesFromEnd || focusIsOutside) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      openerRef.current = null;
    };
  }, [initialFocusRef, open]);

  if (!open) return null;

  return (
    <div className="gta-dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="gta-dialog gta-ornament-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gta-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="gta-corner gta-corner--tl" aria-hidden="true" />
        <span className="gta-corner gta-corner--br" aria-hidden="true" />
        <div className="gta-dialog-head">
          <h2 id="gta-dialog-title">{title}</h2>
          <button
            type="button"
            className="gta-icon-button"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="gta-dialog-body">{children}</div>
      </div>
    </div>
  );
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true'
  );
}
