import { z } from 'zod';

export const CANONICAL_SCENARIO_MECHANIC_TAGS = [
  'elemental-shield',
  'elemental-armor',
  'shield-absent',
  'high-resistance',
  'elemental-immunity',
  'multi-wave',
  'single-wave-only',
  'groupable',
  'multi-target',
  'ungroupable',
  'heavy-target',
  'single-target',
  'boss',
  'dense-multi-target',
  'survival-pressure',
  'interrupt-pressure',
  'high-incoming-damage',
  'mobile-enemy',
  'burrow',
  'short-damage-window',
  'stationary-target',
  'elemental-aura',
  'reaction-restricted',
  'freeze-immune'
] as const;

export const scenarioMechanicTagSchema = z.enum(CANONICAL_SCENARIO_MECHANIC_TAGS);

export type ScenarioMechanicTag = z.infer<typeof scenarioMechanicTagSchema>;
