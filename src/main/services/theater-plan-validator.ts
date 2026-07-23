import type { CharacterProfile } from '../../shared/domain.js';
import { theaterPlanSchema, type TheaterPlan } from '../../shared/scenario-v2.js';
import type {
  TheaterAdvisorPlanInput,
  TheaterPlanIssue,
  TheaterScenario
} from '../../shared/theater-advisor.js';
import {
  characterSatisfiesRequirement,
  parseRequiredCapabilities
} from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';

export type TheaterPlanValidation =
  | {
      ok: true;
      plan: TheaterPlan;
      vigorBudget: Array<{ act: number; before: number; spent: number; after: number }>;
    }
  | { ok: false; issues: TheaterPlanIssue[] };

export function validateTheaterPlan(options: {
  input: TheaterAdvisorPlanInput;
  scenario: TheaterScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  plan: unknown;
}): TheaterPlanValidation {
  const parsed = theaterPlanSchema.safeParse(options.plan);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [issue('PLAN_SCHEMA_INVALID', [], '方案结构不完整，无法验证演员与活力。')]
    };
  }
  const { input, scenario, characters, knowledge } = options;
  const plan = parsed.data;
  const issues: TheaterPlanIssue[] = [];
  if (input.scenarioId !== scenario.id || plan.scenarioId !== scenario.id) {
    issues.push(issue('SCENARIO_MISMATCH', ['scenarioId'], '方案与当前剧诗周期不一致。'));
  }
  if (
    input.dataVersion !== scenario.meta.dataVersion ||
    plan.dataVersion !== scenario.meta.dataVersion
  ) {
    issues.push(issue('DATA_VERSION_MISMATCH', ['dataVersion'], '方案使用的资料版本已变更。'));
  }
  const owned = new Set(characters.map(({ id }) => String(id)));
  const excluded = new Set(input.excludedCharacterIds);
  for (const [index, id] of plan.cast.selectedCharacterIds.entries()) {
    if (!owned.has(id)) {
      issues.push(
        issue(
          'CHARACTER_NOT_OWNED',
          ['cast', 'selectedCharacterIds', index],
          '入场池中有角色不在当前自有角色资料中。',
          { characterId: id }
        )
      );
    }
    if (excluded.has(id)) {
      issues.push(
        issue(
          'CHARACTER_EXCLUDED',
          ['cast', 'selectedCharacterIds', index],
          '已排除的角色不能进入演员池。',
          { characterId: id }
        )
      );
    }
  }
  const pools = {
    openingCharacterIds: new Set(scenario.pools.opening.map(({ id }) => id)),
    trialCharacterIds: new Set(scenario.pools.trial.map(({ id }) => id)),
    specialGuestCharacterIds: new Set(scenario.pools.specialGuest.map(({ id }) => id)),
    supportCharacterIds: new Set(scenario.pools.support.map(({ id }) => id))
  } as const;
  for (const key of Object.keys(pools) as Array<keyof typeof pools>) {
    plan.cast[key].forEach((id, index) => {
      if (!pools[key].has(id)) {
        issues.push(
          issue('CAST_SOURCE_MISMATCH', ['cast', key, index], '演员来源与当期名单不一致。', {
            characterId: id
          })
        );
      }
    });
  }
  const admitted = new Set([
    ...plan.cast.selectedCharacterIds,
    ...plan.cast.openingCharacterIds,
    ...plan.cast.trialCharacterIds,
    ...plan.cast.specialGuestCharacterIds,
    ...plan.cast.supportCharacterIds
  ]);
  const plannedActs = new Map(plan.acts.map((act) => [act.act, act]));
  const requiredActs = input.act === undefined ? scenario.acts.map(({ act }) => act) : [input.act];
  for (const act of requiredActs) {
    if (!scenario.acts.some((item) => item.act === act) || !plannedActs.has(act)) {
      issues.push(issue('ACT_COVERAGE_INVALID', ['acts'], '方案没有覆盖所选幕次。', { act }));
    }
  }

  let remaining = scenario.vigor.initial;
  const vigorBudget: Array<{ act: number; before: number; spent: number; after: number }> = [];
  for (const actPlan of plan.acts.slice().sort((left, right) => left.act - right.act)) {
    const scenarioAct = scenario.acts.find(({ act }) => act === actPlan.act);
    if (!scenarioAct) {
      issues.push(
        issue('ACT_COVERAGE_INVALID', ['acts'], '方案包含当期资料中不存在的幕次。', {
          act: actPlan.act
        })
      );
      continue;
    }
    const candidateSet = new Set(actPlan.candidateCharacterIds);
    actPlan.candidateCharacterIds.forEach((id, index) => {
      if (!admitted.has(id)) {
        issues.push(
          issue(
            'CANDIDATE_NOT_IN_CAST',
            ['acts', actPlan.act, 'candidateCharacterIds', index],
            '幕次候选角色不在入场演员池中。',
            { characterId: id }
          )
        );
      }
    });
    const configuredCost = scenario.vigor.actCosts.find(({ act }) => act === actPlan.act)?.cost;
    let spent = 0;
    for (const [index, spend] of actPlan.plannedVigorSpend.entries()) {
      spent += spend.cost;
      if (
        !candidateSet.has(spend.characterId) ||
        configuredCost === undefined ||
        spend.cost > configuredCost
      ) {
        issues.push(
          issue(
            'VIGOR_BUDGET_INVALID',
            ['acts', actPlan.act, 'plannedVigorSpend', index],
            '活力花费与候选角色或当期规则不一致。'
          )
        );
      }
    }
    const before = remaining;
    remaining -= spent;
    vigorBudget.push({ act: actPlan.act, before, spent, after: Math.max(0, remaining) });
    if (remaining < 0 || before > scenario.vigor.max) {
      issues.push(
        issue(
          'VIGOR_BUDGET_INVALID',
          ['acts', actPlan.act],
          '逐幕活力预算已不足，不能按此路线执行。'
        )
      );
    }
    const availableKinds = new Set(scenarioAct.pathNotes.map(({ kind }) => kind));
    const validPath =
      (actPlan.pathChoice.kind === 'fixed' && availableKinds.has('fixed')) ||
      (actPlan.pathChoice.kind === 'random' && availableKinds.has('random')) ||
      (actPlan.pathChoice.kind === 'conditional' &&
        (availableKinds.has('conditional') || availableKinds.has('random')));
    if (!validPath) {
      issues.push(
        issue(
          'PATH_CHOICE_INVALID',
          ['acts', actPlan.act, 'pathChoice'],
          '路线确定性与当期资料不一致；随机结果不能写成已确定。'
        )
      );
    }
    const requirements = scenarioAct.encounters.flatMap(({ waves }) =>
      waves.flatMap(({ enemies }) =>
        enemies.flatMap(({ mechanics }) => parseRequiredCapabilities(mechanics.tags))
      )
    );
    for (const requirement of requirements) {
      if (
        !requirement.known ||
        !actPlan.candidateCharacterIds.some((id) =>
          characterSatisfiesRequirement(id, requirement.value, knowledge)
        )
      ) {
        issues.push(
          issue(
            'MECHANIC_COVERAGE_INVALID',
            ['acts', actPlan.act, 'candidateCharacterIds'],
            '幕次候选角色没有已确认覆盖所有硬机制要求。',
            { requirement: requirement.value }
          )
        );
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, plan, vigorBudget };
}

function issue(
  code: TheaterPlanIssue['code'],
  path: TheaterPlanIssue['path'],
  message: string,
  details?: Record<string, unknown>
): TheaterPlanIssue {
  return { code, path, message, ...(details ? { details } : {}) };
}
