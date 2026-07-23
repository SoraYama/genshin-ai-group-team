import { describe, expect, it } from 'vitest';

import {
  v2ExplainOutputSchema,
  v2RotationOutputSchema
} from '../../../src/main/agents/contracts.js';
import { renderV2Narrative } from '../../../src/main/services/v2-narrative.js';
import { advisorNarrativeSchema } from '../../../src/shared/advisor-narrative.js';
import { defaultAdvisorNarrative } from '../../../src/shared/advisor-narrative.js';

describe('V2 structured narrative contract', () => {
  it('marks a legacy narrative locale as explicitly unknown', () => {
    expect(defaultAdvisorNarrative('spiral-abyss', 'legacy-unavailable')).toMatchObject({
      origin: 'legacy-unavailable',
      requestedLocale: null
    });
  });

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
      advisorNarrativeSchema.safeParse({
        origin: 'agent-structured',
        requestedLocale: 'zh-CN',
        summary: { 'zh-CN': '摘要', 'en-US': 'Summary' },
        sections: [
          {
            targetKey: 'abyss-team:first',
            tone: 'steady',
            reasonCodes: ['invented-reason'],
            factRefs: ['invented:free-form-reference'],
            title: { 'zh-CN': '上半', 'en-US': 'First half' },
            body: { 'zh-CN': '说明', 'en-US': 'Explanation' }
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
            factRefs: [{ kind: 'profile', characterId: '1001', field: 'stats' }]
          }
        ]
      },
      explanation: {
        explanations: [
          {
            target: { kind: 'abyss-chamber', floor: 12, chamber: 1, half: 'first' },
            tone: 'steady',
            reasonCodes: ['mechanic-response'],
            factRefs: [{ kind: 'mechanic', target: '12-1:first', factIndex: 0 }]
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
    expect(narrative.sections[0]?.factRefs).toEqual([
      { kind: 'profile', characterId: '1001', field: 'stats' }
    ]);
    expect(narrative.summary['en-US']).not.toMatch(/[\u3400-\u9fff]/u);
    expect(narrative.sections[0]!.body['en-US']).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
