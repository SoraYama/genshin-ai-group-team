import type { AbyssAdvisorProgressStep } from '../../../shared/abyss-advisor.js';
import type { AdvisorNarrative } from '../../../shared/advisor-narrative.js';
import {
  abyssElementLabel,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../../shared/abyss-mechanics.js';
import type { EnemyInstance, EnemyMechanics } from '../../../shared/scenario-v2.js';

export type CharacterInterventionState = 'neutral' | 'locked' | 'excluded';
export type PresentationLocale = 'zh' | 'en';
export type NarrativeTargetPresentation =
  | { status: 'localized'; title: string; body: string }
  | { status: 'unavailable'; title: string; body: string };

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

const EN_PROGRESS_LABELS: Record<AbyssAdvisorProgressStep, string> = {
  'reading-roster': 'Reading roster',
  'analyzing-rules': 'Analyzing challenge rules',
  'generating-teams': 'Building both teams',
  'checking-conflicts': 'Checking conflicts',
  'writing-tactics': 'Writing tactics'
};

const EN_ELEMENT_LABELS: Record<string, string> = {
  pyro: 'Pyro',
  hydro: 'Hydro',
  anemo: 'Anemo',
  geo: 'Geo',
  electro: 'Electro',
  dendro: 'Dendro',
  cryo: 'Cryo',
  untyped: 'Untyped'
};

const EN_CAPABILITY_LABELS: Record<string, string> = {
  healing: 'healing',
  shield: 'shielding',
  grouping: 'grouping',
  'off-field': 'off-field utility',
  'on-field': 'on-field presence',
  onslaught: 'frontline pressure',
  plunging: 'Plunging Attacks',
  'normal-attack': 'Normal Attacks',
  'charged-attack': 'Charged Attacks',
  sword: 'Sword user',
  claymore: 'Claymore user',
  polearm: 'Polearm user',
  bow: 'Bow user',
  catalyst: 'Catalyst user'
};

export function localizedEntityName(
  names: Record<string, string>,
  locale: PresentationLocale,
  fallback: { zh: string; en: string }
): string {
  return locale === 'en'
    ? (names['en-US'] ?? names.en ?? names['en-GB'] ?? fallback.en)
    : (names['zh-CN'] ?? names['zh-Hans'] ?? names.zh ?? fallback.zh);
}

export function localizedPlanText(value: string, locale: PresentationLocale): string | null {
  if (locale === 'en' && /[\u3400-\u9fff]/u.test(value)) return null;
  return value;
}

export function localizedProfileName(
  name: string,
  id: string,
  orderedIds: string[],
  locale: PresentationLocale
): string {
  if (locale === 'zh' || !/[\u3400-\u9fff]/u.test(name)) return name;
  const uniqueIds = [...new Set(orderedIds)];
  const position = uniqueIds.indexOf(id);
  return `Character ${position >= 0 ? position + 1 : uniqueIds.length + 1}`;
}

export function narrativeTargetPresentation(
  narrative: Pick<AdvisorNarrative, 'sections'> | undefined,
  targetKey: string,
  locale: PresentationLocale
): NarrativeTargetPresentation {
  const section = narrative?.sections.find((candidate) => candidate.targetKey === targetKey);
  if (!section) {
    return locale === 'en'
      ? {
          status: 'unavailable',
          title: 'Guidance unavailable',
          body: 'No localized guidance was saved for this target.'
        }
      : {
          status: 'unavailable',
          title: '指引不可用',
          body: '这个目标没有保存可验证的本地化指引。'
        };
  }
  const key = locale === 'en' ? 'en-US' : 'zh-CN';
  return {
    status: 'localized',
    title: section.title[key],
    body: section.body[key]
  };
}

export function enemyDisplayName(enemy: EnemyInstance, locale: PresentationLocale = 'zh'): string {
  return localizedEntityName(enemy.enemy.names, locale, {
    zh: '未命名敌人',
    en: 'Unnamed enemy'
  });
}

export function mechanicLabels(
  mechanics: EnemyMechanics,
  locale: PresentationLocale = 'zh'
): string[] {
  if (locale === 'en') {
    return [
      ...mechanics.shields.map(
        ({ element, strength }) =>
          `${EN_ELEMENT_LABELS[element.toLowerCase()] ?? 'Unknown'} shield${
            strength === undefined ? '' : ` · strength ${strength}`
          }`
      ),
      ...mechanics.resistances.map(
        ({ damageType, percent }) => `${englishDamageType(damageType)} RES ${percent}%`
      ),
      ...mechanics.immunities.map((immunity) => `Immune: ${englishDamageType(immunity)} damage`),
      ...parseRequiredCapabilities(mechanics.tags).map(({ known, value }) =>
        known
          ? `Requires ${EN_CAPABILITY_LABELS[value] ?? 'a verified capability'}`
          : 'Requires an unrecognized capability'
      )
    ];
  }
  return [
    ...mechanics.shields.map(
      ({ element, strength }) =>
        `${ELEMENT_LABELS[element] ?? '未知'}元素护盾${strength === undefined ? '' : ` · 强度 ${strength}`}`
    ),
    ...mechanics.resistances.map(
      ({ damageType, percent }) => `${localizedResistanceType(damageType)}抗性 ${percent}%`
    ),
    ...mechanics.immunities.map((immunity) => `免疫：${localizedMechanicTerm(immunity)}`),
    ...mechanics.tags.filter((tag) => /[\u3400-\u9fff]/u.test(tag))
  ];
}

function englishDamageType(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/(?:-damage| damage)$/u, '');
  if (normalized === 'physical') return 'Physical';
  return EN_ELEMENT_LABELS[normalized] ?? 'Other damage';
}

function localizedResistanceType(value: string): string {
  const localized = localizedMechanicTerm(value);
  return localized === '未本地化机制' ? '其他伤害' : localized.replace(/(?:元素)?伤害$/u, '');
}

export function cycleCharacterIntervention(
  state: CharacterInterventionState
): CharacterInterventionState {
  return state === 'neutral' ? 'locked' : state === 'locked' ? 'excluded' : 'neutral';
}

export function progressStepLabel(
  step: AbyssAdvisorProgressStep,
  locale: PresentationLocale = 'zh'
): string {
  return locale === 'en' ? EN_PROGRESS_LABELS[step] : PROGRESS_LABELS[step];
}

export function characterElementLabel(element: string, locale: PresentationLocale = 'zh'): string {
  if (locale === 'en') return EN_ELEMENT_LABELS[element.toLowerCase()] ?? 'Unknown';
  const label = abyssElementLabel(element);
  return label === '其他' ? '未知' : label;
}
