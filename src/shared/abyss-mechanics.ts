import type { CharacterProfile } from './domain.js';
import type { EnemyInstance } from './scenario-v2.js';

const ELEMENT_LABELS: Record<string, string> = {
  pyro: '火',
  hydro: '水',
  anemo: '风',
  geo: '岩',
  electro: '雷',
  dendro: '草',
  cryo: '冰'
};

export const ABYSS_SHIELD_COUNTERS: Record<string, string[]> = {
  pyro: ['hydro'],
  hydro: ['dendro', 'cryo', 'electro'],
  electro: ['pyro', 'dendro', 'cryo'],
  cryo: ['pyro'],
  geo: ['geo'],
  untyped: ['geo']
};

export interface AbyssMechanicCoverageGap {
  enemyName: string;
  kind: 'shield' | 'immunity';
  message: string;
}

export function findAbyssMechanicCoverageGaps(
  team: CharacterProfile[],
  enemies: EnemyInstance[]
): AbyssMechanicCoverageGap[] {
  const teamElements = team
    .map(({ element }) => element.toLowerCase())
    .filter((element) => element in ELEMENT_LABELS);
  const gaps: AbyssMechanicCoverageGap[] = [];

  for (const enemy of enemies) {
    const enemyName = enemy.enemy.names['zh-CN'] ?? enemy.enemy.names['zh'] ?? '未命名敌人';
    for (const shield of enemy.mechanics.shields) {
      const counters = ABYSS_SHIELD_COUNTERS[shield.element] ?? [];
      if (counters.length > 0 && !teamElements.some((element) => counters.includes(element))) {
        gaps.push({
          enemyName,
          kind: 'shield',
          message: `${enemyName}的${abyssElementLabel(shield.element)}元素护盾没有已知破盾元素。`
        });
      }
    }

    const immuneElements = new Set(
      enemy.mechanics.immunities.flatMap((immunity) => recognizedImmuneElements(immunity))
    );
    if (
      immuneElements.size > 0 &&
      teamElements.length > 0 &&
      teamElements.every((element) => immuneElements.has(element))
    ) {
      gaps.push({
        enemyName,
        kind: 'immunity',
        message: `${enemyName}会免疫当前队伍全部已知元素伤害。`
      });
    }
  }
  return gaps;
}

export function abyssElementLabel(value: string): string {
  return ELEMENT_LABELS[value.toLowerCase()] ?? '其他';
}

export function localizedMechanicTerm(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'physical') return '物理伤害';
  if (normalized in ELEMENT_LABELS) return `${ELEMENT_LABELS[normalized]}元素伤害`;
  return /[\u3400-\u9fff]/u.test(value) ? value : '未本地化机制';
}

function recognizedImmuneElements(value: string): string[] {
  const normalized = value.toLowerCase();
  if (normalized in ELEMENT_LABELS) return [normalized];
  return Object.entries(ELEMENT_LABELS)
    .filter(([, label]) => value.includes(`${label}元素伤害`))
    .map(([element]) => element);
}
