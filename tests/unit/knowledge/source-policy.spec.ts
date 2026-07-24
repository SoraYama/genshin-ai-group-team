import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { committedSourceRegistrySchema } from '../../../src/shared/advisor-knowledge.js';

const repositoryRoot = process.cwd();
const registry = committedSourceRegistrySchema.parse(
  JSON.parse(readFileSync(resolve(repositoryRoot, 'resources/knowledge/sources.v1.json'), 'utf8'))
);

const acceptedHosts = [
  'genshin.hoyoverse.com',
  'hoyolab.com',
  'keqingmains.com',
  'kqm.gg',
  'library.keqingmains.com'
].sort();
const reviewedGuideUrls = [
  'https://keqingmains.com/q/raiden-quickguide/',
  'https://keqingmains.com/q/shinobu-quickguide/',
  'https://keqingmains.com/q/nahida-quickguide/',
  'https://keqingmains.com/q/kokomi-quickguide/',
  'https://keqingmains.com/q/furina-quickguide/'
].sort();
const reviewedMechanicUrls = [
  'https://library.keqingmains.com/combat-mechanics/enemy-mechanics/enemy-shields-armor',
  'https://library.keqingmains.com/combat-mechanics/enemy-mechanics/enemy-resistances',
  'https://library.keqingmains.com/combat-mechanics/damage/other/aoe-scaling',
  'https://library.keqingmains.com/combat-mechanics/damage/shields',
  'https://library.keqingmains.com/evidence/combat-mechanics/enemy-mechanics/enemy-interactions',
  'https://library.keqingmains.com/combat-mechanics/cooldowns',
  'https://library.keqingmains.com/combat-mechanics/energy',
  'https://library.keqingmains.com/combat-mechanics/internal-cooldown'
].sort();

describe('committed advisor source policy', () => {
  it('allows exactly the initial reviewed host registry', () => {
    expect(registry.schemaVersion).toBe(1);
    expect(registry.sourceVersion).toBe('2026-07-25');
    expect(registry.sources.map(({ host }) => host).sort()).toEqual(acceptedHosts);
    expect(registry.sources.every(({ trust }) => trust === 'trusted-local')).toBe(true);
  });

  it('keeps every citation on HTTPS and on its declared exact host', () => {
    const sourcesById = new Map(registry.sources.map((source) => [source.id, source]));

    for (const citation of registry.citations) {
      const url = new URL(citation.url);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe(sourcesById.get(citation.sourceId)?.host);
      expect(acceptedHosts).toContain(url.hostname);
      expect(citation.trust).toBe('trusted-local');
    }
  });

  it('commits only the five reviewed character guides and eight reviewed mechanic pages', () => {
    expect(registry.citations.map(({ url }) => url).sort()).toEqual(
      [...reviewedGuideUrls, ...reviewedMechanicUrls].sort()
    );
    for (const citation of registry.citations) {
      if (citation.subjectCharacterIds.length === 0) {
        expect(citation.subjectMechanicIds?.length).toBeGreaterThan(0);
      } else {
        expect(citation.subjectCharacterIds).toHaveLength(1);
        expect(citation.subjectMechanicIds).toBeUndefined();
      }
      expect(citation.retrievedAt).toMatch(/^2026-07-2[45]T/);
      expect(citation.reviewEvidenceVersion).toBe('paraphrased-evidence-v1');
      expect(citation.reviewEvidenceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(citation).not.toHaveProperty('contentSha256');
    }
  });

  it('credits every source and declares the paraphrase-only policy', () => {
    const credits = readFileSync(resolve(repositoryRoot, 'resources/credits.md'), 'utf8');

    for (const source of registry.sources) {
      expect(credits).toContain(source.id);
    }
    expect(credits).toMatch(/paraphrased summaries/i);
    expect(credits).toMatch(/not copied guide text/i);
    expect(credits).toContain('reviewEvidenceSha256');
    expect(credits).toMatch(/not upstream page HTML/i);
    expect(credits).not.toContain('contentSha256');
  });

  it('packages all committed knowledge JSON files through the existing resource glob', () => {
    const builderConfig = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'electron-builder.json'), 'utf8')
    ) as {
      extraResources: Array<{ from: string; filter?: string[] }>;
    };
    const knowledgeResource = builderConfig.extraResources.find(
      (resource) => resource.from === 'resources/knowledge'
    );

    expect(knowledgeResource?.filter).toContain('**/*.json');
  });

  it('ships the reviewed enemy-mechanic strategy bundle as a committed resource', () => {
    expect(
      existsSync(resolve(repositoryRoot, 'resources/knowledge/enemy-mechanic-strategies.v1.json'))
    ).toBe(true);
  });

  it('wires the deterministic manual Enka provenance gate', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['gate:knowledge-provenance']).toBe(
      'npm run build:main && node dist/main/knowledge-provenance-gate.mjs'
    );
    expect(existsSync(resolve(repositoryRoot, 'src/main/gates/knowledge-provenance.ts'))).toBe(
      true
    );
    expect(existsSync(resolve(repositoryRoot, 'src/main/gates/knowledge-provenance-gate.ts'))).toBe(
      true
    );
  });
});
