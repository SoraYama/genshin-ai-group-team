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

describe('committed advisor source policy', () => {
  it('allows exactly the initial reviewed host registry', () => {
    expect(registry.schemaVersion).toBe(1);
    expect(registry.sourceVersion).toBe('2026-07-24');
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

  it('commits citations for exactly the five reviewed character guides', () => {
    expect(registry.citations.map(({ url }) => url).sort()).toEqual(reviewedGuideUrls);
    for (const citation of registry.citations) {
      expect(citation.subjectCharacterIds).toHaveLength(1);
      expect(citation.retrievedAt).toMatch(/^2026-07-2[45]T/);
      expect(citation.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('credits every source and declares the paraphrase-only policy', () => {
    const credits = readFileSync(resolve(repositoryRoot, 'resources/credits.md'), 'utf8');

    for (const source of registry.sources) {
      expect(credits).toContain(source.id);
    }
    expect(credits).toMatch(/paraphrased summaries/i);
    expect(credits).toMatch(/not copied guide text/i);
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

  it('wires the deterministic manual Enka provenance gate', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['gate:knowledge-provenance']).toBe(
      'node tests/external/knowledge-provenance-gate.mjs'
    );
    expect(
      existsSync(resolve(repositoryRoot, 'tests/external/knowledge-provenance-gate.mjs'))
    ).toBe(true);
  });
});
