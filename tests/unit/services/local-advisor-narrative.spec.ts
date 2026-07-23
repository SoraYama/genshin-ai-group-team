import { describe, expect, it } from 'vitest';

import { renderLocalPlanNarrative } from '../../../src/main/services/local-advisor-narrative.js';
import { advisorNarrativeSchema } from '../../../src/shared/advisor-narrative.js';
import { validAbyssPlan } from './abyss-test-fixtures.js';
import { validStygianPlan } from './stygian-test-fixtures.js';
import { validTheaterPlan } from './theater-test-fixtures.js';

describe('renderLocalPlanNarrative', () => {
  it('derives exact Abyss team and chamber sections from validated structure only', () => {
    const plan = structuredClone(validAbyssPlan());
    plan.firstHalfTeam.purpose = 'ARBITRARY_PLAN_PROSE_MUST_NOT_APPEAR';
    const narrative = renderLocalPlanNarrative(plan, 'en-US');

    expect(narrative.sections.map(({ targetKey }) => targetKey)).toEqual([
      'abyss-team:first',
      'abyss-team:second',
      'abyss-chamber:12:1:first',
      'abyss-chamber:12:1:second',
      'abyss-chamber:12:2:first',
      'abyss-chamber:12:2:second'
    ]);
    expect(narrative.sections.slice(0, 2)).toEqual([
      expect.objectContaining({
        targetKey: 'abyss-team:first',
        reasonCodes: ['setup-order'],
        factRefs: [{ kind: 'plan', field: 'selected-team' }]
      }),
      expect.objectContaining({
        targetKey: 'abyss-team:second',
        reasonCodes: ['setup-order'],
        factRefs: [{ kind: 'plan', field: 'selected-team' }]
      })
    ]);
    expect(narrative.sections.slice(2)).toEqual([
      expect.objectContaining({
        targetKey: 'abyss-chamber:12:1:first',
        reasonCodes: ['setup-order'],
        factRefs: [{ kind: 'plan', field: 'validated-target' }]
      }),
      expect.objectContaining({
        targetKey: 'abyss-chamber:12:1:second',
        reasonCodes: ['setup-order'],
        factRefs: [{ kind: 'plan', field: 'validated-target' }]
      }),
      expect.objectContaining({
        targetKey: 'abyss-chamber:12:2:first',
        reasonCodes: ['setup-order'],
        factRefs: [{ kind: 'plan', field: 'validated-target' }]
      }),
      expect.objectContaining({
        targetKey: 'abyss-chamber:12:2:second',
        reasonCodes: ['setup-order'],
        factRefs: [{ kind: 'plan', field: 'validated-target' }]
      })
    ]);
    expectNarrativeIsCompleteAndSafe(narrative);
    expect(JSON.stringify(narrative)).not.toContain('ARBITRARY_PLAN_PROSE_MUST_NOT_APPEAR');
  });

  it('derives one exact Stygian section for every validated phase', () => {
    const plan = structuredClone(validStygianPlan());
    plan.phases[0]!.team.rotationNotes = ['ARBITRARY_STYGIAN_PROSE'];
    const narrative = renderLocalPlanNarrative(plan, 'zh-CN');

    expect(narrative.sections.map(({ targetKey }) => targetKey)).toEqual([
      'stygian-phase:1',
      'stygian-phase:2',
      'stygian-phase:3'
    ]);
    expect(narrative.sections).toEqual(
      narrative.sections.map((section) =>
        expect.objectContaining({
          targetKey: section.targetKey,
          reasonCodes: ['setup-order'],
          factRefs: [
            { kind: 'plan', field: 'selected-team' },
            { kind: 'plan', field: 'validated-target' }
          ]
        })
      )
    );
    expectNarrativeIsCompleteAndSafe(narrative);
    expect(JSON.stringify(narrative)).not.toContain('ARBITRARY_STYGIAN_PROSE');
  });

  it('derives Theater cast and exact act sections from allocation and Vigor facts', () => {
    const plan = structuredClone(validTheaterPlan());
    plan.acts[0]!.pathChoice.note = 'ARBITRARY_THEATER_PROSE';
    const narrative = renderLocalPlanNarrative(plan, 'en-US');

    expect(narrative.sections.map(({ targetKey }) => targetKey)).toEqual([
      'theater-cast',
      'theater-act:1',
      'theater-act:2'
    ]);
    expect(narrative.sections[0]).toMatchObject({
      targetKey: 'theater-cast',
      reasonCodes: ['cast-flexibility'],
      factRefs: [{ kind: 'plan', field: 'cast-allocation' }]
    });
    expect(narrative.sections.slice(1)).toEqual([
      expect.objectContaining({
        targetKey: 'theater-act:1',
        reasonCodes: ['vigor-budget'],
        factRefs: [{ kind: 'plan', field: 'vigor-ledger' }]
      }),
      expect.objectContaining({
        targetKey: 'theater-act:2',
        reasonCodes: ['vigor-budget'],
        factRefs: [{ kind: 'plan', field: 'vigor-ledger' }]
      })
    ]);
    expectNarrativeIsCompleteAndSafe(narrative);
    expect(JSON.stringify(narrative)).not.toContain('ARBITRARY_THEATER_PROSE');
  });
});

function expectNarrativeIsCompleteAndSafe(
  narrative: ReturnType<typeof renderLocalPlanNarrative>
): void {
  expect(advisorNarrativeSchema.safeParse(narrative).success).toBe(true);
  expect(narrative).toMatchObject({
    origin: 'local-rules',
    requestedLocale: expect.stringMatching(/^(?:zh-CN|en-US)$/u)
  });
  for (const section of narrative.sections) {
    expect(section.title['zh-CN']).toBeTruthy();
    expect(section.title['en-US']).toBeTruthy();
    expect(section.body['zh-CN']).toBeTruthy();
    expect(section.body['en-US']).toBeTruthy();
    expect(section.title['en-US']).not.toMatch(/[\u3400-\u9fff]/u);
    expect(section.body['en-US']).not.toMatch(/[\u3400-\u9fff]/u);
  }
  expect(JSON.stringify(narrative)).not.toMatch(
    /Guidance unavailable|No localized guidance|指引不可用|没有保存可验证的本地化指引/u
  );
}
