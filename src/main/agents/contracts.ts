import { z } from 'zod';

export const dataCuratorOutputSchema = z.object({
  usableCharacterIds: z.array(z.number().int()).min(4),
  partial: z.boolean(),
  dataNotes: z.array(z.string()).max(8)
});

export const composedTeamSchema = z.object({
  name: z.string().min(1).max(40),
  characterIds: z.array(z.number().int()).length(4),
  concept: z.string().min(1).max(500),
  confidence: z.enum(['low', 'medium', 'high']),
  assumptions: z.array(z.string()).max(8)
});

export const teamComposerOutputSchema = z.object({
  teams: z.array(composedTeamSchema).min(1).max(3)
});

export const critiqueOutputSchema = z.object({
  reviews: z.array(
    z.object({
      teamIndex: z.number().int().nonnegative(),
      viable: z.boolean(),
      issues: z.array(z.string()).max(8)
    })
  )
});

export const rotationCoachOutputSchema = z.object({
  rotations: z.array(
    z.object({
      teamIndex: z.number().int().nonnegative(),
      rotationTip: z.string().min(1).max(800)
    })
  )
});

export const explainOutputSchema = z.object({
  summary: z.string().min(1).max(800),
  teams: z.array(
    z.object({
      teamIndex: z.number().int().nonnegative(),
      reasoning: z.string().min(1).max(1000)
    })
  )
});

export type DataCuratorOutput = z.infer<typeof dataCuratorOutputSchema>;
export type TeamComposerOutput = z.infer<typeof teamComposerOutputSchema>;
export type CritiqueOutput = z.infer<typeof critiqueOutputSchema>;
export type RotationCoachOutput = z.infer<typeof rotationCoachOutputSchema>;
export type ExplainOutput = z.infer<typeof explainOutputSchema>;
