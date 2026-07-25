import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('roster character portrait', () => {
  it('renders a semantic compact tile with the proxied portrait and fallback', async () => {
    const source = await readFile(
      path.resolve('src/renderer/pages/Roster/CharacterTile.tsx'),
      'utf8'
    );

    expect(source).toContain('data-testid="character-tile"');
    expect(source).toContain('type="button"');
    expect(source).toContain('aria-pressed={selected}');
    expect(source).toContain('renderTile(character)');
    expect(source).toContain('<img');
    expect(source).toContain('loading="lazy"');
    expect(source).toContain('decoding="async"');
    expect(source).toContain('onError=');
    expect(source).toContain('<IdentityMark');
  });

  it('sizes the loaded portrait as the tile scanning anchor', async () => {
    const source = await readFile(path.resolve('src/renderer/styles/pages/roster.css'), 'utf8');

    expect(source).toContain('.character-tile__portrait.has-image img');
    expect(source).toContain('object-fit: cover');
    expect(source).toContain('object-position: center top');
  });

  it('uses a restrained cold grid with gold limited to interaction and completeness', async () => {
    const styles = await readFile(path.resolve('src/renderer/styles/pages/roster.css'), 'utf8');

    expect(styles).toMatch(/\.roster-grid\s*\{[^}]*background:/su);
    expect(styles).toContain('.character-tile:hover');
    expect(styles).toContain(".character-tile[aria-pressed='true']");
    expect(styles).toContain('.character-tile:focus-visible');
  });

  it('moves complete character data into an accessible right-side drawer', async () => {
    const drawer = await readFile(
      path.resolve('src/renderer/pages/Roster/CharacterDetailDrawer.tsx'),
      'utf8'
    );
    const detail = await readFile(
      path.resolve('src/renderer/pages/Roster/CharacterCard.tsx'),
      'utf8'
    );

    expect(drawer).toContain('role="dialog"');
    expect(drawer).toContain('aria-modal="true"');
    expect(drawer).toContain('<CharacterCard character={character} />');
    expect(drawer).toContain("event.key === 'Escape'");
    expect(drawer).toContain("event.key === 'Tab'");
    expect(detail).toContain('gta-character-detail');
  });

  it('renders the known energy value without generic advice', async () => {
    const translations = await readFile(path.resolve('src/renderer/i18n/index.tsx'), 'utf8');

    expect(translations.match(/'roster\.energyPanel\.known': '\{\{value\}\}%'/gu)).toHaveLength(2);
    expect(translations).not.toContain('是否够用需结合角色、队伍产球与实战循环判断');
    expect(translations).not.toContain(
      'Whether it is sufficient depends on the character, team particles, and rotation.'
    );
  });

  it('surfaces explicitly missing build fields through localized detail copy', async () => {
    const detail = await readFile(
      path.resolve('src/renderer/pages/Roster/CharacterCard.tsx'),
      'utf8'
    );

    expect(detail).toContain('character.missingFields');
    expect(detail).toContain("t('roster.missing'");
    expect(detail).toContain("'roster.provenance.stats'");
  });

  it('allocates the viewport remainder to a self-scrolling dense grid and drawer', async () => {
    const styles = await readFile(path.resolve('src/renderer/styles/pages/roster.css'), 'utf8');

    expect(styles).toMatch(
      /\.roster-page\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*var\(--app-shell-offset\)\)[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden/su
    );
    expect(styles).toMatch(
      /\.roster-grid\s*\{[^}]*overflow:\s*auto[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(108px,\s*1fr\)\)[^}]*align-content:\s*start/su
    );
    expect(styles).toMatch(
      /\.character-detail-drawer\s*\{[^}]*width:\s*clamp\(360px,\s*38vw,\s*560px\)/su
    );
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
