import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
  committedAdvisorKnowledgeSetStructureSchema
} from '../../shared/advisor-knowledge.js';

export const committedAdvisorKnowledgeSetSchema =
  committedAdvisorKnowledgeSetStructureSchema.superRefine(
    ({ sources, strategies, evidence }, context) => {
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

      evidence.entries.forEach((entry, evidenceIndex) => {
        entry.paraphrasedEvidence.forEach(({ factBindings }, itemIndex) => {
          factBindings.forEach(({ factId, statementSha256 }, bindingIndex) => {
            const owner = (factsById.get(factId) ?? []).find(
              ({ characterId, citationIds }) =>
                entry.subjectCharacterIds.includes(characterId) &&
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
