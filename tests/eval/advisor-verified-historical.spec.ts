import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const fixturePath = path.resolve(
  import.meta.dirname,
  '../fixtures/verified-historical/advisor-rules.json'
);

describe('source-verified historical gameplay facts', () => {
  it('keeps provenance and the absence of a current production feed explicit', async () => {
    const fixture = await loadFixture();
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.scope).toBe('verified-historical-facts-only');
    expect(fixture.retrievedAt).toBe('2026-07-23');
    expect(fixture.license).toBe('CC BY-SA 3.0');
    expect(fixture.attribution).toContain('Genshin Impact Wiki');
    expect(fixture.currentProductionScenarioAvailable).toBe(false);
    for (const mode of [
      fixture.spiralAbyss,
      fixture.imaginariumTheater,
      fixture.stygianOnslaught
    ]) {
      expect(mode.sourceUrl).toMatch(/^https:\/\/genshin-impact\.fandom\.com\/wiki\//u);
      expect(mode.rulesSourceUrl).toMatch(/^https:\/\/genshin-impact\.fandom\.com\/wiki\//u);
      expect(mode.snapshot).toBeTruthy();
    }
  });

  it('anchors the three planners to sourced historical rule shapes', async () => {
    const fixture = await loadFixture();
    expect(fixture.spiralAbyss).toMatchObject({
      chambersPerFloor: 3,
      halvesPerChamber: 2,
      partySizePerHalf: 4,
      sameCharacterAcrossHalves: false
    });
    expect(fixture.imaginariumTheater).toMatchObject({
      acts: 10,
      partySizePerAct: 4,
      vigorPerCharacter: 2,
      vigorCostPerAct: 1,
      hardMinimumLevel: 70,
      eligibleElements: ['Pyro', 'Hydro', 'Cryo']
    });
    expect(fixture.imaginariumTheater.openingCharacters).toHaveLength(6);
    expect(fixture.imaginariumTheater.specialGuests).toHaveLength(4);
    expect(fixture.stygianOnslaught).toMatchObject({
      battlefields: 3,
      timedPhases: 3,
      battlefieldNames: ['Glacial Wolf', 'Hydro Tulpa', 'The Open-Eyed']
    });
    expect(fixture.stygianOnslaught.difficultyNames).toHaveLength(6);
  });
});

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}
