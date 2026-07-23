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
import {
  characterElementLabel,
  localizedEntityName,
  mechanicLabels,
  type PresentationLocale
} from './abyss-presentation.js';

const PROGRESS: Record<TheaterAdvisorProgressStep, string> = {
  'reading-roster': '读取角色',
  'checking-eligibility': '检查入场资格',
  'planning-cast': '规划演员池',
  'budgeting-vigor': '检查活力',
  'writing-route': '整理幕次路线'
};
const EN_PROGRESS: Record<TheaterAdvisorProgressStep, string> = {
  'reading-roster': 'Reading roster',
  'checking-eligibility': 'Checking eligibility',
  'planning-cast': 'Planning cast',
  'budgeting-vigor': 'Budgeting Vigor',
  'writing-route': 'Writing act route'
};

export function objectiveLabel(
  target: TheaterObjective,
  locale: PresentationLocale = 'zh'
): string {
  if (locale === 'en') {
    if (target === 'eligibility-check') return 'Check eligibility first';
    if (target === 'safe-clear') return 'Prioritize a reliable clear';
    return 'Explore harder routes';
  }
  if (target === 'eligibility-check') return '先检查入场资格';
  if (target === 'safe-clear') return '稳妥通关';
  return '探索高难';
}

export function elementLabel(value: string, locale: PresentationLocale = 'zh'): string {
  if (locale === 'en') return characterElementLabel(value, locale);
  return (
    { pyro: '火', hydro: '水', anemo: '风', geo: '岩', electro: '雷', dendro: '草', cryo: '冰' }[
      value.toLowerCase()
    ] ?? '其他'
  );
}

export function poolSourceLabel(
  source: 'opening' | 'trial' | 'special-guest' | 'support',
  locale: PresentationLocale = 'zh'
): string {
  return (locale === 'en'
    ? {
        opening: 'Opening Character',
        trial: 'Trial Actor',
        'special-guest': 'Special Guest',
        support: 'Support Actor'
      }
    : {
        opening: '开幕演员',
        trial: '试用演员',
        'special-guest': '特邀演员',
        support: '支援演员'
      })[source];
}

export function progressStepLabel(
  step: TheaterAdvisorProgressStep,
  locale: PresentationLocale = 'zh'
): string {
  return locale === 'en' ? EN_PROGRESS[step] : PROGRESS[step];
}

export function eligibilityReasonLabel(
  reasons: Array<'element' | 'level'>,
  locale: PresentationLocale = 'zh'
): string {
  return reasons
    .map((reason) =>
      locale === 'en'
        ? reason === 'element'
          ? 'Element not eligible'
          : 'Level too low'
        : reason === 'element'
          ? '元素不符合'
          : '等级不足'
    )
    .join(locale === 'en' ? ', ' : '、');
}

export function pathChoiceLabel(
  choice: TheaterPlan['acts'][number]['pathChoice'],
  locale: PresentationLocale = 'zh'
): string {
  if (locale === 'en') {
    const note = /[\u3400-\u9fff]/u.test(choice.note)
      ? 'Route note saved with this plan'
      : choice.note;
    return choice.kind === 'fixed'
      ? `Confirmed route: ${note}`
      : choice.kind === 'random'
        ? `Random branch: ${note}`
        : `Conditional strategy: ${note}`;
  }
  return choice.kind === 'fixed'
    ? `已确认路线：${choice.note}`
    : choice.kind === 'random'
      ? `随机分支：${choice.note}`
      : `条件策略：${choice.note}`;
}

export function theaterEntityName(
  reference: { names: Record<string, string> },
  locale: PresentationLocale = 'zh'
): string {
  return localizedEntityName(reference.names, locale, {
    zh: '未命名演员',
    en: 'Unnamed actor'
  });
}

export function theaterActPresentation(
  act: TheaterScenario['acts'][number],
  locale: PresentationLocale = 'zh'
) {
  let waveNumber = 0;
  return {
    waves: act.encounters.flatMap(({ waves }) =>
      waves.map((wave) => {
        waveNumber += 1;
        return {
          label: locale === 'en' ? `Wave ${waveNumber}` : `第 ${waveNumber} 波`,
          ...(wave.spawnCondition
            ? {
                spawnCondition:
                  locale === 'en' && /[\u3400-\u9fff]/u.test(wave.spawnCondition)
                    ? 'Spawn condition recorded in source data'
                    : wave.spawnCondition
              }
            : {}),
          enemies: wave.enemies.map((enemy) => ({
            name: localizedEntityName(enemy.enemy.names, locale, {
              zh: '未命名敌人',
              en: 'Unnamed enemy'
            }),
            level: enemy.level,
            count: enemy.count,
            mechanics: theaterMechanicLabels(enemy.mechanics, locale)
          }))
        };
      })
    )
  };
}

function theaterMechanicLabels(
  mechanics: EnemyMechanics,
  locale: PresentationLocale
): string[] {
  if (locale === 'en') return mechanicLabels(mechanics, locale);
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
  view: Extract<TheaterScenarioView, { status: 'ready' }>,
  locale: PresentationLocale = 'zh'
): string {
  if (view.trust === 'development-sample')
    return locale === 'en' ? 'Practice data' : '交互演练资料';
  if (view.snapshotStatus === 'last-known-good')
    return locale === 'en' ? 'Last verified data' : '最近确认资料';
  return view.notCurrent
    ? locale === 'en'
      ? 'Outdated data'
      : '过期资料'
    : locale === 'en'
      ? 'Current verified data'
      : '本期正式资料';
}
