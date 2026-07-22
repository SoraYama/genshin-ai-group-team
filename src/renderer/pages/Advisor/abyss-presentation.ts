import type { AbyssAdvisorProgressStep } from '../../../shared/abyss-advisor.js';
import type { EnemyInstance, EnemyMechanics } from '../../../shared/scenario-v2.js';

export type CharacterInterventionState = 'neutral' | 'locked' | 'excluded';

const ELEMENT_LABELS: Record<string, string> = {
  pyro: '火',
  hydro: '水',
  anemo: '风',
  geo: '岩',
  electro: '雷',
  dendro: '草',
  cryo: '冰',
  untyped: '无属性'
};

const PROGRESS_LABELS: Record<AbyssAdvisorProgressStep, string> = {
  'reading-roster': '读取角色',
  'analyzing-rules': '分析挑战规则',
  'generating-teams': '生成双队',
  'checking-conflicts': '检查冲突',
  'writing-tactics': '整理打法'
};

export function enemyDisplayName(enemy: EnemyInstance): string {
  return enemy.enemy.names['zh-CN'] ?? enemy.enemy.names['zh-Hans'] ?? '未命名敌人';
}

export function mechanicLabels(mechanics: EnemyMechanics): string[] {
  return [
    ...mechanics.shields.map(
      ({ element, strength }) =>
        `${ELEMENT_LABELS[element] ?? '未知'}元素护盾${strength === undefined ? '' : ` · 强度 ${strength}`}`
    ),
    ...mechanics.resistances.map(
      ({ damageType, percent }) =>
        `${ELEMENT_LABELS[damageType.toLowerCase()] ?? damageType}抗性 ${percent}%`
    ),
    ...mechanics.immunities.map((immunity) => `免疫：${immunity}`),
    ...mechanics.tags.filter((tag) => /[\u3400-\u9fff]/u.test(tag))
  ];
}

export function cycleCharacterIntervention(
  state: CharacterInterventionState
): CharacterInterventionState {
  return state === 'neutral' ? 'locked' : state === 'locked' ? 'excluded' : 'neutral';
}

export function progressStepLabel(step: AbyssAdvisorProgressStep): string {
  return PROGRESS_LABELS[step];
}

export function characterElementLabel(element: string): string {
  return ELEMENT_LABELS[element.toLowerCase()] ?? '未知';
}
