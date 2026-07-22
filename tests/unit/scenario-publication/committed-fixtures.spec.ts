import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  developmentFixtureIndexSchema,
  developmentScenarioFixtureSchema
} from '../../../src/main/scenario-publication/development-fixture.js';
import { createScenarioPublicationBundle } from '../../../src/main/scenario-publication/publisher.js';

const sourceRoot = path.join(process.cwd(), 'resources', 'scenarios', 'v2', 'development-source');

describe('committed development scenario fixtures', () => {
  it('uses synthetic development provenance for all three current/history fixtures', async () => {
    const index = developmentFixtureIndexSchema.parse(
      JSON.parse(await fs.readFile(path.join(sourceRoot, 'index.json'), 'utf8'))
    );

    expect(index.notice).toContain('NOT CURRENT LIVE-SERVICE DATA');
    for (const mode of ['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater'] as const) {
      const modeIndex = index.modes[mode];
      expect(modeIndex.history).toContain(modeIndex.current);
      const rawText = await fs.readFile(path.join(sourceRoot, modeIndex.current), 'utf8');
      expect(rawText).not.toContain('genshin-db');
      const fixture = developmentScenarioFixtureSchema.parse(JSON.parse(rawText));
      expect(fixture.fixtureKind).toBe('development-only');
      expect(fixture.scenario.mode).toBe(mode);
      expect(fixture.meta.syntheticProvenance.kind).toBe('synthetic-development-data');
      expect(fixture.meta.syntheticProvenance.fields.length).toBeGreaterThan(0);
    }
  });

  it('cannot pass a development-only wrapper through the production publisher', async () => {
    const index = developmentFixtureIndexSchema.parse(
      JSON.parse(await fs.readFile(path.join(sourceRoot, 'index.json'), 'utf8'))
    );
    const fixture = developmentScenarioFixtureSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(sourceRoot, index.modes['spiral-abyss'].current), 'utf8')
      )
    );
    const keys = generateKeyPairSync('ed25519');

    expect(() =>
      createScenarioPublicationBundle(
        [{ payload: fixture, current: true, channel: 'production' }],
        {
          keyId: 'production-test-key',
          privateKey: keys.privateKey,
          publishedAt: '2026-01-01T02:00:00.000Z'
        }
      )
    ).toThrowError(expect.objectContaining({ code: 'schema-invalid' }));
  });
});
