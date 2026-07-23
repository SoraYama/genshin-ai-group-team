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
import { localizeStygianModifier } from '../../../shared/stygian-modifier-localization.js';
import {
  characterElementLabel,
  localizedEntityName,
  type PresentationLocale
} from './abyss-presentation.js';

export type StygianInterventionState = 'neutral' | 'locked' | 'excluded';

const PROGRESS_LABELS: Record<StygianAdvisorProgressStep, string> = {
  'reading-roster': '读取角色',
  'analyzing-rules': '分析难度规则',
  'allocating-parties': '分配三队',
  'checking-mechanics': '检查首领机制',
  'writing-guidance': '整理三阶段打法'
};
const EN_PROGRESS_LABELS: Record<StygianAdvisorProgressStep, string> = {
  'reading-roster': 'Reading roster',
  'analyzing-rules': 'Analyzing difficulty rules',
  'allocating-parties': 'Allocating three teams',
  'checking-mechanics': 'Checking boss mechanics',
  'writing-guidance': 'Writing phase guidance'
};

export function difficultyDisplayName(
  difficulty: StygianOnslaughtScenario['difficulties'][number],
  locale: PresentationLocale = 'zh'
): string {
  return localizedEntityName(difficulty.name.names, locale, {
    zh: `第 ${difficulty.order} 档`,
    en: `Difficulty ${difficulty.order}`
  });
}

export function difficultyModifierLabels(
  difficulty: StygianOnslaughtScenario['difficulties'][number],
  locale: PresentationLocale = 'zh'
): string[] {
  return difficulty.modifiers.map((modifier) =>
    locale === 'en' ? englishModifierLabel(modifier) : localizeStygianModifier(modifier)
  );
}

export function difficultySuggestionLabel(
  difficulties: StygianOnslaughtScenario['difficulties'],
  difficultyId: string,
  locale: PresentationLocale = 'zh'
): string {
  const difficulty = difficulties.find(({ id }) => id === difficultyId);
  if (locale === 'en') {
    return difficulty
      ? `Choose ${difficultyDisplayName(difficulty, locale)}`
      : 'Choose the suggested difficulty';
  }
  return difficulty ? `改选${difficultyDisplayName(difficulty, locale)}` : '改选建议难度';
}

export function stygianBossDisplayName(
  boss: StygianOnslaughtScenario['phases'][number]['boss'],
  locale: PresentationLocale = 'zh'
): string {
  return localizedEntityName(boss.enemy.names, locale, {
    zh: '未命名首领',
    en: 'Unnamed boss'
  });
}

export function rewardTargetLabel(
  target: StygianRewardTarget,
  locale: PresentationLocale = 'zh'
): string {
  if (locale === 'en') {
    if (target === 'primogems') return 'Secure Primogem rewards';
    if (target === 'high-reward') return 'Target high-tier rewards';
    return 'Attempt the highest difficulty';
  }
  if (target === 'primogems') return '拿原石即可';
  if (target === 'high-reward') return '冲高难奖励';
  return '挑战极限难度';
}

export function scenarioVersionLabel(
  view: Extract<StygianScenarioView, { status: 'ready' }>,
  locale: PresentationLocale = 'zh'
): string {
  if (view.trust === 'development-sample') {
    return locale === 'en'
      ? view.scenario.meta.dataVersion.replace(/^development\./, 'Practice · ')
      : view.scenario.meta.dataVersion.replace(/^development\./, '演练 · ');
  }
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

export function reuseRuleSummary(
  policy: CrossPartyReusePolicy,
  locale: PresentationLocale = 'zh'
): string {
  if (locale === 'en') {
    if (policy.rule === 'forbidden')
      return 'Characters cannot be reused across phases; 12 unique characters are required.';
    if (policy.rule === 'allowed') return 'Characters may be reused across all three phases.';
    return `Each character may appear in up to ${policy.maxPartyAppearancesPerCharacter} phases.`;
  }
  if (policy.rule === 'forbidden') return '三个阶段之间不可复用角色，需要 12 名不重复角色。';
  if (policy.rule === 'allowed') return '角色可在三个阶段重复出场。';
  return `每名角色最多可参与 ${policy.maxPartyAppearancesPerCharacter} 个阶段。`;
}

export function stygianMechanicLabels(
  phase: StygianOnslaughtScenario['phases'][number],
  locale: PresentationLocale = 'zh'
): string[] {
  if (locale === 'en') {
    return Array.from(
      new Set([
        ...phase.phaseModifiers.map(englishModifierLabel),
        ...phase.bossModifiers.map(englishModifierLabel),
        ...phase.boss.mechanics.shields.map(
          ({ element, strength }) =>
            `${characterElementLabel(element, locale)} shield${
              strength === undefined ? '' : ` · strength ${strength}`
            }`
        ),
        ...phase.boss.mechanics.resistances.map(
          ({ damageType, percent }) => `${englishMechanicTerm(damageType)} RES ${percent}%`
        ),
        ...phase.boss.mechanics.immunities.map(
          (immunity) => `Immune: ${englishMechanicTerm(immunity)} damage`
        ),
        ...parseRequiredCapabilities(phase.boss.mechanics.tags).map(
          (requirement) =>
            `Required capability: ${
              requirement.known
                ? englishCapabilityRequirement(requirement.value)
                : 'Unrecognized requirement'
            }`
        )
      ])
    );
  }
  return Array.from(
    new Set([
      ...phase.phaseModifiers.map(localizeStygianModifier),
      ...phase.bossModifiers.map(localizeStygianModifier),
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

function englishModifierLabel(modifier: { id: string; description: string }): string {
  const id = modifier.id.trim().toLowerCase();
  const known: Record<string, string> = {
    'time-window': 'Tighter time window.',
    'energy-pressure': 'Increased energy pressure.',
    'phase-energy': 'This phase has significant energy pressure.',
    'boss-energy': 'The boss requires rapid energy cycles.'
  };
  if (known[id]) return known[id];
  const phase = /^phase-rule-(\d+)$/u.exec(id)?.[1];
  if (phase) return `Phase ${phase} mechanic.`;
  const boss = /^boss-rule-(\d+)$/u.exec(id)?.[1];
  if (boss) return `Boss ${boss} modifier.`;
  return 'Modifier details unavailable.';
}

function englishMechanicTerm(value: string): string {
  const normalized = value.toLowerCase().replace(/(?:-damage| damage)$/u, '');
  if (normalized === 'physical') return 'Physical';
  const element = characterElementLabel(normalized, 'en');
  return element === 'Unknown' ? 'Other damage' : element;
}

function englishCapabilityRequirement(value: string): string {
  const labels: Record<string, string> = {
    healing: 'Healing',
    shield: 'Shielding',
    grouping: 'Grouping',
    'off-field': 'Off-field utility',
    'on-field': 'On-field presence',
    onslaught: 'Frontline pressure',
    plunging: 'Plunging Attacks',
    'normal-attack': 'Normal Attacks',
    'charged-attack': 'Charged Attacks',
    sword: 'Sword user',
    claymore: 'Claymore user',
    polearm: 'Polearm user',
    bow: 'Bow user',
    catalyst: 'Catalyst user'
  };
  return labels[value] ?? 'Verified capability';
}

export function cycleStygianIntervention(
  state: StygianInterventionState
): StygianInterventionState {
  return state === 'neutral' ? 'locked' : state === 'locked' ? 'excluded' : 'neutral';
}

export function progressStepLabel(
  step: StygianAdvisorProgressStep,
  locale: PresentationLocale = 'zh'
): string {
  return locale === 'en' ? EN_PROGRESS_LABELS[step] : PROGRESS_LABELS[step];
}
