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

  it('fails bootstrap on trusted strategy bundle loading and injects it only into Abyss', async () => {
    const mainSource = await readFile(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const abyssWiring = mainSource.slice(
      mainSource.indexOf('const abyssAdvisor = new AbyssAdvisorService({'),
      mainSource.indexOf('const stygianScenario = new StygianScenarioService({')
    );
    const stygianWiring = mainSource.slice(
      mainSource.indexOf('const stygianAdvisor = new StygianAdvisorService({'),
      mainSource.indexOf('const theaterScenario = new TheaterScenarioService({')
    );
    const theaterWiring = mainSource.slice(
      mainSource.indexOf('const theaterAdvisor = new TheaterAdvisorService({'),
      mainSource.indexOf('const updates = new UpdateService({')
    );

    expect(mainSource).toContain('function resolveBundledKnowledgeDir(): string');
    expect(mainSource).toContain('KnowledgeBundleStore.load(knowledgeDir)');
    expect(abyssWiring).toContain('strategyKnowledge');
    expect(abyssWiring).toContain('advisorKnowledge');
    expect(abyssWiring).toContain('coverageGate: knowledgeCoverageGate');
    expect(abyssWiring).toContain('new GuideResearchAgent({');
    expect(abyssWiring).toContain('supportsCharacterCitation');
    expect(abyssWiring).toContain("signal.addEventListener('abort', abortResearch");
    expect(abyssWiring).toContain('signal.aborted');
    expect(abyssWiring).toContain('Guide research was cancelled before cache write.');
    for (const unrelatedModeWiring of [stygianWiring, theaterWiring]) {
      expect(unrelatedModeWiring).not.toContain('strategyKnowledge');
      expect(unrelatedModeWiring).not.toContain('advisorKnowledge');
      expect(unrelatedModeWiring).not.toContain('coverageGate');
      expect(unrelatedModeWiring).not.toContain('GuideResearchAgent');
    }
    expect(mainSource).toContain("name: 'KnowledgeBundleLoadError'");
    expect(mainSource).toContain('message: error.message');
    expect(mainSource).toContain("message: 'Unexpected startup failure'");
    expect(mainSource).toContain(
      "console.error('[bootstrap] application startup failed', bootstrapErrorSummary(error))"
    );
  });
});
