import type {
  StygianAdvisorProgressStep,
  StygianRewardTarget,
  StygianScenarioView
} from '../../../shared/stygian-advisor.js';
import type {
  CrossPartyReusePolicy,
  StygianOnslaughtScenario
} from '../../../shared/scenario-v2.js';
import {
  localizedCapabilityRequirement,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../../shared/abyss-mechanics.js';

export type StygianInterventionState = 'neutral' | 'locked' | 'excluded';

const PROGRESS_LABELS: Record<StygianAdvisorProgressStep, string> = {
  'reading-roster': '读取角色',
  'analyzing-rules': '分析难度规则',
  'allocating-parties': '分配三队',
  'checking-mechanics': '检查首领机制',
  'writing-guidance': '整理三阶段打法'
};

export function difficultyDisplayName(
  difficulty: StygianOnslaughtScenario['difficulties'][number]
): string {
  return (
    difficulty.name.names['zh-CN'] ??
    difficulty.name.names['zh-Hans'] ??
    `第 ${difficulty.order} 档`
  );
}

export function difficultySuggestionLabel(
  difficulties: StygianOnslaughtScenario['difficulties'],
  difficultyId: string
): string {
  const difficulty = difficulties.find(({ id }) => id === difficultyId);
  return difficulty ? `改选${difficultyDisplayName(difficulty)}` : '改选建议难度';
}

export function stygianBossDisplayName(
  boss: StygianOnslaughtScenario['phases'][number]['boss']
): string {
  return boss.enemy.names['zh-CN'] ?? boss.enemy.names['zh-Hans'] ?? '未命名首领';
}

export function rewardTargetLabel(target: StygianRewardTarget): string {
  if (target === 'primogems') return '拿原石即可';
  if (target === 'high-reward') return '冲高难奖励';
  return '挑战极限难度';
}

export function scenarioVersionLabel(
  view: Extract<StygianScenarioView, { status: 'ready' }>
): string {
  if (view.trust === 'development-sample') {
    return view.scenario.meta.dataVersion.replace(/^development\./, '演练 · ');
  }
  if (view.snapshotStatus === 'last-known-good') return '最近确认资料';
  return view.notCurrent ? '过期资料' : '本期正式资料';
}

export function reuseRuleSummary(policy: CrossPartyReusePolicy): string {
  if (policy.rule === 'forbidden') return '三个阶段之间不可复用角色，需要 12 名不重复角色。';
  if (policy.rule === 'allowed') return '角色可在三个阶段重复出场。';
  return `每名角色最多可参与 ${policy.maxPartyAppearancesPerCharacter} 个阶段。`;
}

export function stygianMechanicLabels(phase: StygianOnslaughtScenario['phases'][number]): string[] {
  return Array.from(
    new Set([
      ...phase.phaseModifiers.map(({ description }) => description),
      ...phase.bossModifiers.map(({ description }) => description),
      ...phase.boss.mechanics.shields.map(
        ({ element, strength }) =>
          `${localizedMechanicTerm(element)}护盾${strength === undefined ? '' : ` · 强度 ${strength}`}`
      ),
      ...phase.boss.mechanics.resistances.map(
        ({ damageType, percent }) => `${localizedMechanicTerm(damageType)}抗性 ${percent}%`
      ),
      ...phase.boss.mechanics.immunities.map(
        (immunity) => `免疫：${localizedMechanicTerm(immunity)}`
      ),
      ...parseRequiredCapabilities(phase.boss.mechanics.tags).map(
        (requirement) => `硬机制要求：${localizedCapabilityRequirement(requirement)}`
      ),
      ...phase.boss.mechanics.tags.filter((tag) => /[\u3400-\u9fff]/u.test(tag))
    ])
  );
}

export function cycleStygianIntervention(
  state: StygianInterventionState
): StygianInterventionState {
  return state === 'neutral' ? 'locked' : state === 'locked' ? 'excluded' : 'neutral';
}

export function progressStepLabel(step: StygianAdvisorProgressStep): string {
  return PROGRESS_LABELS[step];
}
