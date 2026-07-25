import type {
  AbyssAdvisorProgressStep,
  AbyssPlanIssueCode
} from '../../../shared/abyss-advisor.js';
import type {
  AgentFailureCode,
  AgentStage,
  AgentStageTrace,
  AgentToolTrace
} from '../../../shared/agent-run-trace.js';
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
  'interpreting-builds': '识别当前配装',
  'checking-knowledge': '匹配本地攻略知识',
  'researching-guides': '补充攻略上下文',
  'analyzing-rules': '分析挑战规则',
  'generating-teams': '生成双队',
  'checking-conflicts': '检查冲突',
  'writing-tactics': '整理打法'
};

const EN_PROGRESS_LABELS: Record<AbyssAdvisorProgressStep, string> = {
  'reading-roster': 'Reading roster',
  'interpreting-builds': 'Interpreting builds',
  'checking-knowledge': 'Checking trusted knowledge',
  'researching-guides': 'Researching current guides',
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

const AGENT_STAGE_LABELS: Record<AgentStage, { zh: string; en: string }> = {
  knowledge: { zh: '可信知识', en: 'Trusted knowledge' },
  research: { zh: '攻略研究', en: 'Guide research' },
  compose: { zh: '队伍构成', en: 'Team composition' },
  'repair-1': { zh: '第一次修复', en: 'First repair' },
  'repair-2': { zh: '第二次修复', en: 'Second repair' },
  critique: { zh: '队伍审查', en: 'Team critique' },
  rotation: { zh: '循环指导', en: 'Rotation coaching' },
  explain: { zh: '玩家说明', en: 'Player explanation' }
};

const AGENT_STATUS_LABELS: Record<
  AgentStageTrace['status'] | AgentToolTrace['status'],
  { zh: string; en: string }
> = {
  started: { zh: '已开始', en: 'Started' },
  completed: { zh: '已完成', en: 'Completed' },
  failed: { zh: '失败', en: 'Failed' },
  skipped: { zh: '已跳过', en: 'Skipped' }
};

const AGENT_FAILURE_LABELS: Record<AgentFailureCode, { zh: string; en: string }> = {
  AGENT_ABORTED: { zh: '运行已取消', en: 'Run cancelled' },
  AGENT_TIMEOUT: { zh: '运行超时', en: 'Run timed out' },
  SDK_START_FAILED: { zh: '模型运行器启动失败', en: 'Model runner failed to start' },
  PROVIDER_ERROR: { zh: '模型服务错误', en: 'Provider error' },
  SEARCH_UNAVAILABLE: { zh: '攻略搜索不可用', en: 'Guide search unavailable' },
  SEARCH_BUDGET_EXCEEDED: { zh: '攻略搜索次数已用尽', en: 'Guide search budget exceeded' },
  SEARCH_OUTPUT_INVALID: { zh: '攻略搜索结果无效', en: 'Guide search result invalid' },
  TOOL_REQUIREMENT_FAILED: { zh: '业务工具要求未满足', en: 'Business tool requirement failed' },
  AGENT_OUTPUT_INVALID: { zh: '模型输出无效', en: 'Model output invalid' },
  VALIDATION_FAILED: { zh: '方案校验失败', en: 'Plan validation failed' }
};

const AGENT_TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  mcp__genshin__read_profile_cache: { zh: '读取角色资料', en: 'Read character data' },
  mcp__genshin__query_genshin_db: { zh: '查询游戏资料', en: 'Query game data' },
  mcp__genshin__query_enemy_data: { zh: '查询敌人资料', en: 'Query enemy data' }
};

const BLOCKED_ISSUE_PRESENTATIONS: Record<
  AbyssPlanIssueCode,
  {
    message: { zh: string; en: string };
    action: { zh: string; en: string };
  }
> = {
  INPUT_INVALID: {
    message: { zh: '当前配队条件无效', en: 'The current team constraints are invalid' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  SCENARIO_MISMATCH: {
    message: { zh: '挑战资料已变化', en: 'Challenge data changed' },
    action: {
      zh: '刷新挑战资料或重新选择目标',
      en: 'Refresh challenge data or choose the target again'
    }
  },
  DATA_VERSION_MISMATCH: {
    message: { zh: '挑战资料版本已变化', en: 'The challenge data version changed' },
    action: {
      zh: '刷新挑战资料或重新选择目标',
      en: 'Refresh challenge data or choose the target again'
    }
  },
  TARGET_NOT_FOUND: {
    message: {
      zh: '所选楼层或间数已不可用',
      en: 'The selected floor or chamber is no longer available'
    },
    action: {
      zh: '刷新挑战资料或重新选择目标',
      en: 'Refresh challenge data or choose the target again'
    }
  },
  ROSTER_INSUFFICIENT: {
    message: { zh: '可用角色不足', en: 'Not enough eligible characters' },
    action: { zh: '更新角色资料', en: 'Update character data' }
  },
  LOCK_LIMIT_EXCEEDED: {
    message: { zh: '锁定角色数量超过双队容量', en: 'Too many characters are locked' },
    action: { zh: '调整锁定与排除', en: 'Adjust locked and excluded characters' }
  },
  LOCK_EXCLUDE_CONFLICT: {
    message: {
      zh: '同一角色同时被锁定与排除',
      en: 'A character is both locked and excluded'
    },
    action: { zh: '调整锁定与排除', en: 'Adjust locked and excluded characters' }
  },
  CHARACTER_NOT_OWNED: {
    message: { zh: '所选角色不在当前角色资料中', en: 'A selected character is not in this roster' },
    action: { zh: '更新角色资料', en: 'Update character data' }
  },
  CHARACTER_EXCLUDED: {
    message: { zh: '方案使用了已排除角色', en: 'The plan uses an excluded character' },
    action: { zh: '调整锁定与排除', en: 'Adjust locked and excluded characters' }
  },
  LOCKED_CHARACTER_MISSING: {
    message: { zh: '锁定角色不在当前角色资料中', en: 'A locked character is missing from this roster' },
    action: { zh: '更新角色资料', en: 'Update character data' }
  },
  TEAM_SIZE_INVALID: {
    message: { zh: '队伍人数不符合要求', en: 'A team does not have the required number of members' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  TEAM_DUPLICATE: {
    message: { zh: '同一队伍出现重复角色', en: 'A team contains duplicate characters' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  CROSS_TEAM_DUPLICATE: {
    message: { zh: '上下半出现重复角色', en: 'A character appears in both halves' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  CHAMBER_COVERAGE_INVALID: {
    message: { zh: '方案没有覆盖全部目标间数', en: 'The plan does not cover every selected chamber' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  TACTICS_MISSING: {
    message: { zh: '方案缺少逐间打法', en: 'The plan is missing chamber tactics' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  MECHANIC_COVERAGE_INVALID: {
    message: { zh: '队伍无法可靠应对目标机制', en: 'The teams do not safely cover the target mechanics' },
    action: { zh: '调整锁定与排除', en: 'Adjust locked and excluded characters' }
  },
  SEARCH_BUDGET_EXCEEDED: {
    message: { zh: '本次攻略搜索次数已用尽', en: 'The guide search budget was exhausted' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  PRESERVED_HALF_CONFLICT: {
    message: { zh: '保留队伍与当前选择冲突', en: 'The preserved half conflicts with the current choices' },
    action: { zh: '调整锁定与排除', en: 'Adjust locked and excluded characters' }
  },
  PRESERVED_HALF_CHANGED: {
    message: { zh: '重新计算时保留队伍发生变化', en: 'The preserved half changed during recalculation' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  PLAN_SCHEMA_INVALID: {
    message: { zh: '方案未能安全通过校验', en: 'The plan could not be validated safely' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  },
  AGENT_OUTPUT_INVALID: {
    message: { zh: '模型没有返回可用方案', en: 'The model did not return a usable plan' },
    action: { zh: '检查当前选择后重试', en: 'Review the current choices and try again' }
  }
};

export function blockedIssuePresentation(
  code: AbyssPlanIssueCode,
  locale: PresentationLocale
): { message: string; action: string } {
  const presentation = BLOCKED_ISSUE_PRESENTATIONS[code];
  return {
    message: presentation.message[locale],
    action: presentation.action[locale]
  };
}

export function agentStageLabel(stage: AgentStage, locale: PresentationLocale): string {
  return AGENT_STAGE_LABELS[stage][locale];
}

export function agentStatusLabel(
  status: AgentStageTrace['status'] | AgentToolTrace['status'],
  locale: PresentationLocale
): string {
  return AGENT_STATUS_LABELS[status][locale];
}

export function agentFailureLabel(code: AgentFailureCode, locale: PresentationLocale): string {
  return AGENT_FAILURE_LABELS[code][locale];
}

export function agentToolLabel(name: string, locale: PresentationLocale): string {
  return (
    AGENT_TOOL_LABELS[name]?.[locale] ?? (locale === 'en' ? 'Business tool' : '业务工具')
  );
}

export function localizedEvidenceReason(
  reason: string,
  locale: PresentationLocale
): string {
  if (locale === 'zh' || !/[\u3400-\u9fff]/u.test(reason)) return reason;
  return 'Verified fit evidence is available for this member.';
}

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

export function narrativeTargetBody(
  narrative: Pick<AdvisorNarrative, 'sections'> | undefined,
  targetKey: string,
  locale: PresentationLocale
): string {
  return narrativeTargetPresentation(narrative, targetKey, locale).body;
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

export function sourceBadge(
  source: 'smart-service' | 'local-rules' | 'blocked',
  locale: PresentationLocale = 'zh'
): string {
  if (locale === 'en') {
    return source === 'smart-service'
      ? 'AI verified'
      : source === 'local-rules'
        ? 'Local rules'
        : 'Unavailable';
  }
  return source === 'smart-service'
    ? 'AI 已验证'
    : source === 'local-rules'
      ? '本地规则'
      : '无法生成';
}
