import { describe, expect, it } from 'vitest';
import { normalizeElement } from '../../../src/renderer/design/tokens.js';
import {
  classifyEnergyRecharge,
  ENERGY_RECHARGE_THRESHOLDS,
  presentArtifactStatKey,
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

  it('classifies only a valid known energy recharge value with centralized thresholds', () => {
    expect(ENERGY_RECHARGE_THRESHOLDS).toEqual({ medium: 120, high: 180 });
    expect(classifyEnergyRecharge(undefined)).toBe('unknown');
    expect(classifyEnergyRecharge(Number.NaN)).toBe('unknown');
    expect(classifyEnergyRecharge(0)).toBe('unknown');
    expect(classifyEnergyRecharge(119.9)).toBe('low');
    expect(classifyEnergyRecharge(120)).toBe('medium');
    expect(classifyEnergyRecharge(179.9)).toBe('medium');
    expect(classifyEnergyRecharge(180)).toBe('high');
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
