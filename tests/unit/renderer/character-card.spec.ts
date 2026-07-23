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

  it('shows complete character data without an expand control', async () => {
    const component = await readFile(
      path.resolve('src/renderer/pages/Roster/CharacterCard.tsx'),
      'utf8'
    );

    expect(component).not.toContain('const [expanded');
    expect(component).not.toContain('gta-character-expand');
    expect(component).not.toContain('{expanded &&');
    expect(component).toContain('<div className="gta-character-detail">');
  });

  it('renders the known energy value without generic advice', async () => {
    const translations = await readFile(
      path.resolve('src/renderer/i18n/index.tsx'),
      'utf8'
    );

    expect(
      translations.match(/'roster\.energyPanel\.known': '\{\{value\}\}%'/gu)
    ).toHaveLength(2);
    expect(translations).not.toContain(
      '是否够用需结合角色、队伍产球与实战循环判断'
    );
    expect(translations).not.toContain(
      'Whether it is sufficient depends on the character, team particles, and rotation.'
    );
  });

  it('uses a content-sized responsive grid with visible section spacing', async () => {
    const styles = await readFile(
      path.resolve('src/renderer/styles/pages/roster.css'),
      'utf8'
    );

    expect(styles).toMatch(
      /\.gta-character-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*540px\),\s*1fr\)\)[^}]*gap:\s*16px[^}]*margin-top:\s*16px/su
    );
    expect(styles).not.toContain(
      '.gta-character-list {\n    grid-template-columns: 1fr;\n  }'
    );
  });
});
