import { z } from 'zod';

export const advisorLocaleSchema = z.enum(['zh-CN', 'en-US']);

export const localizedAdvisorTextSchema = z
  .object({
    'zh-CN': z.string().trim().min(1).max(1200),
    'en-US': z.string().trim().min(1).max(1200)
  })
  .strict();

export const advisorNarrativeSectionSchema = z
  .object({
    targetKey: z.string().trim().min(1).max(128),
    tone: z.enum(['steady', 'cautious', 'technical']),
    reasonCodes: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
    factRefs: z.array(z.string().trim().min(1).max(180)).min(1).max(24),
    title: localizedAdvisorTextSchema,
    body: localizedAdvisorTextSchema
  })
  .strict();

export const advisorNarrativeSchema = z
  .object({
    origin: z.enum(['agent-structured', 'local-rules', 'legacy-unavailable']),
    requestedLocale: advisorLocaleSchema,
    summary: localizedAdvisorTextSchema,
    sections: z.array(advisorNarrativeSectionSchema).max(32)
  })
  .strict();

export const abyssTeamRiskSchema = z
  .object({
    half: z.enum(['first', 'second']),
    code: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/u),
    severity: z.literal('soft'),
    narrative: localizedAdvisorTextSchema
  })
  .strict();

export type AdvisorLocale = z.infer<typeof advisorLocaleSchema>;
export type LocalizedAdvisorText = z.infer<typeof localizedAdvisorTextSchema>;
export type AdvisorNarrative = z.infer<typeof advisorNarrativeSchema>;
export type AbyssTeamRisk = z.infer<typeof abyssTeamRiskSchema>;

export function defaultAdvisorNarrative(
  mode: 'spiral-abyss' | 'stygian-onslaught' | 'imaginarium-theater',
  origin: AdvisorNarrative['origin'] = 'local-rules',
  requestedLocale: AdvisorLocale = 'zh-CN'
): AdvisorNarrative {
  const summary =
    origin === 'legacy-unavailable'
      ? {
          'zh-CN': '这条旧记录没有保存可验证的双语说明。',
          'en-US': 'This legacy record did not preserve a verifiable bilingual explanation.'
        }
      : mode === 'spiral-abyss'
        ? {
            'zh-CN': '已按本地规则核对上下半队伍与逐间敌情。',
            'en-US': 'The two teams and chamber matchups were checked with local rules.'
          }
        : mode === 'stygian-onslaught'
          ? {
              'zh-CN': '已按本地规则核对三阶段队伍、复用限制与机制覆盖。',
              'en-US': 'All three teams, reuse limits, and mechanic coverage were checked locally.'
            }
          : {
              'zh-CN': '已按本地规则核对演员池、活力预算与逐幕路线。',
              'en-US': 'The cast, Vigor budget, and act route were checked with local rules.'
            };
  return {
    origin,
    requestedLocale,
    summary,
    sections: []
  };
}
