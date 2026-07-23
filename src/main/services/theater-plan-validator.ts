import type { CharacterProfile } from '../../shared/domain.js';
import { theaterPlanSchema, type TheaterPlan } from '../../shared/scenario-v2.js';
import type {
  TheaterAdvisorPlanInput,
  TheaterPlanIssue,
  TheaterScenario,
  TheaterVigorBudgetItem
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
      vigorBudget: TheaterVigorBudgetItem[];
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
  const ownedById = new Map(characters.map((character) => [String(character.id), character]));
  const excluded = new Set(input.excludedCharacterIds);
  const allowedElements = new Set(
    scenario.eligibility.elements.map((value) => value.toLowerCase())
  );
  const configuredSpecialGuests = new Set(scenario.pools.specialGuest.map(({ id }) => id));
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
  const castBySource = [
    ['owned', plan.cast.selectedCharacterIds],
    ['opening', plan.cast.openingCharacterIds],
    ['trial', plan.cast.trialCharacterIds],
    ['special-guest', plan.cast.specialGuestCharacterIds],
    ['support', plan.cast.supportCharacterIds]
  ] as const;
  const sourceById = new Map<string, (typeof castBySource)[number][0]>();
  for (const [source, ids] of castBySource) {
    ids.forEach((id, index) => {
      const previous = sourceById.get(id);
      if (previous && previous !== source) {
        issues.push(
          issue(
            'CAST_DUPLICATE',
            ['cast', source, index],
            '同一演员不能同时以多个来源身份进入路线。',
            { characterId: id, sources: [previous, source] }
          )
        );
      } else sourceById.set(id, source);
    });
  }
  const qualifiedOwnedIds = new Set<string>();
  for (const [id, source] of sourceById) {
    const character = ownedById.get(id);
    if (!character) continue;
    if (source !== 'owned' && excluded.has(id)) {
      issues.push(
        issue(
          'CHARACTER_EXCLUDED',
          ['cast', source],
          '已排除的自有角色不能换用外部来源进入演员池。',
          {
            characterId: id
          }
        )
      );
    }
    const levelQualified = (character.level ?? 0) >= scenario.eligibility.minimumLevel;
    const elementQualified =
      allowedElements.has(character.element.toLowerCase()) ||
      (source === 'special-guest' && configuredSpecialGuests.has(id));
    if (levelQualified && elementQualified) qualifiedOwnedIds.add(id);
    else {
      issues.push(
        issue(
          'CAST_ELIGIBILITY_INVALID',
          ['cast', source],
          '最终演员池包含不满足当期元素或等级规则的自有角色。',
          { characterId: id, levelQualified, elementQualified }
        )
      );
    }
  }
  if (qualifiedOwnedIds.size < scenario.eligibility.requiredHeadcount) {
    issues.push(
      issue(
        'CAST_ELIGIBILITY_INVALID',
        ['cast'],
        '最终演员池没有保留足够多通过硬资格检查的自有角色。',
        {
          required: scenario.eligibility.requiredHeadcount,
          qualified: qualifiedOwnedIds.size
        }
      )
    );
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

  const sortedActs = plan.acts.slice().sort((left, right) => left.act - right.act);
  const remainingByCharacter = new Map<string, number>();
  const vigorBudget: TheaterVigorBudgetItem[] = [];
  for (const actPlan of sortedActs) {
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
    const spendByCharacter = new Map(
      actPlan.plannedVigorSpend.map((spend) => [spend.characterId, spend])
    );
    actPlan.candidateCharacterIds.forEach((id, index) => {
      if (!spendByCharacter.has(id)) {
        issues.push(
          issue(
            'VIGOR_BUDGET_INVALID',
            ['acts', actPlan.act, 'candidateCharacterIds', index],
            '每名计划出场的候选演员都必须有逐角色活力记录。',
            { characterId: id }
          )
        );
      }
    });
    for (const [index, spend] of actPlan.plannedVigorSpend.entries()) {
      if (
        !candidateSet.has(spend.characterId) ||
        configuredCost === undefined ||
        spend.cost !== configuredCost
      ) {
        issues.push(
          issue(
            'VIGOR_BUDGET_INVALID',
            ['acts', actPlan.act, 'plannedVigorSpend', index],
            '活力花费与候选角色或当期规则不一致。'
          )
        );
        continue;
      }
      const before = remainingByCharacter.get(spend.characterId) ?? scenario.vigor.initial;
      const after = before - spend.cost;
      vigorBudget.push({
        act: actPlan.act,
        characterId: spend.characterId,
        before,
        spent: spend.cost,
        after: Math.max(0, after)
      });
      remainingByCharacter.set(spend.characterId, after);
      if (after < 0 || before > scenario.vigor.max) {
        issues.push(
          issue(
            'VIGOR_BUDGET_INVALID',
            ['acts', actPlan.act, 'plannedVigorSpend', index],
            '该演员的逐幕活力已不足，不能按此路线继续出场。',
            { characterId: spend.characterId }
          )
        );
      }
    }
    const availableKinds = new Set(scenarioAct.pathNotes.map(({ kind }) => kind));
    const validPath =
      (actPlan.pathChoice.kind === 'fixed' &&
        (availableKinds.size === 0 || availableKinds.has('fixed'))) ||
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
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, plan: { ...plan, acts: sortedActs }, vigorBudget };
}

function issue(
  code: TheaterPlanIssue['code'],
  path: TheaterPlanIssue['path'],
  message: string,
  details?: Record<string, unknown>
): TheaterPlanIssue {
  return { code, path, message, ...(details ? { details } : {}) };
}
