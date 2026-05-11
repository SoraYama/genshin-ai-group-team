/**
 * Design tokens — source-of-truth for runtime style access from TS.
 * All values mirror the CSS custom properties defined in global.css.
 *
 * Reference: docs/design/roster-mockup.html (v2) + Mantan21 wish simulator.
 * The visual language is "warm cream panel + slate-blue + element accents",
 * NOT the dark-blue + cool-gold I originally guessed.
 */

export const elements = [
  'pyro',
  'hydro',
  'electro',
  'anemo',
  'geo',
  'cryo',
  'dendro'
] as const;

export type Element = (typeof elements)[number];

export const elementPalette: Record<
  Element,
  { gradientStart: string; gradientEnd: string; flat: string; bg: string }
> = {
  pyro: { gradientStart: '#fe6606', gradientEnd: '#fea76b', flat: '#ee6c4c', bg: '#c45b31' },
  hydro: { gradientStart: '#06bbff', gradientEnd: '#10e2ff', flat: '#3f8ed1', bg: '#3d6db5' },
  electro: { gradientStart: '#ca82fc', gradientEnd: '#deb5fe', flat: '#7d67c5', bg: '#8246ba' },
  anemo: { gradientStart: '#32d9a1', gradientEnd: '#aef2cd', flat: '#359697', bg: '#359697' },
  geo: { gradientStart: '#f9aa02', gradientEnd: '#fcd260', flat: '#cb8f46', bg: '#b88f47' },
  cryo: { gradientStart: '#7cfeff', gradientEnd: '#c6fffd', flat: '#46c2d8', bg: '#5cd2e3' },
  dendro: { gradientStart: '#a6d138', gradientEnd: '#aaef3a', flat: '#64ad15', bg: '#64ad15' }
};

/**
 * Normalize element names returned from Enka (Fire / Water / Rock / Wind / Ice / ...)
 * to our element keys. Defaults to 'pyro' on miss (with stable color so layout works).
 */
export function normalizeElement(raw: string): Element {
  const lower = raw.toLowerCase();
  if (lower === 'fire' || lower === 'pyro') return 'pyro';
  if (lower === 'water' || lower === 'hydro') return 'hydro';
  if (lower === 'electric' || lower === 'electro') return 'electro';
  if (lower === 'wind' || lower === 'anemo') return 'anemo';
  if (lower === 'rock' || lower === 'geo') return 'geo';
  if (lower === 'ice' || lower === 'cryo') return 'cryo';
  if (lower === 'grass' || lower === 'dendro') return 'dendro';
  return 'pyro';
}

export const palette = {
  panelCream: '#fbf6ee',
  panelCream2: '#ece5d8',
  panelCream3: '#e0ddd4',
  panelSlate: '#4a5265',
  panelSlate2: '#333947',
  strokeCream: '#ddd5c8',
  strokeCreamSoft: '#ebe3d3',
  textOnLight: '#383b40',
  textOnLightSoft: '#5a6068',
  textOnLightFaint: '#8a8b8f',
  textOnDark: '#ffffff',
  textOnDarkSoft: '#d0d4dc',
  gold: '#c3b8a1',
  goldSoft: 'rgba(210, 198, 156, 0.5)',
  goldIcon: '#ffc107',
  blueIcon: '#3f9ad1',
  danger: '#c45b31',
  ok: '#64ad15'
} as const;

export const fonts = {
  body:
    "'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
} as const;

export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
  pill: 999
} as const;

export const space = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32
} as const;
