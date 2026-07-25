import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../../src/shared/domain.js';
import { I18nProvider, type Locale } from '../../../src/renderer/i18n/index.js';
import { CharacterCard } from '../../../src/renderer/pages/Roster/CharacterCard.js';
import { CharacterDetailDrawer } from '../../../src/renderer/pages/Roster/CharacterDetailDrawer.js';
import { CharacterTile } from '../../../src/renderer/pages/Roster/CharacterTile.js';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterAll(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

function renderLocalized(locale: Locale, child: ReactElement): string {
  const storage: Storage = {
    length: 1,
    clear: () => undefined,
    getItem: (key) => (key === 'gta.locale' ? locale : null),
    key: (index) => (index === 0 ? 'gta.locale' : null),
    removeItem: () => undefined,
    setItem: () => undefined
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  });
  return renderToStaticMarkup(createElement(I18nProvider, null, child));
}

function character(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    id: 10000052,
    name: '枫原万叶',
    element: 'Anemo',
    rarity: 5,
    imageUrl: 'gtai-img://avatar/UI_AvatarIcon_Kazuha.png',
    level: 90,
    constellation: 2,
    completeness: 'detailed',
    missingFields: [],
    provenance: {
      ownership: {
        source: 'miyoushe-list',
        fetchedAt: '2026-07-25T00:00:00.000Z'
      },
      build: {
        source: 'enka',
        fetchedAt: '2026-07-25T00:00:00.000Z'
      },
      stats: {
        source: 'enka',
        fetchedAt: '2026-07-25T00:00:00.000Z'
      }
    },
    build: {
      stats: {
        hp: 19999,
        atk: 1450,
        def: 900,
        critRate: 45.4,
        critDmg: 112.2,
        energyRecharge: 117.5,
        elementalMastery: 820
      },
      weapon: {
        id: 11503,
        name: '苍古自由之誓',
        iconUrl: '',
        level: 90,
        refinement: 1,
        rarity: 5
      },
      artifacts: [
        {
          slot: 'sands',
          setId: 15002,
          setName: '翠绿之影',
          level: 20,
          rarity: 5,
          mainStat: { key: 'elementalMastery', value: 187 },
          subStats: []
        }
      ],
      talents: {
        normalAttack: 6,
        elementalSkill: 9,
        elementalBurst: 9
      }
    },
    ...overrides
  };
}

describe('roster character components', () => {
  it('SSR-renders the compact semantic tile with a proxied portrait', () => {
    const markup = renderLocalized(
      'zh-CN',
      createElement(CharacterTile, {
        character: character(),
        imageRevision: '2026-07-25T00:00:00.000Z',
        onSelect: () => undefined,
        selected: true
      })
    );

    expect(markup).toContain('data-testid="character-tile"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-controls="character-detail-drawer"');
    expect(markup).toContain('src="gtai-img://avatar/UI_AvatarIcon_Kazuha.png"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
    expect(markup).toContain('枫原万叶');
    expect(markup).toContain('Lv.90');
    expect(markup).toContain('详细面板');
  });

  it('SSR-renders an identity fallback instead of a forbidden external portrait', () => {
    const markup = renderLocalized(
      'zh-CN',
      createElement(CharacterTile, {
        character: character({
          imageUrl: 'https://enka.network/ui/UI_AvatarIcon_Kazuha.png'
        }),
        onSelect: () => undefined,
        selected: false
      })
    );

    expect(markup).not.toContain('https://enka.network/ui/UI_AvatarIcon_Kazuha.png');
    expect(markup).toContain('character-tile__rune');
    expect(markup).toContain('枫');
  });

  it('SSR-renders known build facts without generic energy advice', () => {
    const markup = renderLocalized(
      'zh-CN',
      createElement(CharacterCard, { character: character() })
    );

    expect(markup).toContain('117.5%');
    expect(markup).toContain('苍古自由之誓');
    expect(markup).toContain('元素精通 187');
    expect(markup).not.toContain('是否够用需结合角色');
  });

  it('SSR-renders explicitly missing build fields with localized copy', () => {
    const missing = character({
      build: undefined,
      completeness: 'basic',
      missingFields: ['stats', 'weapon', 'artifacts', 'talents']
    });

    const zhMarkup = renderLocalized('zh-CN', createElement(CharacterCard, { character: missing }));
    const enMarkup = renderLocalized('en-US', createElement(CharacterCard, { character: missing }));

    expect(zhMarkup).toContain('缺失：面板数值、武器、圣遗物、天赋');
    expect(enMarkup).toContain('Missing: Panel stats, Weapon, Artifacts, Talents');
  });

  it('SSR-renders the character card inside a named modal drawer', () => {
    const markup = renderLocalized(
      'zh-CN',
      createElement(CharacterDetailDrawer, {
        character: character(),
        onDismiss: () => undefined
      })
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('枫原万叶资料');
    expect(markup).toContain('gta-character-detail');
  });

  it('localizes blank or control-only artifact stat keys as unavailable', () => {
    const unavailable = character({
      build: {
        ...character().build,
        artifacts: [
          {
            slot: 'goblet',
            setId: 0,
            setName: '',
            level: 20,
            rarity: 5,
            mainStat: { key: '\u0000 \u001f', value: 46.6 },
            subStats: []
          }
        ]
      }
    });

    const zhMarkup = renderLocalized(
      'zh-CN',
      createElement(CharacterCard, { character: unavailable })
    );
    const enMarkup = renderLocalized(
      'en-US',
      createElement(CharacterCard, { character: unavailable })
    );

    expect(zhMarkup).toContain('属性类型不可用 46.6');
    expect(enMarkup).toContain('Stat unavailable 46.6');
    expect(zhMarkup).not.toContain('unknown');
  });

  it('keeps the dense grid and drawer within independently scrolling surfaces', async () => {
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
