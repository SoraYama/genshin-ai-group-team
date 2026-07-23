import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('roster character portrait', () => {
  it('prefers the profile image and retains an error fallback', async () => {
    const source = await readFile(
      path.resolve('src/renderer/pages/Roster/CharacterCard.tsx'),
      'utf8'
    );

    expect(source).toContain('<CharacterPortrait');
    expect(source).toContain('imageUrl={character.imageUrl}');
    expect(source).toContain('<img');
    expect(source).toContain('loading="lazy"');
    expect(source).toContain('decoding="async"');
    expect(source).toContain('onError=');
    expect(source).toContain('<IdentityMark');
  });

  it('sizes the loaded portrait inside the existing cut-corner frame', async () => {
    const source = await readFile(
      path.resolve('src/renderer/styles/pages/roster.css'),
      'utf8'
    );

    expect(source).toContain('.gta-character-mark.has-image img');
    expect(source).toContain('object-fit: cover');
    expect(source).toContain('object-position: center top');
  });

  it('uses the character element as a restrained background wash', async () => {
    const component = await readFile(
      path.resolve('src/renderer/pages/Roster/CharacterCard.tsx'),
      'utf8'
    );
    const styles = await readFile(
      path.resolve('src/renderer/styles/pages/roster.css'),
      'utf8'
    );

    expect(component).toContain(
      "'--character-element': element ? elementPalette[element].flat : '#71808a'"
    );
    expect(styles).toMatch(
      /color-mix\(\s*in srgb,\s*var\(--character-element\)\s*12%/u
    );
    expect(styles).toMatch(
      /color-mix\(\s*in srgb,\s*var\(--character-element\)\s*6%/u
    );
    expect(styles).toMatch(
      /color-mix\(\s*in srgb,\s*var\(--character-element\)\s*5%/u
    );
  });
});
