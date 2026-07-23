import type { CharacterProfile } from '../../shared/domain.js';
import {
  theaterAdvisorResultSchema,
  type TheaterAdvisorPlanInput,
  type TheaterAdvisorResult,
  type TheaterScenario
} from '../../shared/theater-advisor.js';
import {
  characterSatisfiesRequirement,
  parseRequiredCapabilities
} from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import { evaluateTheaterEligibility } from './theater-eligibility.js';
import { validateTheaterPlan } from './theater-plan-validator.js';

export interface BuildLocalTheaterPlanOptions {
  input: TheaterAdvisorPlanInput;
  scenario: TheaterScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  scenarioTrust?: 'production' | 'development-sample';
  scenarioFreshness?: 'fresh' | 'expiring' | 'stale' | 'unknown';
}

export function buildLocalTheaterPlan({
  input,
  scenario,
  characters,
  knowledge,
  scenarioTrust = 'production',
  scenarioFreshness = 'fresh'
}: BuildLocalTheaterPlanOptions): TheaterAdvisorResult {
  const eligibility = evaluateTheaterEligibility({ input, scenario, characters, knowledge });
  const common = {
    correlationId: input.correlationId,
    source: 'local-rules' as const,
    scenarioTrust,
    scenarioFreshness,
    eligibility
  };
  if (eligibility.status === 'blocked') {
    return theaterAdvisorResultSchema.parse({
      status: 'blocked',
      ...common,
      issues: [
        {
          code: 'ROSTER_INSUFFICIENT',
          path: ['profile', 'characters'],
          message: `按已确认的元素、等级和人数规则，还缺 ${eligibility.shortage} 名可入场角色。`,
          details: {
            required: eligibility.requiredHeadcount,
            qualified: eligibility.hardQualifiedCount,
            missing: eligibility.shortage
          }
        }
      ],
      warnings: ['资格不足时不会调用智能服务生成无效路线。'],
      assumptions: ['未说明是否计入硬资格的试用或支援演员，暂不计入。']
    });
  }

  const byId = new Map(characters.map((character) => [String(character.id), character]));
  const selectedOwned = eligibility.eligibleOwnedCharacterIds
    .map((id) => byId.get(id))
    .filter((value): value is CharacterProfile => Boolean(value))
    .sort(compareCharacters(input));
  const targetActs = scenario.acts
    .filter(({ act }) => input.act === undefined || input.act === act)
    .slice()
    .sort((left, right) => left.act - right.act);
  const scarceIds = new Set<string>();
  const acts = targetActs.map((act, actIndex) => {
    const requirements = unique(
      act.encounters.flatMap(({ waves }) =>
        waves.flatMap(({ enemies }) =>
          enemies.flatMap(({ mechanics }) =>
            parseRequiredCapabilities(mechanics.tags).map(({ value }) => value)
          )
        )
      )
    );
    const required = requirements.flatMap((requirement) => {
      const match = selectedOwned.find((character) =>
        characterSatisfiesRequirement(String(character.id), requirement, knowledge)
      );
      if (match) scarceIds.add(String(match.id));
      return match ? [match] : [];
    });
    const preferred = selectedOwned.filter(
      ({ id }) => !scarceIds.has(String(id)) || required.some((item) => item.id === id)
    );
    const rotated = [...preferred.slice(actIndex * 4), ...preferred.slice(0, actIndex * 4)];
    const candidates = uniqueCharacters([...required, ...rotated]).slice(0, 4);
    const scenarioCost =
      scenario.vigor.actCosts.find(({ act: number }) => number === act.act)?.cost ?? 0;
    return {
      act: act.act,
      candidateCharacterIds: candidates.map(({ id }) => String(id)),
      plannedVigorSpend:
        candidates[0] && scenarioCost > 0
          ? [{ characterId: String(candidates[0].id), cost: scenarioCost }]
          : [],
      pathChoice: pathChoiceFor(act.pathNotes)
    };
  });
  let remaining = scenario.vigor.initial;
  for (const act of acts) {
    const spend = act.plannedVigorSpend.reduce((total, item) => total + item.cost, 0);
    if (spend > remaining) act.plannedVigorSpend = [];
    else remaining -= spend;
  }
  const warnings = [
    ...(acts.some(({ plannedVigorSpend }) => plannedVigorSpend.length === 0)
      ? ['已知总活力无法覆盖每一幕的预计花费，未确认部分保留为现场调整。']
      : []),
    ...eligibility.pools
      .filter(({ qualification }) => qualification === 'unknown')
      .map(({ source }) => `${poolLabel(source)}的硬资格计入规则未说明，本次不依赖其达标。`)
  ];
  const assumptions = [
    '路线计划只使用当期场景中已声明的幕次、活力和机制。',
    '随机节点只给出条件策略，不承诺实际出现顺序。'
  ];
  const plan = {
    mode: 'imaginarium-theater' as const,
    schemaVersion: 2 as const,
    scenarioId: scenario.id,
    dataVersion: scenario.meta.dataVersion,
    confidence: 'medium' as const,
    warnings,
    assumptions,
    cast: {
      openingCharacterIds: input.selectedOpeningCharacterIds,
      selectedCharacterIds: selectedOwned.map(({ id }) => String(id)),
      trialCharacterIds: input.selectedTrialCharacterIds,
      specialGuestCharacterIds: input.selectedSpecialGuestCharacterIds,
      supportCharacterIds: input.selectedSupportCharacterIds
    },
    acts
  };
  const validation = validateTheaterPlan({ input, scenario, characters, knowledge, plan });
  if (!validation.ok) {
    return theaterAdvisorResultSchema.parse({
      status: 'blocked',
      ...common,
      issues: validation.issues,
      warnings,
      assumptions
    });
  }
  return theaterAdvisorResultSchema.parse({
    status: 'planned',
    ...common,
    issues: [],
    warnings,
    assumptions,
    plan: validation.plan,
    vigorBudget: validation.vigorBudget,
    routeGuidance: {
      preserveCharacterIds: [...scarceIds],
      arcanaPriorityIds: scenario.arcanaNodes?.map(({ id }) => id) ?? [],
      notes: [
        scarceIds.size > 0
          ? '保留稀缺机制角色到对应幕次，其他幕优先轮换资料完整的演员。'
          : '当期资料没有确认稀缺机制角色，按资料完整度与等级轮换演员。',
        scenario.arcanaNodes && scenario.arcanaNodes.length > 0
          ? '增益与分支优先级来自当期节点资料；条件未满足时不强行选择。'
          : '当期资料未提供可验证的增益节点，不自行补写优先级。'
      ]
    }
  });
}

function compareCharacters(input: TheaterAdvisorPlanInput) {
  const selected = new Set(input.selectedCharacterIds);
  return (left: CharacterProfile, right: CharacterProfile) =>
    Number(selected.has(String(right.id))) - Number(selected.has(String(left.id))) ||
    completenessScore(right) - completenessScore(left) ||
    (right.level ?? 0) - (left.level ?? 0) ||
    left.id - right.id;
}

function completenessScore(character: CharacterProfile): number {
  return character.completeness === 'detailed' ? 3 : character.completeness === 'build' ? 2 : 1;
}

function pathChoiceFor(notes: TheaterScenario['acts'][number]['pathNotes']) {
  const fixed = notes.find(({ kind }) => kind === 'fixed');
  if (fixed) return { kind: 'fixed' as const, note: fixed.text };
  const conditional = notes.find(
    (note): note is Extract<(typeof notes)[number], { kind: 'conditional' }> =>
      note.kind === 'conditional'
  );
  if (conditional)
    return {
      kind: 'conditional' as const,
      note: `如果${conditional.condition}，${conditional.text}。`
    };
  return {
    kind: 'conditional' as const,
    note: '如果实际出现该随机分支，再按当前敌人与剩余活力选择应对路线。'
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueCharacters(values: CharacterProfile[]): CharacterProfile[] {
  const seen = new Set<number>();
  return values.filter(({ id }) => (seen.has(id) ? false : (seen.add(id), true)));
}

function poolLabel(source: 'opening' | 'trial' | 'special-guest' | 'support'): string {
  return {
    opening: '开幕演员',
    trial: '试用演员',
    'special-guest': '特邀演员',
    support: '支援演员'
  }[source];
}
