import { z } from 'zod';

export const advisorLocaleSchema = z.enum(['zh-CN', 'en-US']);

export const localizedAdvisorTextSchema = z
  .object({
    'zh-CN': z.string().trim().min(1).max(1200),
    'en-US': z.string().trim().min(1).max(1200)
  })
  .strict();

export const advisorNarrativeReasonCodeSchema = z.enum([
  'setup-order',
  'energy-cycle',
  'survival-window',
  'reaction-chain',
  'mechanic-response',
  'target-priority',
  'vigor-budget',
  'cast-flexibility',
  'uncertainty'
]);

export const advisorFactRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('plan'),
      field: z.enum(['validated-target', 'selected-team', 'cast-allocation', 'vigor-ledger'])
    })
    .strict(),
  z
    .object({
      kind: z.literal('mechanic'),
      target: z.string().trim().min(1).max(128),
      factIndex: z.number().int().nonnegative().max(15)
    })
    .strict(),
  z
    .object({
      kind: z.literal('profile'),
      characterId: z.string().trim().min(1).max(128),
      field: z.enum(['level', 'build', 'stats', 'completeness'])
    })
    .strict(),
  z
    .object({
      kind: z.literal('knowledge'),
      characterId: z.string().trim().min(1).max(128)
    })
    .strict()
]);

export const advisorNarrativeSectionSchema = z
  .object({
    targetKey: z.string().trim().min(1).max(128),
    tone: z.enum(['steady', 'cautious', 'technical']),
    reasonCodes: z.array(advisorNarrativeReasonCodeSchema).min(1).max(12),
    factRefs: z.array(advisorFactRefSchema).min(1).max(24),
    title: localizedAdvisorTextSchema,
    body: localizedAdvisorTextSchema
  })
  .strict();

export const advisorNarrativeSchema = z
  .object({
    origin: z.enum(['agent-structured', 'local-rules', 'legacy-unavailable']),
    requestedLocale: advisorLocaleSchema.nullable(),
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
export type AdvisorNarrativeReasonCode = z.infer<typeof advisorNarrativeReasonCodeSchema>;
export type AdvisorFactRef = z.infer<typeof advisorFactRefSchema>;
export type AdvisorNarrative = z.infer<typeof advisorNarrativeSchema>;
export type AbyssTeamRisk = z.infer<typeof abyssTeamRiskSchema>;

export function defaultAdvisorNarrative(
  mode: 'spiral-abyss' | 'stygian-onslaught' | 'imaginarium-theater',
  origin: AdvisorNarrative['origin'] = 'local-rules',
  requestedLocale?: AdvisorLocale | null
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
    requestedLocale:
      requestedLocale === undefined
        ? origin === 'legacy-unavailable'
          ? null
          : 'zh-CN'
        : requestedLocale,
    summary,
    sections: []
  };
}
