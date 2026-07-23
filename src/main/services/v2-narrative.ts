import type {
  V2AgentTarget,
  V2CritiqueOutput,
  V2ExplainOutput,
  V2RotationOutput
} from '../agents/contracts.js';
import type {
  AbyssTeamRisk,
  AdvisorFactRef,
  AdvisorLocale,
  AdvisorNarrative,
  AdvisorNarrativeReasonCode,
  LocalizedAdvisorText
} from '../../shared/advisor-narrative.js';

type Directive = V2RotationOutput['rotations'][number] | V2ExplainOutput['explanations'][number];

const REASON_TEXT: Record<AdvisorNarrativeReasonCode, LocalizedAdvisorText> = {
  'setup-order': {
    'zh-CN': '先完成辅助布置再进入主要输出。',
    'en-US': 'Set up support effects before committing to the main damage window.'
  },
  'energy-cycle': {
    'zh-CN': '保留足够能量衔接下一轮循环。',
    'en-US': 'Preserve enough energy to connect cleanly into the next cycle.'
  },
  'survival-window': {
    'zh-CN': '在高压窗口保留生存手段并避免贪刀。',
    'en-US': 'Keep defensive coverage for pressure windows and avoid overextending.'
  },
  'reaction-chain': {
    'zh-CN': '按已验证队伍顺序维持元素反应链。',
    'en-US': 'Follow the validated team order to maintain the reaction chain.'
  },
  'mechanic-response': {
    'zh-CN': '围绕已核对的关卡机制安排关键动作。',
    'en-US': 'Time key actions around the verified encounter mechanic.'
  },
  'target-priority': {
    'zh-CN': '优先处理会破坏循环稳定性的目标。',
    'en-US': 'Prioritize targets that would otherwise disrupt the rotation.'
  },
  'vigor-budget': {
    'zh-CN': '按已核对的活力账本分配本幕演员。',
    'en-US': 'Assign actors according to the verified Vigor ledger.'
  },
  'cast-flexibility': {
    'zh-CN': '保留演员调度余量应对后续幕次。',
    'en-US': 'Keep cast flexibility available for later acts.'
  },
  uncertainty: {
    'zh-CN': '未确认的信息保持未知，并在实战中复核。',
    'en-US': 'Unverified details remain unknown and should be checked in play.'
  }
};

export function renderV2Narrative(options: {
  mode: 'spiral-abyss' | 'stygian-onslaught' | 'imaginarium-theater';
  locale: AdvisorLocale;
  critique: V2CritiqueOutput;
  rotation: V2RotationOutput;
  explanation: V2ExplainOutput;
}): AdvisorNarrative {
  const grouped = new Map<string, { target: V2AgentTarget; directives: Directive[] }>();
  for (const directive of [...options.rotation.rotations, ...options.explanation.explanations]) {
    const key = targetKey(directive.target);
    const current = grouped.get(key);
    if (current) current.directives.push(directive);
    else grouped.set(key, { target: directive.target, directives: [directive] });
  }
  return {
    origin: 'agent-structured',
    requestedLocale: options.locale,
    summary: modeSummary(options.mode),
    sections: [...grouped.entries()].map(([key, { target, directives }]) => {
      const reasonCodes = unique(directives.flatMap(({ reasonCodes }) => reasonCodes));
      const factRefs = uniqueFactRefs(directives.flatMap(({ factRefs }) => factRefs));
      const tone = directives.some(({ tone }) => tone === 'cautious')
        ? ('cautious' as const)
        : directives.some(({ tone }) => tone === 'technical')
          ? ('technical' as const)
          : ('steady' as const);
      return {
        targetKey: key,
        tone,
        reasonCodes,
        factRefs,
        title: targetTitle(target),
        body: {
          'zh-CN': reasonCodes.map((code) => REASON_TEXT[code]!['zh-CN']).join(''),
          'en-US': reasonCodes.map((code) => REASON_TEXT[code]!['en-US']).join(' ')
        }
      };
    })
  };
}

export function renderAbyssTeamRisks(critique: V2CritiqueOutput): AbyssTeamRisk[] {
  return critique.issues.flatMap(({ target, code, severity }) =>
    target.kind === 'abyss-team'
      ? [
          {
            half: target.half,
            code,
            severity,
            narrative: {
              'zh-CN': '这套队伍存在已接受的软风险，实战时请保留调整余量。',
              'en-US': 'This team has an accepted soft risk; keep room to adjust during the run.'
            }
          }
        ]
      : []
  );
}

function modeSummary(
  mode: 'spiral-abyss' | 'stygian-onslaught' | 'imaginarium-theater'
): LocalizedAdvisorText {
  if (mode === 'spiral-abyss')
    return {
      'zh-CN': '智能阶段已在既有双队与逐间目标上完成结构化复核。',
      'en-US': 'The smart stages completed a structured review of the validated teams and chambers.'
    };
  if (mode === 'stygian-onslaught')
    return {
      'zh-CN': '智能阶段已在既有三阶段队伍上完成结构化复核。',
      'en-US': 'The smart stages completed a structured review of the three validated phase teams.'
    };
  return {
    'zh-CN': '智能阶段已在既有演员池、活力预算与逐幕路线之上完成结构化复核。',
    'en-US':
      'The smart stages completed a structured review of the validated cast, Vigor budget, and act route.'
  };
}

function targetKey(target: V2AgentTarget): string {
  switch (target.kind) {
    case 'abyss-team':
      return `abyss-team:${target.half}`;
    case 'abyss-chamber':
      return `abyss-chamber:${target.floor}:${target.chamber}:${target.half}`;
    case 'stygian-phase':
      return `stygian-phase:${target.phase}`;
    case 'theater-act':
      return `theater-act:${target.act}`;
    case 'theater-cast':
      return 'theater-cast';
  }
}

function targetTitle(target: V2AgentTarget): LocalizedAdvisorText {
  switch (target.kind) {
    case 'abyss-team':
      return target.half === 'first'
        ? { 'zh-CN': '上半队伍', 'en-US': 'First-half team' }
        : { 'zh-CN': '下半队伍', 'en-US': 'Second-half team' };
    case 'abyss-chamber':
      return {
        'zh-CN': `第 ${target.floor} 层第 ${target.chamber} 间${target.half === 'first' ? '上半' : '下半'}`,
        'en-US': `Floor ${target.floor}, Chamber ${target.chamber}, ${target.half} half`
      };
    case 'stygian-phase':
      return { 'zh-CN': `第 ${target.phase} 阶段`, 'en-US': `Phase ${target.phase}` };
    case 'theater-act':
      return { 'zh-CN': `第 ${target.act} 幕`, 'en-US': `Act ${target.act}` };
    case 'theater-cast':
      return { 'zh-CN': '演员池安排', 'en-US': 'Cast allocation' };
  }
}

function factRefKey(
  ref: AdvisorFactRef
): string {
  switch (ref.kind) {
    case 'plan':
      return `plan:${ref.field}`;
    case 'mechanic':
      return `mechanic:${ref.target}:${ref.factIndex}`;
    case 'profile':
      return `profile:${ref.characterId}:${ref.field}`;
    case 'knowledge':
      return `knowledge:${ref.characterId}`;
  }
}

function uniqueFactRefs(refs: AdvisorFactRef[]): AdvisorFactRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = factRefKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
