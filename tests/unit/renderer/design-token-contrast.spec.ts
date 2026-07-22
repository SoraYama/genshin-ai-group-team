import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const TOKENS_PATH = new URL('../../../src/renderer/styles/tokens.css', import.meta.url);

describe('renderer text contrast tokens', () => {
  test('keeps faint text on the light surface at WCAG AA contrast', async () => {
    const tokens = await readTokens();
    expect(
      contrast(requireToken(tokens, '--gta-text-on-light-faint'), '#ecf2f1')
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('keeps muted text on the dark canvas at WCAG AA contrast', async () => {
    const tokens = await readTokens();
    expect(
      contrast(
        requireToken(tokens, '--gta-text-on-dark-soft'),
        requireToken(tokens, '--gta-canvas')
      )
    ).toBeGreaterThanOrEqual(4.5);
  });
});

async function readTokens(): Promise<Record<string, string>> {
  const css = await readFile(TOKENS_PATH, 'utf8');
  return Object.fromEntries(
    Array.from(css.matchAll(/(--gta-[\w-]+):\s*(#[\da-f]{6})\s*;/giu), ([, name, value]) => [
      name,
      value
    ])
  );
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function requireToken(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`Missing color token: ${name}`);
  return value;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const red = channel(1);
  const green = channel(3);
  const blue = channel(5);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
