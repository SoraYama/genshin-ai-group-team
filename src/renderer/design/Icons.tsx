/** Original geometric SVG primitives shared across pages. */
import type { Element } from './tokens';
import { elementPalette } from './tokens';

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
  const { gradientStart, gradientEnd } = elementPalette[element];
  const gid = `gta-grad-${element}`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={`url(#${gid})`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={gradientStart} />
          <stop offset="100%" stopColor={gradientEnd} />
        </linearGradient>
      </defs>
      <ElementShape element={element} />
    </svg>
  );
}

function ElementShape({ element }: { element: Element }) {
  switch (element) {
    case 'pyro':
      return <path d="M12 2.5 C 14 6.5 18 8.5 18 13 a 6 6 0 0 1 -12 0 C 6 9 9 8.5 12 2.5 Z" />;
    case 'hydro':
      return <path d="M12 3 C 7 11 6.5 15 6.5 17 a 5.5 5.5 0 0 0 11 0 C 17.5 15 17 11 12 3 Z" />;
    case 'electro':
      return <path d="M13.5 2 L 5 13.5 L 11 13.5 L 9.5 22 L 19 9 L 13.5 9 L 15 2 Z" />;
    case 'anemo':
      return (
        <path d="M 5 12 Q 5 5 12 5 Q 19 5 19 12 Q 19 19 12 19 Q 5 19 5 12 Z M 10 9 Q 13 9 13 12 Q 13 15 10 15" />
      );
    case 'geo':
      return <path d="M12 3 L 21 9 L 18 20 L 6 20 L 3 9 Z" />;
    case 'cryo':
      return (
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M 12 2 L 12 22" />
          <path d="M 4 7 L 20 17" />
          <path d="M 4 17 L 20 7" />
        </g>
      );
    case 'dendro':
      return <path d="M 12 22 C 6 17 6 9 12 3 C 18 9 18 17 12 22 Z" />;
  }
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
