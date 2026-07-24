import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { committedAdvisorKnowledgeSetSchema } from '../../../src/main/services/committed-advisor-knowledge.js';
import {
  canonicalJsonStringify,
  committedCharacterCatalogSchema,
  committedCharacterStrategyBundleV2Schema,
  committedReviewEvidenceBundleSchema,
  committedSourceRegistrySchema,
  enemyMechanicStrategyBundleSchema
} from '../../../src/shared/advisor-knowledge.js';

const knowledgeDirectory = resolve(process.cwd(), 'resources/knowledge');

function readJson(fileName: string): unknown {
  return JSON.parse(readFileSync(resolve(knowledgeDirectory, fileName), 'utf8'));
}

const sources = committedSourceRegistrySchema.parse(readJson('sources.v1.json'));
const catalog = committedCharacterCatalogSchema.parse(readJson('character-catalog.v1.json'));
const strategies = committedCharacterStrategyBundleV2Schema.parse(
  readJson('character-strategies.v2.json')
);
const evidence = committedReviewEvidenceBundleSchema.parse(readJson('review-evidence.v1.json'));
const mechanics = enemyMechanicStrategyBundleSchema.parse(
  readJson('enemy-mechanic-strategies.v1.json')
);

function evidenceDigest(entry: (typeof evidence.entries)[number]): string {
  return createHash('sha256').update(canonicalJsonStringify(entry), 'utf8').digest('hex');
}

function policyDigest(archetype: Parameters<typeof canonicalJsonStringify>[0]): string {
  return createHash('sha256').update(canonicalJsonStringify(archetype), 'utf8').digest('hex');
}

function knowledgeSet() {
  return { sources, catalog, strategies, mechanics, evidence };
}

describe('committed paraphrased review evidence', () => {
  it('binds exactly one canonical evidence entry and deterministic digest to each citation', () => {
    expect(evidence.reviewEvidenceVersion).toBe('paraphrased-evidence-v1');
    expect(evidence.entries).toHaveLength(sources.citations.length);

    const evidenceByCitation = new Map(evidence.entries.map((entry) => [entry.citationId, entry]));
    expect(
      evidence.entries.every((entry) =>
        entry.paraphrasedEvidence.every(({ summary }) => /\p{Script=Han}/u.test(summary))
      )
    ).toBe(true);
    for (const citation of sources.citations) {
      const entry = evidenceByCitation.get(citation.id);
      expect(entry).toBeDefined();
      expect(entry?.subjectCharacterIds).toEqual(citation.subjectCharacterIds);
      expect(entry?.subjectMechanicIds ?? []).toEqual(citation.subjectMechanicIds ?? []);
      expect(entry?.url).toBe(citation.url);
      expect(entry?.reviewedAt).toBe(citation.reviewedAt);
      expect(citation.reviewEvidenceVersion).toBe(evidence.reviewEvidenceVersion);
      expect(citation.reviewEvidenceSha256).toBe(evidenceDigest(entry!));
    }

    expect(() => committedAdvisorKnowledgeSetSchema.parse(knowledgeSet())).not.toThrow();
  });

  it('binds every trusted mechanic policy and rejects policy tampering', () => {
    const bindings = evidence.entries.flatMap(({ mechanicBindings }) => mechanicBindings ?? []);

    for (const mechanic of mechanics.mechanics) {
      expect(bindings).toContainEqual({
        mechanicId: mechanic.id,
        policySha256: policyDigest(mechanic)
      });
    }

    const tamperedMechanics = structuredClone(mechanics);
    tamperedMechanics.mechanics[0]!.requiredCapabilities.push('unreviewed-capability');
    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        ...knowledgeSet(),
        mechanics: tamperedMechanics
      }).success
    ).toBe(false);
  });

  it('binds every reviewed archetype policy exactly once and never binds a gap archetype', () => {
    const bindings = evidence.entries.flatMap(({ archetypeBindings }) => archetypeBindings);
    const reviewedArchetypes = strategies.characters
      .filter(({ reviewState }) => reviewState === 'reviewed')
      .flatMap(({ archetypes }) => archetypes);
    const gapIds = new Set(
      strategies.characters
        .filter(({ reviewState }) => reviewState === 'unreviewed')
        .flatMap(({ archetypes }) => archetypes.map(({ id }) => id))
    );

    expect(bindings).toHaveLength(10);
    expect(new Set(bindings.map(({ archetypeId }) => archetypeId)).size).toBe(10);
    expect(bindings.every(({ archetypeId }) => !gapIds.has(archetypeId))).toBe(true);
    for (const archetype of reviewedArchetypes) {
      expect(bindings).toContainEqual({
        archetypeId: archetype.id,
        policySha256: policyDigest(archetype)
      });
    }
  });

  it('rejects missing, swapped, and tampered evidence', () => {
    const missing = structuredClone(evidence);
    missing.entries.pop();
    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({ ...knowledgeSet(), evidence: missing }).success
    ).toBe(false);

    const swapped = structuredClone(evidence);
    swapped.entries[0]!.subjectCharacterIds = ['10000089'];
    const swappedSources = structuredClone(sources);
    swappedSources.citations[0]!.reviewEvidenceSha256 = evidenceDigest(swapped.entries[0]!);
    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        ...knowledgeSet(),
        sources: swappedSources,
        evidence: swapped
      }).success
    ).toBe(false);

    const tampered = structuredClone(evidence);
    tampered.entries[0]!.paraphrasedEvidence[0]!.summary += '（未经重新审核的改动）';
    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({ ...knowledgeSet(), evidence: tampered })
        .success
    ).toBe(false);
  });

  it('rejects evidence fact IDs that do not resolve to the citation subject and fact', () => {
    const invalid = structuredClone(evidence);
    invalid.entries[0]!.paraphrasedEvidence[0]!.factBindings[0]!.factId = 'furina-fanfare-role';
    const updatedSources = structuredClone(sources);
    updatedSources.citations[0]!.reviewEvidenceSha256 = evidenceDigest(invalid.entries[0]!);

    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        ...knowledgeSet(),
        sources: updatedSources,
        evidence: invalid
      }).success
    ).toBe(false);
  });

  it('rejects fact statement tampering when IDs and citations are unchanged', () => {
    const tamperedStrategies = structuredClone(strategies);
    tamperedStrategies.characters
      .flatMap(({ archetypes }) => archetypes)
      .flatMap(({ facts }) => facts)
      .find(({ id }) => id === 'raiden-hb-role')!.statement =
      '未经重新审核的事实陈述，但保留原有 ID 与引用。';

    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        ...knowledgeSet(),
        strategies: tamperedStrategies
      }).success
    ).toBe(false);
  });

  it('rejects unreviewed changes to classification thresholds, weights, and team policy', () => {
    const thresholdTamper = structuredClone(strategies);
    const raidenOnField = thresholdTamper.characters
      .find(({ id }) => id === '10000052')!
      .archetypes.find(({ id }) => id === 'raiden-emblem-on-field')!;
    if (raidenOnField.coverage !== 'reviewed') throw new Error('reviewed fixture is required');
    const erSignal = raidenOnField.signals.find(({ id }) => id === 'raiden-onfield-er')!;
    erSignal.value = 131;
    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        ...knowledgeSet(),
        strategies: thresholdTamper
      }).success
    ).toBe(false);

    const weightTamper = structuredClone(strategies);
    const shinobuHyperbloom = weightTamper.characters
      .find(({ id }) => id === '10000065')!
      .archetypes.find(({ id }) => id === 'shinobu-em-hyperbloom')!;
    if (shinobuHyperbloom.coverage !== 'reviewed') {
      throw new Error('reviewed fixture is required');
    }
    shinobuHyperbloom.signals[0]!.weight = 4;
    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        ...knowledgeSet(),
        strategies: weightTamper
      }).success
    ).toBe(false);

    const teamPolicyTamper = structuredClone(strategies);
    const furina = teamPolicyTamper.characters
      .find(({ id }) => id === '10000089')!
      .archetypes.find(({ id }) => id === 'furina-off-field-fanfare')!;
    if (furina.coverage !== 'reviewed') throw new Error('reviewed fixture is required');
    furina.teammateSlots[0]!.requirements[0] += '（未经重新审核）';
    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        ...knowledgeSet(),
        strategies: teamPolicyTamper
      }).success
    ).toBe(false);
  });

  it('rejects duplicate fact IDs across archetypes', () => {
    const duplicatedStrategies = structuredClone(strategies);
    const raiden = duplicatedStrategies.characters.find(({ id }) => id === '10000052')!;
    raiden.archetypes[1]!.facts[0]!.id = raiden.archetypes[0]!.facts[0]!.id;
    const duplicatedEvidence = structuredClone(evidence);
    duplicatedEvidence.entries[0]!.paraphrasedEvidence[1]!.factBindings[0]!.factId =
      duplicatedEvidence.entries[0]!.paraphrasedEvidence[0]!.factBindings[0]!.factId;
    duplicatedEvidence.entries[0]!.paraphrasedEvidence[1]!.factBindings[0]!.statementSha256 =
      duplicatedEvidence.entries[0]!.paraphrasedEvidence[0]!.factBindings[0]!.statementSha256;
    const duplicatedSources = structuredClone(sources);
    duplicatedSources.citations[0]!.reviewEvidenceSha256 = evidenceDigest(
      duplicatedEvidence.entries[0]!
    );

    expect(
      committedAdvisorKnowledgeSetSchema.safeParse({
        ...knowledgeSet(),
        sources: duplicatedSources,
        strategies: duplicatedStrategies,
        evidence: duplicatedEvidence
      }).success
    ).toBe(false);
  });
});
