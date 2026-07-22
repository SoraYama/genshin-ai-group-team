/**
 * Design tokens — source-of-truth for runtime style access from TS.
 * All values mirror the CSS custom properties defined in global.css.
 *
 * Visual language: cool blue-gray canvas, mist-green surfaces, ivory text and
 * one restrained gold accent. CSS custom properties in styles/tokens.css are
 * the rendered source of truth; this module serves data-driven TS consumers.
 */

export const elements = ['pyro', 'hydro', 'electro', 'anemo', 'geo', 'cryo', 'dendro'] as const;

export type Element = (typeof elements)[number];

export const elementPalette: Record<
  Element,
  { gradientStart: string; gradientEnd: string; flat: string; bg: string }
> = {
  pyro: { gradientStart: '#c6634e', gradientEnd: '#d99474', flat: '#a84c40', bg: '#8b433a' },
  hydro: { gradientStart: '#4b95ba', gradientEnd: '#7ebed1', flat: '#367da0', bg: '#315f78' },
  electro: { gradientStart: '#8f79b1', gradientEnd: '#b7a6cc', flat: '#755e9a', bg: '#594875' },
  anemo: { gradientStart: '#4d988e', gradientEnd: '#8ac4b7', flat: '#397d77', bg: '#356963' },
  geo: { gradientStart: '#b39154', gradientEnd: '#d0b775', flat: '#96763e', bg: '#765d32' },
  cryo: { gradientStart: '#69a7b6', gradientEnd: '#a2cdd2', flat: '#518b9a', bg: '#426f7b' },
  dendro: { gradientStart: '#728b4b', gradientEnd: '#a3b778', flat: '#5c7338', bg: '#4b5e31' }
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
  panelCream: '#ecf2f1',
  panelCream2: '#dfe8e6',
  panelCream3: '#cbd8d6',
  panelSlate: '#263b4c',
  panelSlate2: '#172a3a',
  strokeCream: '#9db2b1',
  strokeCreamSoft: '#a9bebb',
  textOnLight: '#14222c',
  textOnLightSoft: '#3f5360',
  textOnLightFaint: '#687a82',
  textOnDark: '#f7f5ec',
  textOnDarkSoft: '#cbd7d8',
  gold: '#bda775',
  goldSoft: 'rgba(189, 167, 117, 0.3)',
  goldIcon: '#d8c58d',
  blueIcon: '#4b95ba',
  danger: '#9f4c4f',
  ok: '#356f61'
} as const;

export const fonts = {
  body: "'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
} as const;

export const radii = {
  sm: 2,
  md: 4,
  lg: 6,
  pill: 4
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
