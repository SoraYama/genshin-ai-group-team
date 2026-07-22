import type { ReactNode } from 'react';

interface StatusStripItem {
  label: string;
  value: ReactNode;
}

export function StatusStrip({ items }: { items: StatusStripItem[] }) {
  return (
    <dl className="gta-status-strip">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
