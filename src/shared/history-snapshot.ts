import type { PlayerCycleSnapshot } from './domain.js';

export function createPlayerCycleSnapshot(meta: {
  effectiveFrom: string;
  effectiveTo?: string;
}): PlayerCycleSnapshot {
  const start = meta.effectiveFrom.slice(0, 10);
  const end = meta.effectiveTo?.slice(0, 10);
  return {
    status: 'known',
    label: end ? `${start} — ${end}` : start,
    effectiveFrom: meta.effectiveFrom,
    ...(meta.effectiveTo === undefined ? {} : { effectiveTo: meta.effectiveTo })
  };
}
