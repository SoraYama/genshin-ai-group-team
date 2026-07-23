/** Shared visual primitives, including credited official element assets. */
import type { Element } from './tokens';
import { elementIconAssets } from './element-assets';

interface SvgProps {
  className?: string;
  size?: number;
}

export function CornerPiece({ className, size = 22 }: SvgProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 22 22"
      fill="none"
      aria-hidden="true"
    >
      <path d="M 0 22 L 0 6 Q 0 0 6 0 L 22 0" stroke="#bda775" strokeWidth="1.5" />
      <path d="M 3 18 L 3 8 Q 3 5 6 5 L 16 5" stroke="#bda775" strokeWidth="1" opacity="0.65" />
      <circle cx="6" cy="6" r="1.8" fill="#bda775" />
    </svg>
  );
}

interface ElementIconProps extends SvgProps {
  element: Element;
}

export function ElementIcon({ element, className, size = 18 }: ElementIconProps) {
  return (
    <img
      className={className}
      src={elementIconAssets[element]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function StarIcon({ className, size = 9 }: SvgProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M 6 0.5 L 7.3 4.7 L 11.5 6 L 7.3 7.3 L 6 11.5 L 4.7 7.3 L 0.5 6 L 4.7 4.7 Z" />
    </svg>
  );
}

export function PortraitFallback({ className, size = 60 }: SvgProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="#fff"
      aria-hidden="true"
    >
      <circle cx="32" cy="24" r="11" opacity="0.95" />
      <path d="M 8 60 Q 8 38 32 38 Q 56 38 56 60 Z" opacity="0.92" />
    </svg>
  );
}

export type StatIconName =
  | 'hp'
  | 'atk'
  | 'def'
  | 'crit-rate'
  | 'crit-dmg'
  | 'energy-recharge'
  | 'elemental-mastery';

interface StatIconProps extends SvgProps {
  name: StatIconName;
}

/** Original single-line symbols; deliberately distinct from the game's UI glyphs. */
export function StatIcon({ className, name, size = 16 }: StatIconProps) {
  const shared = {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true
  };
  if (name === 'hp') {
    return (
      <svg {...shared}>
        <path d="M10 17s-6-3.6-6-8.1A3.8 3.8 0 0 1 10 6a3.8 3.8 0 0 1 6 2.9C16 13.4 10 17 10 17Z" />
      </svg>
    );
  }
  if (name === 'atk') {
    return (
      <svg {...shared}>
        <path d="m5 15 9-9M8 5l7-2-2 7M3.5 16.5l3-3" />
      </svg>
    );
  }
  if (name === 'def') {
    return (
      <svg {...shared}>
        <path d="M10 2.7 16 5v4.6c0 3.7-2.2 6.3-6 7.8-3.8-1.5-6-4.1-6-7.8V5l6-2.3Z" />
        <path d="M10 6v7" />
      </svg>
    );
  }
  if (name === 'crit-rate') {
    return (
      <svg {...shared}>
        <circle cx="10" cy="10" r="6.5" />
        <circle cx="10" cy="10" r="2" />
        <path d="m14.5 5.5 2-2" />
      </svg>
    );
  }
  if (name === 'crit-dmg') {
    return (
      <svg {...shared}>
        <path d="m10 2 1.6 5.1L17 8.6l-4.1 3.2.2 5.4-3.1-4.4-3.1 4.4.2-5.4L3 8.6l5.4-1.5L10 2Z" />
      </svg>
    );
  }
  if (name === 'energy-recharge') {
    return (
      <svg {...shared}>
        <path d="M15.5 6.5A6 6 0 1 0 16 13" />
        <path d="M15.5 3v3.5H12M10.5 6.5 8 10h3l-1.5 3.5" />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      <path d="M10 2.5v15M4 6l12 8M4 14l12-8" />
      <circle cx="10" cy="10" r="3" />
    </svg>
  );
}

export type BuildIconName = 'weapon' | 'talents' | 'artifacts' | 'constellation';

interface BuildIconProps extends SvgProps {
  name: BuildIconName;
}

export function BuildIcon({ className, name, size = 17 }: BuildIconProps) {
  const shared = {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true
  };
  if (name === 'weapon') {
    return (
      <svg {...shared}>
        <path d="m4 16 10-10M11 4l5-1-1 5M3 17l4-1-3-3-1 4Z" />
      </svg>
    );
  }
  if (name === 'talents') {
    return (
      <svg {...shared}>
        <path d="M3.5 4.5c3-1 5-.6 6.5 1v10c-1.5-1.6-3.5-2-6.5-1v-10ZM16.5 4.5c-3-1-5-.6-6.5 1v10c1.5-1.6 3.5-2 6.5-1v-10Z" />
      </svg>
    );
  }
  if (name === 'artifacts') {
    return (
      <svg {...shared}>
        <path d="m10 2.5 6 4.3-2.3 7H6.3L4 6.8 10 2.5Z" />
        <path d="m10 6 2.4 1.8-.9 2.8h-3l-.9-2.8L10 6Z" />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      <path d="m10 2 1.5 4.6L16 8l-4.5 1.4L10 14l-1.5-4.6L4 8l4.5-1.4L10 2Z" />
      <circle cx="4" cy="15.5" r="1.2" />
      <path d="m5 14.7 3-2" />
    </svg>
  );
}

interface ButtonIconProps {
  name: 'check' | 'x' | 'plus' | 'refresh' | 'trash';
  size?: number;
}

export function ButtonGlyph({ name, size = 16 }: ButtonIconProps) {
  switch (name) {
    case 'check':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M 5.5 8.2 L 7.2 9.8 L 10.5 6.2"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'x':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M 4 4 L 12 12 M 12 4 L 4 12"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'plus':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M 8 3 L 8 13 M 3 8 L 13 8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'refresh':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M 13 4 A 6 6 0 1 0 14 9.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M 13 1 L 13 5 L 9 5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'trash':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M 3 5 L 13 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path
            d="M 5 5 L 5 13 Q 5 14 6 14 L 10 14 Q 11 14 11 13 L 11 5"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M 6 5 L 6 3 Q 6 2 7 2 L 9 2 Q 10 2 10 3 L 10 5"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      );
  }
}

interface CornersProps {
  /** Position offset from edges (negative inset). Default -2px. */
  inset?: number;
}

/** Render 4 corner pieces inside a relatively-positioned parent. */
export function PanelCorners({ inset = -2 }: CornersProps) {
  const style = (corner: 'tl' | 'tr' | 'bl' | 'br'): React.CSSProperties => {
    const base: React.CSSProperties = { position: 'absolute', pointerEvents: 'none', zIndex: 2 };
    if (corner === 'tl') return { ...base, top: inset, left: inset };
    if (corner === 'tr') return { ...base, top: inset, right: inset, transform: 'scaleX(-1)' };
    if (corner === 'bl') return { ...base, bottom: inset, left: inset, transform: 'scaleY(-1)' };
    return { ...base, bottom: inset, right: inset, transform: 'scale(-1, -1)' };
  };
  return (
    <>
      <span style={style('tl')}>
        <CornerPiece />
      </span>
      <span style={style('tr')}>
        <CornerPiece />
      </span>
      <span style={style('bl')}>
        <CornerPiece />
      </span>
      <span style={style('br')}>
        <CornerPiece />
      </span>
    </>
  );
}
