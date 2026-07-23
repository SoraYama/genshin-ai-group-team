import { describe, expect, it } from 'vitest';
import { normalizeElement } from '../../../src/renderer/design/tokens.js';
import {
  isRenderableCharacterPortrait,
  presentArtifactStatKey,
  presentEnergyRecharge,
  reactionTagsForElement
} from '../../../src/renderer/pages/Roster/character-presentation.js';

describe('character presentation decisions', () => {
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
    expect(
      isRenderableCharacterPortrait('gtai-img://avatar/UI_AvatarIcon_Kazuha.png')
    ).toBe(true);
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
