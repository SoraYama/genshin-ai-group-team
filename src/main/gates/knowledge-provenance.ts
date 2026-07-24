import { createHash } from 'node:crypto';

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
}

export interface KnowledgeProvenanceReport {
  revision: string;
  catalogCount: number;
  exclusionCount: number;
  charactersSha256: string;
  localizationSha256: string;
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

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyKnowledgeProvenance(
  catalog: KnowledgeProvenanceCatalog,
  snapshots: KnowledgeProvenanceSnapshots
): KnowledgeProvenanceReport {
  const charactersProvenance = requireProvenance(catalog, 'enka-characters', 'characters');
  const localizationProvenance = requireProvenance(catalog, 'enka-localization', 'loc');
  const revision = pinnedRevision(charactersProvenance.url, 'characters');
  const localizationRevision = pinnedRevision(localizationProvenance.url, 'loc');
  if (localizationRevision !== revision) {
    throw new Error('Character and localization provenance must use the same pinned revision');
  }

  const charactersSha256 = verifyDigest(charactersProvenance, snapshots.charactersBytes);
  const localizationSha256 = verifyDigest(localizationProvenance, snapshots.localizationBytes);
  const characters = parseObjectSnapshot(snapshots.charactersBytes, 'characters');
  const localization = parseObjectSnapshot(snapshots.localizationBytes, 'localization');
  const populatedRows = populatedCharacterRows(characters);
  const populatedIds = new Set(populatedRows.map(([id]) => id));
  const committedIds = new Set(catalog.characters.map(({ id }) => id));
  const exclusionIds = new Set(catalog.exclusions.map(({ id }) => id));

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
        !populatedIds.has(exclusion.canonicalId) ||
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
    localizationSha256
  };
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
