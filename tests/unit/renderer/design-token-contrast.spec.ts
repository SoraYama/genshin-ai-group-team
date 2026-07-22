import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const TOKENS_PATH = new URL('../../../src/renderer/styles/tokens.css', import.meta.url);

describe('renderer text contrast tokens', () => {
  test('keeps every light-surface reading token at WCAG AA contrast', async () => {
    const tokens = await readTokens();
    const canvas = parseColor(requireToken(tokens, '--gta-canvas'));
    const surfaces = ['--gta-panel', '--gta-panel-2', '--gta-panel-3'].map((name) => ({
      name,
      color: composite(parseColor(requireToken(tokens, name)), canvas)
    }));
    const textTokens = [
      '--gta-text-on-light',
      '--gta-text-on-light-soft',
      '--gta-text-on-light-faint'
    ];

    for (const textToken of textTokens) {
      const foreground = parseColor(requireToken(tokens, textToken));
      for (const surface of surfaces) {
        expect(
          contrast(foreground, surface.color),
          `${textToken} on ${surface.name}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('keeps muted text on the dark canvas at WCAG AA contrast', async () => {
    const tokens = await readTokens();
    expect(
      contrast(
        parseColor(requireToken(tokens, '--gta-text-on-dark-soft')),
        parseColor(requireToken(tokens, '--gta-canvas'))
      )
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('defines the shared soft accent used by roster status surfaces', async () => {
    const tokens = await readTokens();
    expect(requireToken(tokens, '--gta-accent-soft')).toMatch(/^(?:#[\da-f]{6}|rgba?\()/iu);
  });
});

async function readTokens(): Promise<Record<string, string>> {
  const css = await readFile(TOKENS_PATH, 'utf8');
  return Object.fromEntries(
    Array.from(
      css.matchAll(/(--gta-[\w-]+):\s*(#[\da-f]{6}|rgba?\([^;]+\))\s*;/giu),
      ([, name, value]) => [name, value]
    )
  );
}

interface Rgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function contrast(foreground: Rgba, background: Rgba): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function requireToken(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`Missing color token: ${name}`);
  return value;
}

function parseColor(value: string): Rgba {
  if (value.startsWith('#')) {
    return {
      red: Number.parseInt(value.slice(1, 3), 16),
      green: Number.parseInt(value.slice(3, 5), 16),
      blue: Number.parseInt(value.slice(5, 7), 16),
      alpha: 1
    };
  }
  const components = value.match(/[\d.]+/gu)?.map(Number);
  if (!components || components.length < 3) throw new Error(`Unsupported color: ${value}`);
  return {
    red: components[0] ?? 0,
    green: components[1] ?? 0,
    blue: components[2] ?? 0,
    alpha: components[3] ?? 1
  };
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  return {
    red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
    green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
    blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
    alpha: 1
  };
}

function luminance(color: Rgba): number {
  const channel = (value255: number) => {
    const value = value255 / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const red = channel(color.red);
  const green = channel(color.green);
  const blue = channel(color.blue);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
