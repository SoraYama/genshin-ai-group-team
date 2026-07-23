import { describe, expect, it } from 'vitest';

import {
  v2ExplainOutputSchema,
  v2RotationOutputSchema
} from '../../../src/main/agents/contracts.js';
import { renderV2Narrative } from '../../../src/main/services/v2-narrative.js';

const planFact = [{ kind: 'plan' as const, field: 'validated-target' as const }];

describe('V2 structured narrative contract', () => {
  it('rejects arbitrary factual prose from Rotation and Explain', () => {
    expect(
      v2RotationOutputSchema.safeParse({
        rotations: [
          {
            target: { kind: 'abyss-team', half: 'first' },
            notes: ['Invented combat claim']
          }
        ]
      }).success
    ).toBe(false);
    expect(
      v2ExplainOutputSchema.safeParse({
        explanations: [
          {
            target: { kind: 'abyss-chamber', floor: 12, chamber: 1, half: 'first' },
            text: 'Invented factual explanation'
          }
        ]
      }).success
    ).toBe(false);
  });

  it('renders the same structured directives into deterministic Chinese and English text', () => {
    const narrative = renderV2Narrative({
      mode: 'spiral-abyss',
      locale: 'en-US',
      critique: { decision: 'accept', issues: [] },
      rotation: {
        rotations: [
          {
            target: { kind: 'abyss-team', half: 'first' },
            tone: 'cautious',
            reasonCodes: ['energy-cycle'],
            factRefs: planFact
          }
        ]
      },
      explanation: {
        explanations: [
          {
            target: { kind: 'abyss-chamber', floor: 12, chamber: 1, half: 'first' },
            tone: 'steady',
            reasonCodes: ['mechanic-response'],
            factRefs: planFact
          }
        ]
      }
    });

    expect(narrative).toMatchObject({
      origin: 'agent-structured',
      requestedLocale: 'en-US',
      summary: { 'zh-CN': expect.any(String), 'en-US': expect.any(String) }
    });
    expect(narrative.sections).toHaveLength(2);
    expect(JSON.stringify(narrative.sections.map(({ factRefs }) => factRefs))).toContain(
      'plan:validated-target'
    );
    expect(narrative.summary['en-US']).not.toMatch(/[\u3400-\u9fff]/u);
    expect(narrative.sections[0]!.body['en-US']).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
