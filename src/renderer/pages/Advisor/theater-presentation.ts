import type {
  TheaterAdvisorProgressStep,
  TheaterObjective,
  TheaterScenario,
  TheaterScenarioView
} from '../../../shared/theater-advisor.js';
import {
  localizedCapabilityRequirement,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../../shared/abyss-mechanics.js';
import type { EnemyMechanics, TheaterPlan } from '../../../shared/scenario-v2.js';

const PROGRESS: Record<TheaterAdvisorProgressStep, string> = {
  'reading-roster': '读取角色',
  'checking-eligibility': '检查入场资格',
  'planning-cast': '规划演员池',
  'budgeting-vigor': '检查活力',
  'writing-route': '整理幕次路线'
};

export function objectiveLabel(target: TheaterObjective): string {
  if (target === 'eligibility-check') return '先检查入场资格';
  if (target === 'safe-clear') return '稳妥通关';
  return '探索高难';
}

export function elementLabel(value: string): string {
  return (
    { pyro: '火', hydro: '水', anemo: '风', geo: '岩', electro: '雷', dendro: '草', cryo: '冰' }[
      value.toLowerCase()
    ] ?? '其他'
  );
}

export function poolSourceLabel(source: 'opening' | 'trial' | 'special-guest' | 'support'): string {
  return {
    opening: '开幕演员',
    trial: '试用演员',
    'special-guest': '特邀演员',
    support: '支援演员'
  }[source];
}

export function progressStepLabel(step: TheaterAdvisorProgressStep): string {
  return PROGRESS[step];
}

export function eligibilityReasonLabel(reasons: Array<'element' | 'level'>): string {
  return reasons.map((reason) => (reason === 'element' ? '元素不符合' : '等级不足')).join('、');
}

export function pathChoiceLabel(choice: TheaterPlan['acts'][number]['pathChoice']): string {
  return choice.kind === 'fixed'
    ? `已确认路线：${choice.note}`
    : choice.kind === 'random'
      ? `随机分支：${choice.note}`
      : `条件策略：${choice.note}`;
}

export function theaterEntityName(reference: { names: Record<string, string> }): string {
  return reference.names['zh-CN'] ?? reference.names['zh-Hans'] ?? '未命名演员';
}

export function theaterActPresentation(act: TheaterScenario['acts'][number]) {
  let waveNumber = 0;
  return {
    waves: act.encounters.flatMap(({ waves }) =>
      waves.map((wave) => {
        waveNumber += 1;
        return {
          label: `第 ${waveNumber} 波`,
          ...(wave.spawnCondition ? { spawnCondition: wave.spawnCondition } : {}),
          enemies: wave.enemies.map((enemy) => ({
            name: enemy.enemy.names['zh-CN'] ?? enemy.enemy.names['zh-Hans'] ?? '未命名敌人',
            level: enemy.level,
            count: enemy.count,
            mechanics: theaterMechanicLabels(enemy.mechanics)
          }))
        };
      })
    )
  };
}

function theaterMechanicLabels(mechanics: EnemyMechanics): string[] {
  return [
    ...mechanics.shields.map(
      ({ element, strength }) =>
        `${elementLabel(element)}元素护盾${strength === undefined ? '' : ` · 强度 ${strength}`}`
    ),
    ...mechanics.resistances.map(({ damageType, percent }) => {
      const localized = localizedMechanicTerm(damageType);
      const label =
        localized === '未本地化机制' ? '其他伤害' : localized.replace(/(?:元素)?伤害$/u, '');
      return `${label}抗性 ${percent}%`;
    }),
    ...mechanics.immunities.map((immunity) => `免疫：${localizedMechanicTerm(immunity)}`),
    ...parseRequiredCapabilities(mechanics.tags).map(
      (requirement) => `需要${localizedCapabilityRequirement(requirement)}`
    ),
    ...mechanics.tags.filter(
      (tag) => !tag.startsWith('requires-capability:') && /[\u3400-\u9fff]/u.test(tag)
    )
  ];
}

export function scenarioVersionLabel(
  view: Extract<TheaterScenarioView, { status: 'ready' }>
): string {
  if (view.trust === 'development-sample') return '交互演练资料';
  if (view.snapshotStatus === 'last-known-good') return '最近确认资料';
  return view.notCurrent ? '过期资料' : '本期正式资料';
}
