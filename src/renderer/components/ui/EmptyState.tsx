import type { ReactNode } from 'react';
import { emptyStateCopy, type EmptyStateKind } from './empty-state-copy';
export type { EmptyStateKind } from './empty-state-copy';

export function EmptyState({
  action,
  kind,
  locale = 'zh'
}: {
  action?: ReactNode;
  kind: EmptyStateKind;
  locale?: 'zh' | 'en';
}) {
  const copy = emptyStateCopy(kind, locale);
  return (
    <section className={`gta-empty-state gta-empty-state--${kind}`} aria-labelledby={`empty-${kind}`}>
      <EmptyStateArt kind={kind} />
      <div>
        <h3 id={`empty-${kind}`}>{copy.title}</h3>
        <p>{copy.body}</p>
        <small>{copy.actionHint}</small>
        {action}
      </div>
    </section>
  );
}

function EmptyStateArt({ kind }: { kind: EmptyStateKind }) {
  return (
    <svg
      className="gta-empty-state-art"
      viewBox="0 0 220 150"
      aria-hidden="true"
      focusable="false"
    >
      <path className="is-frame" d="M24 34 50 14h120l26 20v82l-26 20H50l-26-20Z" />
      <path className="is-orbit" d="M43 88c26-45 96-61 139-28M44 105c41 24 105 10 132-29" />
      <circle className="is-star" cx="166" cy="44" r="4" />
      {kind === 'history' ? (
        <>
          <path className="is-main" d="M73 45h67l13 13v54H73Z" />
          <path className="is-detail" d="M91 69h44M91 84h34M91 99h40" />
        </>
      ) : kind === 'offline' ? (
        <>
          <path className="is-main" d="M69 91c4-18 17-27 33-23 9-19 43-14 45 9 19 2 22 29 3 34H79c-18-3-23-17-10-20Z" />
          <path className="is-detail" d="m84 47 52 70M136 47l-52 70" />
        </>
      ) : (
        <>
          <path className="is-main" d="M92 78a22 22 0 1 1 31 20v19H91V98a22 22 0 0 1 1-20Z" />
          <path className="is-detail" d="M102 117v-19m13 19V98m-19-34-9-10m35 10 9-10" />
        </>
      )}
    </svg>
  );
}
