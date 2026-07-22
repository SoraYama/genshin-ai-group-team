import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import scenarioPublisherConfig from '../../../tsup.scenario-data.config.js';

interface BuilderConfig {
  files: string[];
  extraResources: Array<{ from: string; filter?: string[] }>;
}

describe('scenario publisher packaging boundary', () => {
  it('keeps signing tools, sources, and development fixtures outside the desktop package', async () => {
    const builder = JSON.parse(
      await readFile(path.join(process.cwd(), 'electron-builder.json'), 'utf8')
    ) as BuilderConfig;

    expect(builder.files).toContain('dist/main/**/*');
    expect(builder.files).toContain('dist/renderer/**/*');
    expect(builder.files).not.toContain('dist/**/*');
    expect(builder.files).toContain('!scripts/**/*');
    expect(
      builder.files
        .filter((entry) => !entry.startsWith('!'))
        .every((entry) => !entry.includes('scripts'))
    ).toBe(true);
    const scenarioResources = builder.extraResources.find(
      (resource) => resource.from === 'resources/scenarios'
    );
    expect(scenarioResources?.filter).toContain('!v2/development-source/**/*');
    expect(scenarioResources?.filter).toContain('!v2/development/**/*');
  });

  it('builds the offline signer only into the tool-only output tree', () => {
    if (typeof scenarioPublisherConfig === 'function') {
      throw new Error('Scenario publisher config must be static for packaging audit');
    }
    const config = Array.isArray(scenarioPublisherConfig)
      ? scenarioPublisherConfig[0]
      : scenarioPublisherConfig;
    expect(config?.outDir).toBe('dist-tools/scenario-data');
  });
});
