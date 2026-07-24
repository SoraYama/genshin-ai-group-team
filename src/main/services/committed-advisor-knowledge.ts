import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
  committedAdvisorKnowledgeSetStructureSchema
} from '../../shared/advisor-knowledge.js';

export const committedAdvisorKnowledgeSetSchema =
  committedAdvisorKnowledgeSetStructureSchema.superRefine(
    ({ sources, strategies, mechanics, evidence }, context) => {
      const sourceRegistrySha256 = createHash('sha256')
        .update(canonicalJsonStringify(sources), 'utf8')
        .digest('hex');
      if (evidence.sourceRegistrySha256 !== sourceRegistrySha256) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', 'sourceRegistrySha256'],
          message: 'Review evidence must bind the complete canonical source registry'
        });
      }
      if (mechanics.sourceRegistrySha256 !== sourceRegistrySha256) {
        context.addIssue({
          code: 'custom',
          path: ['mechanics', 'sourceRegistrySha256'],
          message: 'Mechanic knowledge must bind the complete canonical source registry'
        });
      }

      const factsById = new Map<
        string,
        Array<{ characterId: string; citationIds: string[]; statement: string }>
      >();
      const reviewedArchetypesById = new Map<
        string,
        {
          characterId: string;
          archetype: (typeof strategies.characters)[number]['archetypes'][number];
        }
      >();
      const mechanicsById = new Map(mechanics.mechanics.map((mechanic) => [mechanic.id, mechanic]));
      for (const character of strategies.characters) {
        for (const archetype of character.archetypes) {
          if (archetype.coverage === 'reviewed') {
            reviewedArchetypesById.set(archetype.id, {
              characterId: character.id,
              archetype
            });
          }
          for (const fact of archetype.facts) {
            const owners = factsById.get(fact.id) ?? [];
            owners.push({
              characterId: character.id,
              citationIds: fact.citationIds,
              statement: fact.statement
            });
            factsById.set(fact.id, owners);
          }
        }
      }
      for (const mechanic of mechanics.mechanics) {
        for (const fact of mechanic.facts) {
          const owners = factsById.get(fact.id) ?? [];
          owners.push({
            characterId: `mechanic:${mechanic.id}`,
            citationIds: fact.citationIds,
            statement: fact.statement
          });
          factsById.set(fact.id, owners);
        }
      }

      const policyBindingCounts = new Map<string, number>();
      evidence.entries.forEach((entry, evidenceIndex) => {
        entry.archetypeBindings.forEach(({ archetypeId, policySha256 }, bindingIndex) => {
          const owner = reviewedArchetypesById.get(archetypeId);
          if (owner === undefined || !entry.subjectCharacterIds.includes(owner.characterId)) {
            context.addIssue({
              code: 'custom',
              path: [
                'evidence',
                'entries',
                evidenceIndex,
                'archetypeBindings',
                bindingIndex,
                'archetypeId'
              ],
              message:
                'Review evidence archetype binding must resolve to a reviewed subject archetype'
            });
            return;
          }
          policyBindingCounts.set(archetypeId, (policyBindingCounts.get(archetypeId) ?? 0) + 1);
          const actualPolicyDigest = createHash('sha256')
            .update(canonicalJsonStringify(owner.archetype), 'utf8')
            .digest('hex');
          if (actualPolicyDigest !== policySha256) {
            context.addIssue({
              code: 'custom',
              path: [
                'evidence',
                'entries',
                evidenceIndex,
                'archetypeBindings',
                bindingIndex,
                'policySha256'
              ],
              message: 'Review evidence policy digest must match its canonical reviewed archetype'
            });
          }
        });
      });
      reviewedArchetypesById.forEach((_owner, archetypeId) => {
        if (policyBindingCounts.get(archetypeId) !== 1) {
          context.addIssue({
            code: 'custom',
            path: ['evidence', 'entries'],
            message: `Reviewed archetype ${archetypeId} must have exactly one policy binding`
          });
        }
      });

      const mechanicPolicyBindingCounts = new Map<string, number>();
      evidence.entries.forEach((entry, evidenceIndex) => {
        (entry.mechanicBindings ?? []).forEach(({ mechanicId, policySha256 }, bindingIndex) => {
          const mechanic = mechanicsById.get(mechanicId);
          if (mechanic === undefined || !(entry.subjectMechanicIds ?? []).includes(mechanicId)) {
            context.addIssue({
              code: 'custom',
              path: [
                'evidence',
                'entries',
                evidenceIndex,
                'mechanicBindings',
                bindingIndex,
                'mechanicId'
              ],
              message: 'Review evidence mechanic binding must resolve to a subject mechanic'
            });
            return;
          }
          mechanicPolicyBindingCounts.set(
            mechanicId,
            (mechanicPolicyBindingCounts.get(mechanicId) ?? 0) + 1
          );
          const actualPolicyDigest = createHash('sha256')
            .update(canonicalJsonStringify(mechanic), 'utf8')
            .digest('hex');
          if (actualPolicyDigest !== policySha256) {
            context.addIssue({
              code: 'custom',
              path: [
                'evidence',
                'entries',
                evidenceIndex,
                'mechanicBindings',
                bindingIndex,
                'policySha256'
              ],
              message: 'Review evidence policy digest must match its canonical mechanic policy'
            });
          }
        });
      });
      mechanicsById.forEach((_mechanic, mechanicId) => {
        if ((mechanicPolicyBindingCounts.get(mechanicId) ?? 0) < 1) {
          context.addIssue({
            code: 'custom',
            path: ['evidence', 'entries'],
            message: `Mechanic ${mechanicId} must have at least one policy binding`
          });
        }
      });

      evidence.entries.forEach((entry, evidenceIndex) => {
        entry.paraphrasedEvidence.forEach(({ factBindings }, itemIndex) => {
          factBindings.forEach(({ factId, statementSha256 }, bindingIndex) => {
            const owner = (factsById.get(factId) ?? []).find(
              ({ characterId, citationIds }) =>
                (entry.subjectCharacterIds.includes(characterId) ||
                  (characterId.startsWith('mechanic:') &&
                    (entry.subjectMechanicIds ?? []).includes(characterId.slice(9)))) &&
                citationIds.includes(entry.citationId)
            );
            if (owner === undefined) return;
            const actualStatementDigest = createHash('sha256')
              .update(owner.statement, 'utf8')
              .digest('hex');
            if (actualStatementDigest !== statementSha256) {
              context.addIssue({
                code: 'custom',
                path: [
                  'evidence',
                  'entries',
                  evidenceIndex,
                  'paraphrasedEvidence',
                  itemIndex,
                  'factBindings',
                  bindingIndex,
                  'statementSha256'
                ],
                message: 'Review evidence fact digest must match its canonical strategy statement'
              });
            }
          });
        });
      });

      const evidenceByCitationId = new Map(
        evidence.entries.map((entry) => [entry.citationId, entry])
      );
      sources.citations.forEach((citation, citationIndex) => {
        const entry = evidenceByCitationId.get(citation.id);
        if (entry === undefined) return;
        const actualDigest = createHash('sha256')
          .update(canonicalJsonStringify(entry), 'utf8')
          .digest('hex');
        if (actualDigest !== citation.reviewEvidenceSha256) {
          context.addIssue({
            code: 'custom',
            path: ['sources', 'citations', citationIndex, 'reviewEvidenceSha256'],
            message: 'Citation review evidence digest must match its canonical evidence entry'
          });
        }
      });
    }
  );
