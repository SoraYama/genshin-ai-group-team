import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../../src/shared/domain.js';
import { normalizeElement } from '../../../src/renderer/design/tokens.js';
import {
  isRenderableCharacterPortrait,
  presentArtifactStatKey,
  presentEnergyRecharge,
  reactionTagsForElement,
  renderTile,
  sortCharacters
} from '../../../src/renderer/pages/Roster/character-presentation.js';

function character(
  id: number,
  name: string,
  overrides: Partial<CharacterProfile> = {}
): CharacterProfile {
  return {
    id,
    name,
    element: 'Pyro',
    rarity: 5,
    imageUrl: '',
    completeness: 'basic',
    missingFields: [],
    provenance: {
      ownership: {
        source: 'miyoushe-list',
        fetchedAt: '2026-07-25T00:00:00.000Z'
      }
    },
    ...overrides
  };
}

describe('character presentation decisions', () => {
  it('keeps default roster order without mutating the source array', () => {
    const source = [character(2, '乙'), character(1, '甲')];

    const sorted = sortCharacters(source, 'default', 'zh-CN');

    expect(sorted.map(({ id }) => id)).toEqual([2, 1]);
    expect(sorted).not.toBe(source);
    expect(source.map(({ id }) => id)).toEqual([2, 1]);
  });

  it('sorts levels descending, puts unknown levels last, and keeps equal levels stable', () => {
    const source = [
      character(1, 'First 80', { level: 80 }),
      character(2, 'Unknown'),
      character(3, 'Level 90', { level: 90 }),
      character(4, 'Second 80', { level: 80 })
    ];

    expect(sortCharacters(source, 'level-desc', 'en-US').map(({ id }) => id)).toEqual([3, 1, 4, 2]);
  });

  it('sorts names with the requested locale and a deterministic stable tie', () => {
    const source = [
      character(1, 'Zhongli'),
      character(2, 'amber'),
      character(3, 'Amber'),
      character(4, 'Furina')
    ];

    expect(sortCharacters(source, 'name', 'en-US').map(({ id }) => id)).toEqual([2, 3, 4, 1]);
  });

  it('sorts known elements in filter order and leaves unknown elements last', () => {
    const source = [
      character(1, 'Unknown', { element: 'Void' }),
      character(2, 'Electro', { element: 'Electro' }),
      character(3, 'First Pyro', { element: 'Pyro' }),
      character(4, 'Hydro', { element: 'Hydro' }),
      character(5, 'Second Pyro', { element: 'Pyro' })
    ];

    expect(sortCharacters(source, 'element', 'en-US').map(({ id }) => id)).toEqual([3, 5, 4, 2, 1]);
  });

  it('sorts completeness descending and preserves source order within a tier', () => {
    const source = [
      character(1, 'First basic'),
      character(2, 'Build', { completeness: 'build' }),
      character(3, 'Detailed', { completeness: 'detailed' }),
      character(4, 'Second basic')
    ];

    expect(sortCharacters(source, 'completeness-desc', 'en-US').map(({ id }) => id)).toEqual([
      3, 2, 1, 4
    ]);
  });

  it('keeps the tile model limited to scan-friendly identity fields', () => {
    const tile = renderTile({
      id: 52,
      name: '雷电将军',
      element: 'Electro',
      rarity: 5,
      imageUrl: '',
      level: 90,
      constellation: 2,
      completeness: 'detailed',
      missingFields: [],
      provenance: {
        ownership: {
          source: 'miyoushe-list',
          fetchedAt: '2026-07-25T00:00:00.000Z'
        }
      }
    });

    expect(tile).toEqual({
      name: '雷电将军',
      level: 90,
      element: 'Electro',
      completeness: 'detailed'
    });
    expect(tile).not.toHaveProperty('artifactDetails');
  });

  it('does not turn an unknown element into Pyro', () => {
    expect(normalizeElement('Pyro')).toBe('pyro');
    expect(normalizeElement('')).toBeUndefined();
    expect(normalizeElement('Void')).toBeUndefined();
  });

  it('only offers reaction tags for a known element', () => {
    expect(reactionTagsForElement(undefined)).toEqual([]);
    expect(reactionTagsForElement('geo')).toEqual(['crystallize']);
    expect(reactionTagsForElement('pyro')).toEqual(['vaporize', 'melt', 'overloaded', 'burning']);
  });

  it('presents Energy Recharge only as known or unknown panel data', () => {
    expect(presentEnergyRecharge(undefined)).toEqual({ kind: 'unknown' });
    expect(presentEnergyRecharge(Number.NaN)).toEqual({ kind: 'unknown' });
    expect(presentEnergyRecharge(0)).toEqual({ kind: 'unknown' });
    expect(presentEnergyRecharge(117.5)).toEqual({ kind: 'known', value: 117.5 });
    expect(presentEnergyRecharge(240)).toEqual({ kind: 'known', value: 240 });
  });

  it('accepts only the existing main-process image proxy for portraits', () => {
    expect(isRenderableCharacterPortrait('gtai-img://avatar/UI_AvatarIcon_Kazuha.png')).toBe(true);
    expect(isRenderableCharacterPortrait('gtai-img://remote/abc123')).toBe(true);
    expect(isRenderableCharacterPortrait('https://enka.network/ui/a.png')).toBe(false);
    expect(isRenderableCharacterPortrait('file:///tmp/a.png')).toBe(false);
    expect(isRenderableCharacterPortrait('')).toBe(false);
    expect(isRenderableCharacterPortrait(undefined)).toBe(false);
  });

  it('localizes common artifact stats and safely preserves a bounded unknown key', () => {
    expect(presentArtifactStatKey('atkPct')).toEqual({ kind: 'known', key: 'atkPercent' });
    expect(presentArtifactStatKey('FIGHT_PROP_CHARGE_EFFICIENCY')).toEqual({
      kind: 'known',
      key: 'energyRecharge'
    });
    expect(presentArtifactStatKey('new_stat\n<script>alert(1)</script>')).toEqual({
      kind: 'raw',
      label: 'new_stat script alert(1) /script'
    });
    expect(presentArtifactStatKey('   ')).toEqual({ kind: 'raw', label: 'unknown' });
  });
});
