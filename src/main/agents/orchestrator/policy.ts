export const ORCHESTRATION_ROUTE_V1 = [
  'data-curator',
  'team-composer',
  'critique',
  'rotation-coach',
  'explain'
] as const;

export type OrchestrationStage = (typeof ORCHESTRATION_ROUTE_V1)[number];
