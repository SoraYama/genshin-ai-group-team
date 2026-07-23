import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { elements } from '../../../src/renderer/design/tokens.js';

describe('official element assets', () => {
  it('maps every element to a bundled local PNG', async () => {
    const source = await readFile(
      path.resolve('src/renderer/design/element-assets.ts'),
      'utf8'
    );

    for (const element of elements) {
      expect(source).toContain(`genshin-elements/${element}.png`);
      expect(source).toMatch(new RegExp(`\\n  ${element}(?:,|\\n\\})`, 'u'));
    }
  });

  it('renders the official asset through the existing ElementIcon API', async () => {
    const source = await readFile(path.resolve('src/renderer/design/Icons.tsx'), 'utf8');

    expect(source).toContain('<img');
    expect(source).toContain('src={elementIconAssets[element]}');
    expect(source).toContain('width={size}');
    expect(source).toContain('height={size}');
    expect(source).not.toContain('function ElementShape');
  });
});
