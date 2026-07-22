import { useEffect, useRef, type ReactNode } from 'react';

interface GtaDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  closeLabel: string;
  onClose: () => void;
}

export function GtaDialog({ children, closeLabel, onClose, open, title }: GtaDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="gta-dialog-backdrop" onMouseDown={onClose}>
      <div
        className="gta-dialog gta-ornament-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gta-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="gta-corner gta-corner--tl" aria-hidden="true" />
        <span className="gta-corner gta-corner--br" aria-hidden="true" />
        <div className="gta-dialog-head">
          <h2 id="gta-dialog-title">{title}</h2>
          <button
            ref={closeRef}
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
