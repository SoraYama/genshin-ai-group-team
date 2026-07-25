import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export interface KnowledgeProvenanceCatalog {
  provenance: Array<{ id: string; url: string; sha256: string }>;
  exclusions: Array<{
    id: string;
    kind: string;
    canonicalId?: string;
  }>;
  characters: Array<{
    id: string;
    name: string;
    element: string;
    weaponType: string;
  }>;
}

export interface KnowledgeProvenanceSnapshots {
  charactersBytes: Uint8Array;
  localizationBytes: Uint8Array;
  supplementalCharactersBytes: Uint8Array;
}

export interface KnowledgeProvenanceReport {
  revision: string;
  catalogCount: number;
  exclusionCount: number;
  charactersSha256: string;
  localizationSha256: string;
  supplementalCharactersSha256: string;
  supplementalCount: number;
  supplementalCharacterIds: string[];
}

const elementByEnkaValue: Readonly<Record<string, string>> = {
  Wind: 'anemo',
  Rock: 'geo',
  Electric: 'electro',
  Grass: 'dendro',
  Water: 'hydro',
  Fire: 'pyro',
  Ice: 'cryo'
};
const weaponByEnkaValue: Readonly<Record<string, string>> = {
  WEAPON_SWORD_ONE_HAND: 'sword',
  WEAPON_CLAYMORE: 'claymore',
  WEAPON_POLE: 'polearm',
  WEAPON_BOW: 'bow',
  WEAPON_CATALYST: 'catalyst'
};
const pinnedUrlPattern =
  /^https:\/\/raw\.githubusercontent\.com\/EnkaNetwork\/API-docs\/([0-9a-f]{40})\/store\/(characters|loc)\.json$/;
const supplementalUrlPattern =
  /^https:\/\/raw\.githubusercontent\.com\/theBowja\/genshin-db-dist\/([0-9a-f]{40})\/data\/scripts\/chinesesimplified-characters\.js$/;
const supplementalPayloadPattern = /n\(574\)\("(?<payload>H4sI[A-Za-z0-9+/=]+)"\)/u;
const supplementalElementByValue: Readonly<Record<string, string>> = {
  ELEMENT_ANEMO: 'anemo',
  ELEMENT_GEO: 'geo',
  ELEMENT_ELECTRO: 'electro',
  ELEMENT_DENDRO: 'dendro',
  ELEMENT_HYDRO: 'hydro',
  ELEMENT_PYRO: 'pyro',
  ELEMENT_CRYO: 'cryo'
};
const requiredSupplementalCharacterIds = ['10000125', '10000126', '10000127'] as const;
const requiredSupplementalCharacterIdSet: ReadonlySet<string> = new Set(
  requiredSupplementalCharacterIds
);

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyKnowledgeProvenance(
  catalog: KnowledgeProvenanceCatalog,
  snapshots: KnowledgeProvenanceSnapshots
): KnowledgeProvenanceReport {
  const charactersProvenance = requireProvenance(catalog, 'enka-characters', 'characters');
  const localizationProvenance = requireProvenance(catalog, 'enka-localization', 'loc');
  const supplementalProvenance = requireSupplementalProvenance(catalog);
  const revision = pinnedRevision(charactersProvenance.url, 'characters');
  const localizationRevision = pinnedRevision(localizationProvenance.url, 'loc');
  if (localizationRevision !== revision) {
    throw new Error('Character and localization provenance must use the same pinned revision');
  }

  const charactersSha256 = verifyDigest(charactersProvenance, snapshots.charactersBytes);
  const localizationSha256 = verifyDigest(localizationProvenance, snapshots.localizationBytes);
  const supplementalCharactersSha256 = verifyDigest(
    supplementalProvenance,
    snapshots.supplementalCharactersBytes
  );
  const characters = parseObjectSnapshot(snapshots.charactersBytes, 'characters');
  const localization = parseObjectSnapshot(snapshots.localizationBytes, 'localization');
  const supplementalCharacters = parseSupplementalCharacters(
    snapshots.supplementalCharactersBytes
  );
  const populatedRows = populatedCharacterRows(characters);
  const populatedIds = new Set(populatedRows.map(([id]) => id));
  const committedIds = new Set(catalog.characters.map(({ id }) => id));
  const exclusionIds = new Set(catalog.exclusions.map(({ id }) => id));
  const unsupportedSupplementalIds = [...committedIds].filter(
    (id) => !populatedIds.has(id) && !requiredSupplementalCharacterIdSet.has(id)
  );
  if (unsupportedSupplementalIds.length > 0) {
    throw new Error(
      `Committed character absent from Enka is not allowlisted for supplemental provenance: ${unsupportedSupplementalIds
        .sort()
        .join(', ')}`
    );
  }
  const missingCommittedSupplementalIds = requiredSupplementalCharacterIds.filter(
    (id) => !committedIds.has(id)
  );
  if (missingCommittedSupplementalIds.length > 0) {
    throw new Error(
      `Required supplemental character is missing from committed catalog: ${missingCommittedSupplementalIds.join(
        ', '
      )}`
    );
  }

  const missingExclusions = [...populatedIds].filter(
    (id) => !committedIds.has(id) && !exclusionIds.has(id)
  );
  if (missingExclusions.length > 0) {
    throw new Error(
      `Missing exclusion audit entries for upstream rows: ${missingExclusions.sort().join(', ')}`
    );
  }

  for (const exclusion of catalog.exclusions) {
    if (!populatedIds.has(exclusion.id)) {
      throw new Error(`Excluded upstream row no longer exists: ${exclusion.id}`);
    }
    if (exclusion.kind === 'alternate-variant') {
      if (
        !exclusion.canonicalId ||
        (!populatedIds.has(exclusion.canonicalId) &&
          !supplementalCharacters.has(exclusion.canonicalId)) ||
        !committedIds.has(exclusion.canonicalId)
      ) {
        throw new Error(
          `Alternate exclusion ${exclusion.id} points to missing canonical row ${
            exclusion.canonicalId ?? 'undefined'
          }`
        );
      }
    }
  }

  const zhCn = localization['zh-cn'];
  if (!isRecord(zhCn)) throw new Error('Localization snapshot is missing zh-cn');
  const reconstructed = populatedRows
    .filter(([id]) => !exclusionIds.has(id))
    .map(([id, value]) => normalizeCharacter(id, value, zhCn))
    .concat(
      requiredSupplementalCharacterIds.map((id) => {
        const character = supplementalCharacters.get(id);
        if (!character) {
          throw new Error(`Supplemental metadata is missing for required character ${id}`);
        }
        return character;
      })
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const committed = catalog.characters
    .map(({ id, name, element, weaponType }) => ({ id, name, element, weaponType }))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (reconstructed.length !== committed.length) {
    throw new Error(
      `Catalog length mismatch: upstream=${reconstructed.length} committed=${committed.length}`
    );
  }
  const mismatchIndex = reconstructed.findIndex(
    (entry, index) => JSON.stringify(entry) !== JSON.stringify(committed[index])
  );
  if (mismatchIndex >= 0) {
    throw new Error(
      `Catalog differs from pinned Enka data at index ${mismatchIndex}: upstream=${JSON.stringify(
        reconstructed[mismatchIndex]
      )} committed=${JSON.stringify(committed[mismatchIndex])}`
    );
  }

  return {
    revision,
    catalogCount: committed.length,
    exclusionCount: catalog.exclusions.length,
    charactersSha256,
    localizationSha256,
    supplementalCharactersSha256,
    supplementalCount: requiredSupplementalCharacterIds.length,
    supplementalCharacterIds: [...requiredSupplementalCharacterIds]
  };
}

function requireSupplementalProvenance(
  catalog: KnowledgeProvenanceCatalog
): KnowledgeProvenanceCatalog['provenance'][number] {
  const provenance = catalog.provenance.find(
    ({ id }) => id === 'genshin-db-dist-characters'
  );
  if (!provenance) throw new Error('Missing provenance entry: genshin-db-dist-characters');
  if (!supplementalUrlPattern.test(provenance.url)) {
    throw new Error(`Provenance URL is not pinned to an immutable commit: ${provenance.url}`);
  }
  return provenance;
}

function requireProvenance(
  catalog: KnowledgeProvenanceCatalog,
  id: string,
  expectedFile: 'characters' | 'loc'
): KnowledgeProvenanceCatalog['provenance'][number] {
  const provenance = catalog.provenance.find((entry) => entry.id === id);
  if (!provenance) throw new Error(`Missing provenance entry: ${id}`);
  const match = provenance.url.match(pinnedUrlPattern);
  if (!match || match[2] !== expectedFile) {
    throw new Error(`Provenance URL is not pinned to an immutable commit: ${provenance.url}`);
  }
  return provenance;
}

function pinnedRevision(url: string, expectedFile: 'characters' | 'loc'): string {
  const match = url.match(pinnedUrlPattern);
  if (!match || match[2] !== expectedFile || !match[1]) {
    throw new Error(`Provenance URL is not pinned to an immutable commit: ${url}`);
  }
  return match[1];
}

function verifyDigest(
  provenance: KnowledgeProvenanceCatalog['provenance'][number],
  bytes: Uint8Array
): string {
  const actual = sha256Hex(bytes);
  if (actual !== provenance.sha256) {
    throw new Error(
      `Digest mismatch for ${provenance.id}: expected ${provenance.sha256}, got ${actual}`
    );
  }
  return actual;
}

function parseObjectSnapshot(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${label} snapshot is not valid JSON`);
  }
  if (!isRecord(value)) throw new Error(`${label} snapshot must contain a JSON object`);
  return value;
}

function parseSupplementalCharacters(
  bytes: Uint8Array
): Map<string, { id: string; name: string; element: string; weaponType: string }> {
  const source = new TextDecoder().decode(bytes);
  const payload = supplementalPayloadPattern.exec(source)?.groups?.['payload'];
  if (payload === undefined) {
    throw new Error('Supplemental character snapshot does not contain the expected gzip payload');
  }

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(gunzipSync(Buffer.from(payload, 'base64'))));
  } catch {
    throw new Error('Supplemental character snapshot payload is not valid gzip JSON');
  }
  const characters = nestedRecord(document, ['data', 'ChineseSimplified', 'characters']);
  const normalized = new Map<
    string,
    { id: string; name: string; element: string; weaponType: string }
  >();
  const seenRequiredIds = new Set<string>();
  for (const value of Object.values(characters)) {
    if (!isRecord(value)) continue;
    const id = String(value['id']);
    if (!requiredSupplementalCharacterIdSet.has(id)) continue;
    if (seenRequiredIds.has(id)) {
      throw new Error(`Duplicate required supplemental character ${id}`);
    }
    seenRequiredIds.add(id);
    const name = value['name'];
    if (typeof name !== 'string' || name.length === 0 || name !== name.trim()) {
      throw new Error(`Invalid supplemental name for required character ${id}`);
    }
    const rawElement = value['elementType'];
    const element =
      typeof rawElement === 'string' ? supplementalElementByValue[rawElement] : undefined;
    if (!element) {
      throw new Error(
        `Unsupported supplemental element for required character ${id}: ${String(rawElement)}`
      );
    }
    const rawWeapon = value['weaponType'];
    const weaponType =
      typeof rawWeapon === 'string' ? weaponByEnkaValue[rawWeapon] : undefined;
    if (!weaponType) {
      throw new Error(
        `Unsupported supplemental weapon for required character ${id}: ${String(rawWeapon)}`
      );
    }
    normalized.set(id, { id, name, element, weaponType });
  }
  for (const id of requiredSupplementalCharacterIds) {
    if (!normalized.has(id)) {
      throw new Error(`Supplemental metadata is missing for required character ${id}`);
    }
  }
  return normalized;
}

function nestedRecord(value: unknown, path: readonly string[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      throw new Error(`Supplemental character snapshot is missing ${path.join('.')}`);
    }
    current = current[key];
  }
  if (!isRecord(current)) {
    throw new Error(`Supplemental character snapshot is missing ${path.join('.')}`);
  }
  return current;
}

function populatedCharacterRows(
  characters: Record<string, unknown>
): Array<[string, Record<string, unknown>]> {
  return Object.entries(characters).filter((entry): entry is [string, Record<string, unknown>] => {
    const [id, value] = entry;
    return (
      /^[0-9]+$/.test(id) &&
      isRecord(value) &&
      value.NameTextMapHash !== undefined &&
      typeof value.Element === 'string' &&
      typeof value.WeaponType === 'string'
    );
  });
}

function normalizeCharacter(
  id: string,
  value: Record<string, unknown>,
  zhCn: Record<string, unknown>
) {
  const element = typeof value.Element === 'string' ? elementByEnkaValue[value.Element] : undefined;
  const weaponType =
    typeof value.WeaponType === 'string' ? weaponByEnkaValue[value.WeaponType] : undefined;
  const name = zhCn[String(value.NameTextMapHash)];
  if (!element || !weaponType || typeof name !== 'string' || name.length === 0) {
    throw new Error(`Unsupported or incomplete upstream metadata for character ${id}`);
  }
  return { id, name, element, weaponType };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
