import { describe, expect, it } from 'vitest';

import {
  sha256Hex,
  verifyKnowledgeProvenance,
  type KnowledgeProvenanceCatalog
} from '../../../src/main/gates/knowledge-provenance.js';

const revision = 'a'.repeat(40);
const charactersUrl = `https://raw.githubusercontent.com/EnkaNetwork/API-docs/${revision}/store/characters.json`;
const localizationUrl = `https://raw.githubusercontent.com/EnkaNetwork/API-docs/${revision}/store/loc.json`;
const encoder = new TextEncoder();
const charactersBytes = encoder.encode(
  JSON.stringify({
    '10000001': {
      Element: 'Fire',
      WeaponType: 'WEAPON_SWORD_ONE_HAND',
      NameTextMapHash: 1
    },
    '10000002': {
      Element: 'Water',
      WeaponType: 'WEAPON_BOW',
      NameTextMapHash: 2
    },
    '10000901': {
      Element: 'Fire',
      WeaponType: 'WEAPON_SWORD_ONE_HAND',
      NameTextMapHash: 3
    }
  })
);
const localizationBytes = encoder.encode(
  JSON.stringify({ 'zh-cn': { '1': '甲', '2': '乙', '3': '甲·变体' } })
);

function fixtureCatalog(): KnowledgeProvenanceCatalog {
  return {
    provenance: [
      {
        id: 'enka-characters',
        url: charactersUrl,
        sha256: sha256Hex(charactersBytes)
      },
      {
        id: 'enka-localization',
        url: localizationUrl,
        sha256: sha256Hex(localizationBytes)
      }
    ],
    exclusions: [
      {
        id: '10000901',
        kind: 'alternate-variant',
        canonicalId: '10000001'
      }
    ],
    characters: [
      { id: '10000001', name: '甲', element: 'pyro', weaponType: 'sword' },
      { id: '10000002', name: '乙', element: 'hydro', weaponType: 'bow' }
    ]
  };
}

function verify(catalog = fixtureCatalog()) {
  return verifyKnowledgeProvenance(catalog, { charactersBytes, localizationBytes });
}

describe('knowledge provenance pure verifier', () => {
  it('accepts matching pinned snapshots', () => {
    expect(verify()).toMatchObject({
      revision,
      catalogCount: 2,
      exclusionCount: 1
    });
  });

  it('rejects mutable provenance URLs and digest mismatches', () => {
    const mutable = fixtureCatalog();
    mutable.provenance[0]!.url =
      'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json';
    expect(() => verify(mutable)).toThrow(/not pinned to an immutable commit/i);

    const mismatched = fixtureCatalog();
    mismatched.provenance[0]!.sha256 = '0'.repeat(64);
    expect(() => verify(mismatched)).toThrow(/digest mismatch.*enka-characters/i);
  });

  it('rejects missing exclusion audits and invalid alternate canonical targets', () => {
    const missingExclusion = fixtureCatalog();
    missingExclusion.exclusions = [];
    expect(() => verify(missingExclusion)).toThrow(/missing exclusion audit entries.*10000901/i);

    const invalidTarget = fixtureCatalog();
    invalidTarget.exclusions[0]!.canonicalId = '19999999';
    expect(() => verify(invalidTarget)).toThrow(
      /alternate exclusion 10000901 points to missing canonical row 19999999/i
    );
  });

  it('reports catalog length mismatches explicitly', () => {
    const wrongLength = fixtureCatalog();
    wrongLength.characters.push({
      id: '10000003',
      name: '丙',
      element: 'cryo',
      weaponType: 'catalyst'
    });

    expect(() => verify(wrongLength)).toThrow(/catalog length mismatch: upstream=2 committed=3/i);
    expect(() => verify(wrongLength)).not.toThrow(/index -1/i);
  });
});
