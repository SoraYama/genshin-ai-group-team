import type { StygianRewardTarget } from './stygian-advisor.js';

export interface StygianTargetDifficultyPolicy {
  source: 'app-default' | 'scenario';
  version: string;
  minimumOrderByTarget: Readonly<Record<StygianRewardTarget, number>>;
}

export const DEFAULT_STYGIAN_TARGET_POLICY: StygianTargetDifficultyPolicy = {
  source: 'app-default',
  version: 'app-target-orders-v1',
  minimumOrderByTarget: {
    primogems: 1,
    'high-reward': 5,
    'dire-challenge': 6
  }
};

interface OrderedDifficulty {
  id: string;
  order: number;
}

export function minimumOrderForStygianTarget(
  target: StygianRewardTarget,
  policy: StygianTargetDifficultyPolicy = DEFAULT_STYGIAN_TARGET_POLICY
): number {
  return policy.minimumOrderByTarget[target];
}

export function isStygianTargetDifficultyCompatible(
  target: StygianRewardTarget,
  difficultyOrder: number,
  policy: StygianTargetDifficultyPolicy = DEFAULT_STYGIAN_TARGET_POLICY
): boolean {
  return difficultyOrder >= minimumOrderForStygianTarget(target, policy);
}

export function clampDifficultyForStygianTarget(
  target: StygianRewardTarget,
  selectedDifficultyId: string,
  difficulties: readonly OrderedDifficulty[],
  policy: StygianTargetDifficultyPolicy = DEFAULT_STYGIAN_TARGET_POLICY
): string {
  const ordered = difficulties.slice().sort((left, right) => left.order - right.order);
  const selected = ordered.find(({ id }) => id === selectedDifficultyId);
  if (selected && isStygianTargetDifficultyCompatible(target, selected.order, policy)) {
    return selected.id;
  }
  return (
    ordered.find(({ order }) => isStygianTargetDifficultyCompatible(target, order, policy))?.id ??
    selectedDifficultyId
  );
}

export function lowerStygianDifficultyWithinTarget(
  target: StygianRewardTarget,
  selectedOrder: number,
  difficulties: readonly OrderedDifficulty[],
  policy: StygianTargetDifficultyPolicy = DEFAULT_STYGIAN_TARGET_POLICY
): string | undefined {
  return difficulties
    .filter(
      ({ order }) =>
        order < selectedOrder && isStygianTargetDifficultyCompatible(target, order, policy)
    )
    .sort((left, right) => right.order - left.order)[0]?.id;
}
