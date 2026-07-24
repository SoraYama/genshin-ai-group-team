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
      for (const character of strategies.characters) {
        for (const archetype of character.archetypes) {
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
