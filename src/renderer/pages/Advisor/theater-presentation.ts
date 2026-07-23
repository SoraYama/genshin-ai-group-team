import type {
  TheaterAdvisorProgressStep,
  TheaterObjective,
  TheaterScenarioView
} from '../../../shared/theater-advisor.js';
import type { TheaterPlan } from '../../../shared/scenario-v2.js';

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

export function scenarioVersionLabel(
  view: Extract<TheaterScenarioView, { status: 'ready' }>
): string {
  if (view.trust === 'development-sample') return '交互演练资料';
  if (view.snapshotStatus === 'last-known-good') return '最近确认资料';
  return view.notCurrent ? '过期资料' : '本期正式资料';
}
