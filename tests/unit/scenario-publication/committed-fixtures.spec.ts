import { createPublicKey } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scenarioV2Schema } from '../../../src/shared/scenario-v2.js';
import { scenarioPublicationManifestSchema } from '../../../src/main/scenario-publication/contracts.js';
import { FileScenarioPublicationReader } from '../../../src/main/scenario-publication/readers.js';
import { verifyScenarioPublication } from '../../../src/main/scenario-publication/publication.js';

const fixtureRoot = path.join(process.cwd(), 'resources', 'scenarios', 'v2');

describe('committed development scenario fixtures', () => {
  it('labels every source fixture as development-only and parses all three modes', async () => {
    const sourceRoot = path.join(fixtureRoot, 'development-source');
    const index = JSON.parse(await fs.readFile(path.join(sourceRoot, 'index.json'), 'utf8')) as {
      notice: string;
      candidates: Array<{ inputFile: string; channel: string }>;
    };

    expect(index.notice).toContain('NOT CURRENT LIVE-SERVICE DATA');
    expect(index.candidates).toHaveLength(3);
    const parsed = await Promise.all(
      index.candidates.map(async ({ inputFile, channel }) => {
        expect(channel).toBe('development-sample');
        return scenarioV2Schema.parse(
          JSON.parse(await fs.readFile(path.join(sourceRoot, inputFile), 'utf8'))
        );
      })
    );
    expect(new Set(parsed.map(({ mode }) => mode))).toEqual(
      new Set(['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater'])
    );
  });

  it('verifies each signed current fixture and retains a history index', async () => {
    const publishedRoot = path.join(fixtureRoot, 'development');
    const reader = new FileScenarioPublicationReader(publishedRoot);
    const manifest = scenarioPublicationManifestSchema.parse(await reader.readManifest());
    const publicKey = createPublicKey(
      await fs.readFile(path.join(fixtureRoot, 'development-public-key.pem'), 'utf8')
    );

    for (const mode of ['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater'] as const) {
      const index = manifest.modes[mode];
      expect(index.current?.channel).toBe('development-sample');
      expect(index.history.length).toBeGreaterThanOrEqual(1);
      const descriptor = index.current!;
      const payload = await reader.readJson(descriptor.payloadPath);
      const integrity = await reader.readJson(descriptor.integrityPath);
      expect(
        verifyScenarioPublication(payload, integrity, {
          'development-sample-key-v1': publicKey
        }).mode
      ).toBe(mode);
    }
  });
});
