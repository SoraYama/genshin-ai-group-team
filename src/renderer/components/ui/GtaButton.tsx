import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface GtaButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'primary' | 'ghost' | 'danger';
  icon?: ReactNode;
}

export function GtaButton({
  children,
  className = '',
  icon,
  tone = 'primary',
  type = 'button',
  ...props
}: GtaButtonProps) {
  const toneClass =
    tone === 'ghost' ? 'gta-btn--ghost' : tone === 'danger' ? 'gta-btn--danger' : '';
  return (
    <button
      {...props}
      type={type}
      className={['gta-btn', toneClass, className].filter(Boolean).join(' ')}
    >
      {icon && <span className="gta-btn-icon">{icon}</span>}
      {children}
    </button>
  );
}
