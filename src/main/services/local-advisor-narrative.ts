import {
  advisorNarrativeSchema,
  defaultAdvisorNarrative,
  type AdvisorLocale,
  type AdvisorNarrative
} from '../../shared/advisor-narrative.js';
import {
  recommendationPlanSchema,
  type RecommendationPlan
} from '../../shared/scenario-v2.js';

type NarrativeSection = AdvisorNarrative['sections'][number];

export function renderLocalPlanNarrative(
  plan: RecommendationPlan,
  locale: AdvisorLocale
): AdvisorNarrative {
  const validatedPlan = recommendationPlanSchema.parse(plan);
  const base = defaultAdvisorNarrative(validatedPlan.mode, 'local-rules', locale);
  const sections =
    validatedPlan.mode === 'spiral-abyss'
      ? abyssSections(validatedPlan)
      : validatedPlan.mode === 'stygian-onslaught'
        ? stygianSections(validatedPlan)
        : theaterSections(validatedPlan);
  return advisorNarrativeSchema.parse({ ...base, sections });
}

function abyssSections(
  plan: Extract<RecommendationPlan, { mode: 'spiral-abyss' }>
): NarrativeSection[] {
  const teamSections: NarrativeSection[] = (['first', 'second'] as const).map((half) => ({
    targetKey: `abyss-team:${half}`,
    tone: 'steady',
    reasonCodes: ['setup-order'],
    factRefs: [{ kind: 'plan', field: 'selected-team' }],
    title:
      half === 'first'
        ? { 'zh-CN': '上半队伍依据', 'en-US': 'First-half team rationale' }
        : { 'zh-CN': '下半队伍依据', 'en-US': 'Second-half team rationale' },
    body:
      half === 'first'
        ? {
            'zh-CN': '这支队伍是已校验方案的上半选择；先完成辅助布置，再进入主要输出窗口。',
            'en-US':
              'This is the validated first-half selection; finish setup before the main damage window.'
          }
        : {
            'zh-CN': '这支队伍是已校验方案的下半选择；先完成辅助布置，再进入主要输出窗口。',
            'en-US':
              'This is the validated second-half selection; finish setup before the main damage window.'
          }
  }));
  const chamberSections = plan.chambers
    .slice()
    .sort((left, right) => left.floor - right.floor || left.chamber - right.chamber)
    .flatMap(({ floor, chamber }) =>
      (['first', 'second'] as const).map(
        (half): NarrativeSection => ({
          targetKey: `abyss-chamber:${floor}:${chamber}:${half}`,
          tone: 'steady',
          reasonCodes: ['setup-order'],
          factRefs: [{ kind: 'plan', field: 'validated-target' }],
          title: {
            'zh-CN': `${floor} 层第 ${chamber} 间${half === 'first' ? '上半' : '下半'}依据`,
            'en-US': `Floor ${floor}, Chamber ${chamber}, ${half}-half rationale`
          },
          body: {
            'zh-CN': `这部分对应已校验的 ${floor} 层第 ${chamber} 间${
              half === 'first' ? '上半' : '下半'
            }目标；按本地方案完成布置后进入输出。`,
            'en-US': `This section is tied to the validated Floor ${floor}, Chamber ${chamber}, ${half}-half target; complete setup before committing to damage.`
          }
        })
      )
    );
  return [...teamSections, ...chamberSections];
}

function stygianSections(
  plan: Extract<RecommendationPlan, { mode: 'stygian-onslaught' }>
): NarrativeSection[] {
  return plan.phases
    .slice()
    .sort((left, right) => left.phase - right.phase)
    .map(({ phase }) => ({
      targetKey: `stygian-phase:${phase}`,
      tone: 'steady',
      reasonCodes: ['setup-order'],
      factRefs: [
        { kind: 'plan', field: 'selected-team' },
        { kind: 'plan', field: 'validated-target' }
      ],
      title: {
        'zh-CN': `第 ${phase} 阶段队伍依据`,
        'en-US': `Phase ${phase} team rationale`
      },
      body: {
        'zh-CN': `保存的第 ${phase} 阶段队伍是已校验的本地分配；先完成布置，再进入主要输出窗口。`,
        'en-US': `The saved Phase ${phase} team is the validated local allocation; finish setup before the main damage window.`
      }
    }));
}

function theaterSections(
  plan: Extract<RecommendationPlan, { mode: 'imaginarium-theater' }>
): NarrativeSection[] {
  return [
    {
      targetKey: 'theater-cast',
      tone: 'steady',
      reasonCodes: ['cast-flexibility'],
      factRefs: [{ kind: 'plan', field: 'cast-allocation' }],
      title: { 'zh-CN': '演员池依据', 'en-US': 'Cast allocation rationale' },
      body: {
        'zh-CN': '这份演员池来自已校验的分配；保留调度余量，供后续幕次按计划轮换。',
        'en-US':
          'This cast comes from the validated allocation; keep scheduling flexibility for later acts.'
      }
    },
    ...plan.acts
      .slice()
      .sort((left, right) => left.act - right.act)
      .map(
        ({ act }): NarrativeSection => ({
          targetKey: `theater-act:${act}`,
          tone: 'steady',
          reasonCodes: ['vigor-budget'],
          factRefs: [{ kind: 'plan', field: 'vigor-ledger' }],
          title: { 'zh-CN': `第 ${act} 幕活力依据`, 'en-US': `Act ${act} Vigor rationale` },
          body: {
            'zh-CN': `第 ${act} 幕的演员安排来自已校验的活力账本；本幕消耗不超过保存的预算。`,
            'en-US': `The Act ${act} assignment follows the validated Vigor ledger and stays within its saved budget.`
          }
        })
      )
  ];
}
