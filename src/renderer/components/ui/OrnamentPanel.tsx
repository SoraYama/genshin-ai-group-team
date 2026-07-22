import type { HTMLAttributes } from 'react';

export function OrnamentPanel({
  children,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={['gta-panel', 'gta-ornament-panel', className].filter(Boolean).join(' ')}
    >
      <span className="gta-corner gta-corner--tl" aria-hidden="true" />
      <span className="gta-corner gta-corner--tr" aria-hidden="true" />
      <span className="gta-corner gta-corner--bl" aria-hidden="true" />
      <span className="gta-corner gta-corner--br" aria-hidden="true" />
      {children}
    </div>
  );
}
