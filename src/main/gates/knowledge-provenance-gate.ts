import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { committedCharacterCatalogSchema } from '../../shared/advisor-knowledge.js';
import { verifyKnowledgeProvenance } from './knowledge-provenance.js';

const catalogPath = path.resolve('resources/knowledge/character-catalog.v1.json');
const catalog = committedCharacterCatalogSchema.parse(
  JSON.parse(await readFile(catalogPath, 'utf8'))
);
const provenanceById = new Map(catalog.provenance.map((entry) => [entry.id, entry]));

const [charactersBytes, localizationBytes, supplementalCharactersBytes] = await Promise.all([
  fetchSnapshot(provenanceById.get('enka-characters')?.url),
  fetchSnapshot(provenanceById.get('enka-localization')?.url),
  fetchSnapshot(provenanceById.get('genshin-db-dist-characters')?.url)
]);
const report = verifyKnowledgeProvenance(catalog, {
  charactersBytes,
  localizationBytes,
  supplementalCharactersBytes
});

console.log(
  `[knowledge-provenance] verified revision=${report.revision} catalog=${report.catalogCount} exclusions=${report.exclusionCount} charactersSha256=${report.charactersSha256} locSha256=${report.localizationSha256} supplementalSha256=${report.supplementalCharactersSha256} supplementalCount=${report.supplementalCount} supplementalIds=${report.supplementalCharacterIds.join(',')} weaponType=verified`
);

async function fetchSnapshot(url: string | undefined): Promise<Uint8Array> {
  if (!url) throw new Error('Catalog is missing a required provenance URL');
  const response = await fetch(url, {
    headers: { 'user-agent': 'genshin-team-advisor-knowledge-provenance/1.0' },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
