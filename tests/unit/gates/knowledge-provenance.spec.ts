import { gzipSync } from 'node:zlib';

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
const supplementalRevision = 'b'.repeat(40);
const supplementalUrl =
  `https://raw.githubusercontent.com/theBowja/genshin-db-dist/${supplementalRevision}` +
  '/data/scripts/chinesesimplified-characters.js';
const supplementalPayload = gzipSync(
  JSON.stringify({
    data: {
      ChineseSimplified: {
        characters: {
          gamma: {
            id: 10000003,
            name: '丙',
            elementType: 'ELEMENT_CRYO',
            weaponType: 'WEAPON_CATALYST'
          }
        }
      }
    }
  })
).toString('base64');
const supplementalBytes = encoder.encode(
  `!function(){return n(574)("${supplementalPayload}")}();`
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
      },
      {
        id: 'genshin-db-dist-characters',
        url: supplementalUrl,
        sha256: sha256Hex(supplementalBytes)
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
      { id: '10000002', name: '乙', element: 'hydro', weaponType: 'bow' },
      { id: '10000003', name: '丙', element: 'cryo', weaponType: 'catalyst' }
    ]
  };
}

function verify(catalog = fixtureCatalog()) {
  return verifyKnowledgeProvenance(catalog, {
    charactersBytes,
    localizationBytes,
    supplementalCharactersBytes: supplementalBytes
  });
}

describe('knowledge provenance pure verifier', () => {
  it('accepts matching pinned snapshots', () => {
    expect(verify()).toMatchObject({
      revision,
      catalogCount: 3,
      exclusionCount: 1,
      supplementalCharactersSha256: sha256Hex(supplementalBytes)
    });
  });

  it('rejects mutable provenance URLs and digest mismatches for both catalog sources', () => {
    const mutable = fixtureCatalog();
    mutable.provenance[0]!.url =
      'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json';
    expect(() => verify(mutable)).toThrow(/not pinned to an immutable commit/i);

    const mismatched = fixtureCatalog();
    mismatched.provenance[0]!.sha256 = '0'.repeat(64);
    expect(() => verify(mismatched)).toThrow(/digest mismatch.*enka-characters/i);

    const mutableSupplement = fixtureCatalog();
    mutableSupplement.provenance[2]!.url =
      'https://raw.githubusercontent.com/theBowja/genshin-db-dist/main/data/scripts/chinesesimplified-characters.js';
    expect(() => verify(mutableSupplement)).toThrow(/not pinned to an immutable commit/i);

    const mismatchedSupplement = fixtureCatalog();
    mismatchedSupplement.provenance[2]!.sha256 = '0'.repeat(64);
    expect(() => verify(mismatchedSupplement)).toThrow(
      /digest mismatch.*genshin-db-dist-characters/i
    );
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

  it('rejects committed additions that are absent from the supplemental snapshot', () => {
    const unsupportedAddition = fixtureCatalog();
    unsupportedAddition.characters.push({
      id: '10000004',
      name: '丁',
      element: 'cryo',
      weaponType: 'catalyst'
    });

    expect(() => verify(unsupportedAddition)).toThrow(
      /supplemental metadata is missing for committed character 10000004/i
    );
  });
});
