import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createProductionScenarioPublicationSource } from '../../../src/main/scenario-publication/production-composition.js';

const configPath = path.join(process.cwd(), 'resources', 'scenario-production.json');

describe('committed production scenario config', () => {
  it('enables the signed public feed with the expected production key', async () => {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      enabled: boolean;
      manifestUrl?: string;
      publicKeys?: Record<string, string>;
    };

    expect(config.enabled).toBe(true);
    expect(config.manifestUrl).toBe(
      'https://sorayama.me/genshin-team-advisor-data/manifest.json'
    );
    expect(Object.keys(config.publicKeys ?? {})).toEqual(['scenario-production-2026-01']);

    const source = await createProductionScenarioPublicationSource({
      userDataDir: path.join(process.cwd(), '.tmp-production-config-test'),
      packagedConfigPath: configPath,
      env: {}
    });
    expect(source.status).toBe('configured');
  });
});
