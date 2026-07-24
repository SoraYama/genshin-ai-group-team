import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const catalogPath = fileURLToPath(
  new URL('../../resources/knowledge/character-catalog.v1.json', import.meta.url)
);
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));

const elementByEnkaValue = {
  Wind: 'anemo',
  Rock: 'geo',
  Electric: 'electro',
  Grass: 'dendro',
  Water: 'hydro',
  Fire: 'pyro',
  Ice: 'cryo'
};
const weaponByEnkaValue = {
  WEAPON_SWORD_ONE_HAND: 'sword',
  WEAPON_CLAYMORE: 'claymore',
  WEAPON_POLE: 'polearm',
  WEAPON_BOW: 'bow',
  WEAPON_CATALYST: 'catalyst'
};

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchPinnedSnapshot(provenanceId) {
  const provenance = catalog.provenance.find(({ id }) => id === provenanceId);
  if (!provenance) throw new Error(`Missing provenance entry: ${provenanceId}`);
  if (
    !/^https:\/\/raw\.githubusercontent\.com\/EnkaNetwork\/API-docs\/[0-9a-f]{40}\/store\/(?:characters|loc)\.json$/.test(
      provenance.url
    )
  ) {
    throw new Error(`Provenance URL is not pinned to an immutable commit: ${provenance.url}`);
  }

  const response = await fetch(provenance.url, {
    headers: { 'user-agent': 'genshin-team-advisor-knowledge-provenance/1.0' },
    redirect: 'follow'
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${provenance.url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = digest(bytes);
  if (actualSha256 !== provenance.sha256) {
    throw new Error(
      `Digest mismatch for ${provenanceId}: expected ${provenance.sha256}, got ${actualSha256}`
    );
  }
  return { provenance, json: JSON.parse(bytes.toString('utf8')) };
}

function normalizeUpstreamCharacters(characters, localization) {
  const excludedIds = new Set(catalog.exclusions.map(({ id }) => id));
  const populatedRows = Object.entries(characters).filter(
    ([id, value]) =>
      /^[0-9]+$/.test(id) &&
      value &&
      typeof value === 'object' &&
      value.NameTextMapHash &&
      value.Element &&
      value.WeaponType
  );

  for (const exclusion of catalog.exclusions) {
    if (!populatedRows.some(([id]) => id === exclusion.id)) {
      throw new Error(`Excluded upstream row no longer exists: ${exclusion.id}`);
    }
    if (
      exclusion.kind === 'alternate-variant' &&
      !populatedRows.some(([id]) => id === exclusion.canonicalId)
    ) {
      throw new Error(
        `Alternate exclusion ${exclusion.id} points to missing canonical row ${exclusion.canonicalId}`
      );
    }
  }

  return populatedRows
    .filter(([id]) => !excludedIds.has(id))
    .map(([id, value]) => {
      const element = elementByEnkaValue[value.Element];
      const weaponType = weaponByEnkaValue[value.WeaponType];
      const name = localization['zh-cn']?.[String(value.NameTextMapHash)];
      if (!element || !weaponType || typeof name !== 'string' || name.length === 0) {
        throw new Error(`Unsupported or incomplete upstream metadata for character ${id}`);
      }
      return { id, name, element, weaponType };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

const [charactersSnapshot, localizationSnapshot] = await Promise.all([
  fetchPinnedSnapshot('enka-characters'),
  fetchPinnedSnapshot('enka-localization')
]);
const reconstructed = normalizeUpstreamCharacters(
  charactersSnapshot.json,
  localizationSnapshot.json
);
const committed = catalog.characters
  .map(({ id, name, element, weaponType }) => ({ id, name, element, weaponType }))
  .sort((left, right) => left.id.localeCompare(right.id));

if (JSON.stringify(reconstructed) !== JSON.stringify(committed)) {
  const mismatchIndex = reconstructed.findIndex(
    (entry, index) => JSON.stringify(entry) !== JSON.stringify(committed[index])
  );
  throw new Error(
    `Catalog differs from pinned Enka data at index ${mismatchIndex}: upstream=${JSON.stringify(
      reconstructed[mismatchIndex]
    )} committed=${JSON.stringify(committed[mismatchIndex])}`
  );
}

const revision = charactersSnapshot.provenance.url.match(/API-docs\/([0-9a-f]{40})\/store/)?.[1];
if (!revision || !localizationSnapshot.provenance.url.includes(`/API-docs/${revision}/store/`)) {
  throw new Error('Character and localization provenance must use the same pinned revision');
}

console.log(
  `[knowledge-provenance] verified revision=${revision} catalog=${committed.length} exclusions=${catalog.exclusions.length} charactersSha256=${charactersSnapshot.provenance.sha256} locSha256=${localizationSnapshot.provenance.sha256} weaponType=verified`
);
