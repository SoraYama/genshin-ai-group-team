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
const supplementalCharacters = {
  columbina: {
    id: 10000125,
    name: '哥伦比娅',
    elementType: 'ELEMENT_HYDRO',
    weaponType: 'WEAPON_CATALYST'
  },
  zibai: {
    id: 10000126,
    name: '兹白',
    elementType: 'ELEMENT_GEO',
    weaponType: 'WEAPON_SWORD_ONE_HAND'
  },
  illuga: {
    id: 10000127,
    name: '叶洛亚',
    elementType: 'ELEMENT_GEO',
    weaponType: 'WEAPON_POLE'
  }
};

function supplementalSnapshot(characters: unknown): Uint8Array {
  const payload = gzipSync(
    JSON.stringify({
      data: {
        ChineseSimplified: {
          characters
        }
      }
    })
  ).toString('base64');
  return encoder.encode(`!function(){return n(574)("${payload}")}();`);
}

const supplementalBytes = supplementalSnapshot(supplementalCharacters);

function fixtureCatalog(
  supplementalCharactersBytes: Uint8Array = supplementalBytes
): KnowledgeProvenanceCatalog {
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
        sha256: sha256Hex(supplementalCharactersBytes)
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
      { id: '10000125', name: '哥伦比娅', element: 'hydro', weaponType: 'catalyst' },
      { id: '10000126', name: '兹白', element: 'geo', weaponType: 'sword' },
      { id: '10000127', name: '叶洛亚', element: 'geo', weaponType: 'polearm' }
    ]
  };
}

function verify(
  catalog: KnowledgeProvenanceCatalog = fixtureCatalog(),
  supplementalCharactersBytes: Uint8Array = supplementalBytes
) {
  return verifyKnowledgeProvenance(catalog, {
    charactersBytes,
    localizationBytes,
    supplementalCharactersBytes
  });
}

describe('knowledge provenance pure verifier', () => {
  it('accepts matching pinned snapshots', () => {
    expect(verify()).toMatchObject({
      revision,
      catalogCount: 5,
      exclusionCount: 1,
      supplementalCharactersSha256: sha256Hex(supplementalBytes),
      supplementalCount: 3,
      supplementalCharacterIds: ['10000125', '10000126', '10000127']
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

  it('rejects every Enka-missing catalog ID outside the fixed supplemental allowlist', () => {
    const extendedSupplementalBytes = supplementalSnapshot({
      ...supplementalCharacters,
      unsupported: {
        id: 10000128,
        name: '未授权补充',
        elementType: 'ELEMENT_CRYO',
        weaponType: 'WEAPON_CATALYST'
      }
    });
    const unsupportedAddition = fixtureCatalog(extendedSupplementalBytes);
    unsupportedAddition.characters.push({
      id: '10000128',
      name: '未授权补充',
      element: 'cryo',
      weaponType: 'catalyst'
    });

    expect(() => verify(unsupportedAddition, extendedSupplementalBytes)).toThrow(
      /committed character absent from Enka is not allowlisted.*10000128/i
    );
  });

  it('rejects a missing required supplemental row', () => {
    const missingBytes = supplementalSnapshot({
      columbina: supplementalCharacters.columbina,
      zibai: supplementalCharacters.zibai
    });

    expect(() => verify(fixtureCatalog(missingBytes), missingBytes)).toThrow(
      /supplemental metadata is missing for required character 10000127/i
    );
  });

  it('rejects malformed supplemental structures and required names', () => {
    const malformedStructureBytes = supplementalSnapshot([]);
    expect(() =>
      verify(fixtureCatalog(malformedStructureBytes), malformedStructureBytes)
    ).toThrow(/supplemental character snapshot is missing.*characters/i);

    const malformedNameBytes = supplementalSnapshot({
      ...supplementalCharacters,
      columbina: { ...supplementalCharacters.columbina, name: '' }
    });
    expect(() => verify(fixtureCatalog(malformedNameBytes), malformedNameBytes)).toThrow(
      /invalid supplemental name for required character 10000125/i
    );
  });

  it('rejects unknown element and weapon values on required supplemental rows', () => {
    const unknownElementBytes = supplementalSnapshot({
      ...supplementalCharacters,
      zibai: { ...supplementalCharacters.zibai, elementType: 'ELEMENT_VOID' }
    });
    expect(() => verify(fixtureCatalog(unknownElementBytes), unknownElementBytes)).toThrow(
      /unsupported supplemental element.*10000126.*ELEMENT_VOID/i
    );

    const unknownWeaponBytes = supplementalSnapshot({
      ...supplementalCharacters,
      illuga: { ...supplementalCharacters.illuga, weaponType: 'WEAPON_ORB' }
    });
    expect(() => verify(fixtureCatalog(unknownWeaponBytes), unknownWeaponBytes)).toThrow(
      /unsupported supplemental weapon.*10000127.*WEAPON_ORB/i
    );
  });

  it('rejects duplicate required supplemental IDs even when object keys differ', () => {
    const duplicateBytes = supplementalSnapshot({
      ...supplementalCharacters,
      columbinaDuplicate: { ...supplementalCharacters.columbina }
    });

    expect(() => verify(fixtureCatalog(duplicateBytes), duplicateBytes)).toThrow(
      /duplicate required supplemental character 10000125/i
    );
  });
});
