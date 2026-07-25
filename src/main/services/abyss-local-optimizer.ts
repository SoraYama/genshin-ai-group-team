import type { CharacterProfile } from '../../shared/domain.js';
import {
  abyssAdvisorResultSchema,
  type AbyssAdvisorPlanInput,
  type AbyssAdvisorResult,
  type AbyssPlanIssue,
  type AbyssScenario
} from '../../shared/abyss-advisor.js';
import type { EnemyInstance } from '../../shared/scenario-v2.js';
import {
  ABYSS_SHIELD_COUNTERS,
  abyssElementLabel,
  findAbyssMechanicCoverageGaps,
  characterSatisfiesRequirement,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import { validateAbyssPlan } from './abyss-plan-validator.js';
import { renderLocalPlanNarrative } from './local-advisor-narrative.js';

export interface BuildLocalAbyssPlanOptions {
  input: AbyssAdvisorPlanInput;
  scenario: AbyssScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  /** Test/debug override. Production uses the bounded default below. */
  searchStateBudget?: number;
}

const ELEMENTS: Record<string, string> = {
  pyro: '火',
  hydro: '水',
  anemo: '风',
  geo: '岩',
  electro: '雷',
  dendro: '草',
  cryo: '冰'
};

// C(16, 4) = 1,820 candidates per half. This hard ceiling keeps the synchronous
// fallback below a predictable main-process budget even for very large rosters.
const MAX_JOINT_POOL_SIZE = 16;
// Recommendation runs synchronously in Electron's main process. Complex but valid scenario data
// must fail closed before it can monopolize the event loop.
const DEFAULT_FEASIBILITY_STATE_BUDGET = 12_000;
const MAX_HARD_CONSTRAINT_BITS = 64;

type FeasibilityResult<T> =
  | { status: 'feasible'; value: T }
  | { status: 'infeasible' }
  | { status: 'budget-exceeded' };

export function buildLocalAbyssPlan({
  input,
  scenario,
  characters,
  knowledge,
  searchStateBudget
}: BuildLocalAbyssPlanOptions): AbyssAdvisorResult {
  const stateBudget = normalizeStateBudget(searchStateBudget);
  const inputIssues = validateInputConstraints(input, characters);
  if (inputIssues.length > 0) return blocked(inputIssues);

  const excluded = new Set(input.excludedCharacterIds);
  const available = characters.filter(({ id }) => !excluded.has(String(id)));
  if (available.length < 8) {
    return blocked([
      issue('ROSTER_INSUFFICIENT', ['profile', 'characters'], '排除后可用角色不足 8 名。', {
        required: 8,
        available: available.length,
        missing: 8 - available.length
      })
    ]);
  }

  const floor = scenario.floors.find(({ floor: number }) => number === input.floor);
  const chambers = floor?.chambers.filter(
    ({ chamber }) => input.chamber === undefined || chamber === input.chamber
  );
  if (!floor || !chambers || chambers.length === 0) {
    return blocked([
      issue('TARGET_NOT_FOUND', ['target'], '所选楼层或房间不在当前资料中。', {
        floor: input.floor,
        chamber: input.chamber
      })
    ]);
  }

  const firstEnemies = chambers.flatMap(({ firstHalf }) =>
    firstHalf.waves.flatMap(({ enemies }) => enemies)
  );
  const secondEnemies = chambers.flatMap(({ secondHalf }) =>
    secondHalf.waves.flatMap(({ enemies }) => enemies)
  );
  if (input.priorPlan && input.recomputeHalf) {
    return buildPartialPlan({
      input,
      scenario,
      characters,
      knowledge,
      searchStateBudget: stateBudget,
      chambers,
      firstEnemies,
      secondEnemies
    });
  }
  const assignment = optimizeJointAssignment(
    available,
    input.lockedCharacterIds,
    firstEnemies,
    secondEnemies,
    input,
    knowledge,
    stateBudget
  );
  if (assignment.status === 'budget-exceeded') {
    return blocked([searchBudgetIssue(['teams'])]);
  }
  if (assignment.status === 'infeasible') {
    return blocked([
      issue(
        'MECHANIC_COVERAGE_INVALID',
        ['teams'],
        '当前角色与干预条件无法组成同时覆盖上下半硬机制的两支队伍。'
      )
    ]);
  }
  const selectedAssignment = assignment.value;

  const warnings = buildWarnings(selectedAssignment, chambers.length);
  const assumptions = [
    '本地规则只使用已知的元素、等级、资料完整度、充能与敌人机制；未知角色职责没有被当作确定事实。',
    '角色职责、技能范围和实战操作未进入本地知识时，打法采用保守描述。'
  ];
  const plan = {
    mode: 'spiral-abyss' as const,
    schemaVersion: 2 as const,
    scenarioId: scenario.id,
    dataVersion: scenario.meta.dataVersion,
    confidence: confidenceFor(selectedAssignment) as 'low' | 'medium' | 'high',
    warnings,
    assumptions,
    memberAssignments: [],
    firstHalfTeam: {
      id: 'first-half',
      characterIds: selectedAssignment.first.map(({ id }) => String(id)),
      purpose: `固定覆盖 ${input.floor} 层上半${input.chamber ? `第 ${input.chamber} 间` : '全部所选房间'}`,
      rotationNotes: ['根据实战充能调整技能顺序，保留关键技能处理下一波或阶段转场。']
    },
    secondHalfTeam: {
      id: 'second-half',
      characterIds: selectedAssignment.second.map(({ id }) => String(id)),
      purpose: `固定覆盖 ${input.floor} 层下半${input.chamber ? `第 ${input.chamber} 间` : '全部所选房间'}`,
      rotationNotes: ['根据实战充能调整技能顺序，避免在转场前耗尽关键技能。']
    },
    chambers: chambers.map((chamber) => ({
      floor: input.floor,
      chamber: chamber.chamber,
      firstHalf: tacticsForHalf(chamber.firstHalf.waves.flatMap(({ enemies }) => enemies)),
      secondHalf: tacticsForHalf(chamber.secondHalf.waves.flatMap(({ enemies }) => enemies))
    }))
  };

  const validation = validateAbyssPlan({ input, scenario, characters, knowledge, plan });
  if (!validation.ok) return blocked(validation.issues);
  return abyssAdvisorResultSchema.parse({
    status: 'planned',
    source: 'local-rules',
    issues: [],
    warnings,
    assumptions,
    knowledgeSummary: summarizeKnowledgeCoverage(
      [
        ...validation.plan.firstHalfTeam.characterIds,
        ...validation.plan.secondHalfTeam.characterIds
      ],
      knowledge
    ),
    narrative: renderLocalPlanNarrative(validation.plan, input.locale),
    plan: validation.plan
  });
}

function buildPartialPlan({
  input,
  scenario,
  characters,
  knowledge,
  searchStateBudget,
  chambers,
  firstEnemies,
  secondEnemies
}: BuildLocalAbyssPlanOptions & {
  chambers: AbyssScenario['floors'][number]['chambers'];
  firstEnemies: EnemyInstance[];
  secondEnemies: EnemyInstance[];
}): AbyssAdvisorResult {
  const prior = input.priorPlan;
  const recomputeHalf = input.recomputeHalf;
  if (!prior || !recomputeHalf) return blocked([]);
  const preservedTeamKey = recomputeHalf === 'firstHalf' ? 'secondHalfTeam' : 'firstHalfTeam';
  const recomputeTeamKey = recomputeHalf === 'firstHalf' ? 'firstHalfTeam' : 'secondHalfTeam';
  const preservedChamberKey = recomputeHalf === 'firstHalf' ? 'secondHalf' : 'firstHalf';
  const recomputeChamberKey = recomputeHalf === 'firstHalf' ? 'firstHalf' : 'secondHalf';
  if (
    prior.scenarioId !== scenario.id ||
    prior.dataVersion !== scenario.meta.dataVersion ||
    prior.chambers.length !== chambers.length ||
    !chambers.every(({ chamber }) =>
      prior.chambers.some(
        (candidate) => candidate.floor === input.floor && candidate.chamber === chamber
      )
    )
  ) {
    return blocked([
      issue(
        'PRESERVED_HALF_CONFLICT',
        ['priorPlan'],
        '旧方案与当前挑战目标不一致，请改用完整重算。'
      )
    ]);
  }
  const preservedIds = new Set(prior[preservedTeamKey].characterIds);
  const excludedPreserved = input.excludedCharacterIds.filter((id) => preservedIds.has(id));
  if (excludedPreserved.length > 0) {
    return blocked([
      issue(
        'PRESERVED_HALF_CONFLICT',
        ['excludedCharacterIds'],
        '排除角色与需要保留的半场冲突，请改用完整重算。',
        { characterIds: excludedPreserved }
      )
    ]);
  }
  const owned = new Map(characters.map((character) => [String(character.id), character]));
  if (prior[preservedTeamKey].characterIds.some((id) => !owned.has(id))) {
    return blocked([
      issue(
        'PRESERVED_HALF_CONFLICT',
        [preservedTeamKey],
        '需要保留的半场包含当前角色资料中不存在的角色，请改用完整重算。'
      )
    ]);
  }
  const requiredLocks = input.lockedCharacterIds.filter((id) => !preservedIds.has(id));
  if (requiredLocks.length > 4) {
    return blocked([
      issue(
        'PRESERVED_HALF_CONFLICT',
        ['lockedCharacterIds'],
        '保留另一半后，新增锁定角色超过可重算半场的 4 个位置，请改用完整重算。'
      )
    ]);
  }
  const excluded = new Set(input.excludedCharacterIds);
  const available = characters.filter(
    ({ id }) => !preservedIds.has(String(id)) && !excluded.has(String(id))
  );
  if (available.length < 4) {
    return blocked([
      issue('ROSTER_INSUFFICIENT', ['profile', 'characters'], '保留另一半后可重算角色不足 4 名。', {
        required: 4,
        available: available.length,
        missing: 4 - available.length
      })
    ]);
  }
  const enemies = recomputeHalf === 'firstHalf' ? firstEnemies : secondEnemies;
  const poolResult = buildSingleHalfPool(
    available,
    requiredLocks,
    enemies,
    input,
    knowledge,
    normalizeStateBudget(searchStateBudget)
  );
  if (poolResult.status === 'budget-exceeded') {
    return blocked([searchBudgetIssue([recomputeTeamKey])]);
  }
  if (poolResult.status === 'infeasible') {
    return blocked([
      issue(
        'MECHANIC_COVERAGE_INVALID',
        [recomputeTeamKey],
        '在保留另一半的前提下，当前角色与干预条件无法覆盖该半场硬机制。'
      )
    ]);
  }
  const pool = poolResult.value;
  const requiredLockSet = new Set(requiredLocks);
  const candidate = buildTeamCandidates(pool, enemies, input, knowledge).find(({ ids }) =>
    [...requiredLockSet].every((id) => ids.has(id))
  );
  if (!candidate) {
    return blocked([
      issue(
        'MECHANIC_COVERAGE_INVALID',
        [recomputeTeamKey],
        '在保留另一半的前提下，当前角色与干预条件无法覆盖该半场硬机制。'
      )
    ]);
  }
  const recomputedTeam = {
    id: recomputeHalf === 'firstHalf' ? 'first-half' : 'second-half',
    characterIds: candidate.team.map(({ id }) => String(id)),
    purpose: `固定覆盖 ${input.floor} 层${recomputeHalf === 'firstHalf' ? '上半' : '下半'}${input.chamber ? `第 ${input.chamber} 间` : '全部所选房间'}`,
    rotationNotes: ['根据实战充能调整技能顺序，保留关键技能处理下一波或阶段转场。']
  };
  const preservedCharacters = prior[preservedTeamKey].characterIds.flatMap((id) => {
    const character = owned.get(id);
    return character ? [character] : [];
  });
  const assignment: JointAssignment = {
    first: recomputeHalf === 'firstHalf' ? candidate.team : preservedCharacters,
    second: recomputeHalf === 'secondHalf' ? candidate.team : preservedCharacters,
    score: candidate.score
  };
  const warnings = [
    `仅重算${recomputeHalf === 'firstHalf' ? '上半' : '下半'}；另一半队伍与逐间打法保持不变。`,
    ...buildWarnings(assignment, chambers.length)
  ];
  const assumptions = prior.assumptions;
  const plan = {
    ...prior,
    confidence: confidenceFor(assignment),
    warnings,
    assumptions,
    memberAssignments: [],
    [recomputeTeamKey]: recomputedTeam,
    [preservedTeamKey]: prior[preservedTeamKey],
    chambers: chambers.map((chamber) => {
      const preserved = prior.chambers.find(
        (candidate) => candidate.floor === input.floor && candidate.chamber === chamber.chamber
      );
      if (!preserved) throw new Error('validated prior chamber is missing');
      return {
        floor: input.floor,
        chamber: chamber.chamber,
        [recomputeChamberKey]: tacticsForHalf(
          chamber[recomputeChamberKey].waves.flatMap(({ enemies: waveEnemies }) => waveEnemies)
        ),
        [preservedChamberKey]: preserved[preservedChamberKey]
      };
    })
  };
  const validation = validateAbyssPlan({ input, scenario, characters, knowledge, plan });
  if (!validation.ok) return blocked(validation.issues);
  return abyssAdvisorResultSchema.parse({
    status: 'planned',
    source: 'local-rules',
    issues: [],
    warnings,
    assumptions,
    knowledgeSummary: summarizeKnowledgeCoverage(
      [
        ...validation.plan.firstHalfTeam.characterIds,
        ...validation.plan.secondHalfTeam.characterIds
      ],
      knowledge
    ),
    narrative: renderLocalPlanNarrative(validation.plan, input.locale),
    plan: validation.plan
  });
}

function buildSingleHalfPool(
  characters: CharacterProfile[],
  lockedIds: string[],
  enemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput,
  knowledge: CharacterKnowledgeReader | undefined,
  stateBudget: number
): FeasibilityResult<CharacterProfile[]> {
  const byScore = characters
    .slice()
    .sort(
      (left, right) =>
        scoreForHalf(right, enemies, input) - scoreForHalf(left, enemies, input) ||
        left.id - right.id
    );
  const feasibleSeed = findFeasibleTeam(
    characters,
    lockedIds,
    enemies,
    input,
    knowledge,
    stateBudget
  );
  if (feasibleSeed.status !== 'feasible') return feasibleSeed;
  return {
    status: 'feasible',
    value: uniqueCharacters([...feasibleSeed.value, ...byScore]).slice(0, MAX_JOINT_POOL_SIZE)
  };
}

interface JointAssignment {
  first: CharacterProfile[];
  second: CharacterProfile[];
  score: number;
}

function optimizeJointAssignment(
  characters: CharacterProfile[],
  lockedIds: string[],
  firstEnemies: EnemyInstance[],
  secondEnemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput,
  knowledge: CharacterKnowledgeReader | undefined,
  stateBudget: number
): FeasibilityResult<JointAssignment> {
  const locked = new Set(lockedIds);
  const rankedFor = (enemies: EnemyInstance[]) =>
    characters.slice().sort((left, right) => {
      const difference = scoreForHalf(right, enemies, input) - scoreForHalf(left, enemies, input);
      return difference || left.id - right.id;
    });
  const rankedFirst = rankedFor(firstEnemies);
  const rankedSecond = rankedFor(secondEnemies);
  const feasibleSeed = buildMechanicallyFeasibleSeed(
    characters,
    locked,
    firstEnemies,
    secondEnemies,
    input,
    knowledge,
    stateBudget
  );
  if (feasibleSeed.status !== 'feasible') return feasibleSeed;
  const capabilitySpecialists = selectCapabilitySpecialists(
    characters,
    firstEnemies,
    secondEnemies,
    input,
    knowledge
  );
  const pool = uniqueCharacters([
    ...feasibleSeed.value.first,
    ...feasibleSeed.value.second,
    ...capabilitySpecialists
  ]).slice(0, MAX_JOINT_POOL_SIZE);
  for (let index = 0; pool.length < MAX_JOINT_POOL_SIZE; index += 1) {
    const additions = [rankedFirst[index], rankedSecond[index]].filter(
      (character): character is CharacterProfile => character !== undefined
    );
    if (additions.length === 0) break;
    for (const character of additions) {
      if (pool.length >= MAX_JOINT_POOL_SIZE) break;
      if (!pool.some(({ id }) => id === character.id)) pool.push(character);
    }
  }
  const firstCandidates = buildTeamCandidates(pool, firstEnemies, input, knowledge);
  const secondCandidates = buildTeamCandidates(pool, secondEnemies, input, knowledge);
  let best: JointAssignment | undefined;

  for (const firstCandidate of firstCandidates) {
    if (best && firstCandidate.score + (secondCandidates[0]?.score ?? 0) < best.score) break;
    for (const secondCandidate of secondCandidates) {
      const score = firstCandidate.score + secondCandidate.score;
      if (best && score < best.score) break;
      if ([...secondCandidate.ids].some((id) => firstCandidate.ids.has(id))) continue;
      if (![...locked].every((id) => firstCandidate.ids.has(id) || secondCandidate.ids.has(id))) {
        continue;
      }
      const candidate = {
        first: firstCandidate.team,
        second: secondCandidate.team,
        score
      };
      if (
        !best ||
        score > best.score ||
        (score === best.score && assignmentKey(candidate) < assignmentKey(best))
      ) {
        best = candidate;
      }
    }
  }
  return best ? { status: 'feasible', value: best } : { status: 'infeasible' };
}

function selectCapabilitySpecialists(
  characters: CharacterProfile[],
  firstEnemies: EnemyInstance[],
  secondEnemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput,
  knowledge?: CharacterKnowledgeReader
): CharacterProfile[] {
  const selected: CharacterProfile[] = [];
  const selectedByHalf = [new Set<number>(), new Set<number>()];
  const usedByOtherHalf = [new Set<number>(), new Set<number>()];
  [firstEnemies, secondEnemies].forEach((enemies, halfIndex) => {
    const requirements = Array.from(
      new Set(
        enemies.flatMap((enemy) =>
          parseRequiredCapabilities(enemy.mechanics.tags)
            .filter(({ known }) => known)
            .map(({ value }) => value)
        )
      )
    );
    requirements.forEach((requirement) => {
      if (
        selected.some(
          (character) =>
            selectedByHalf[halfIndex]?.has(character.id) &&
            characterSatisfiesRequirement(String(character.id), requirement, knowledge)
        )
      ) {
        return;
      }
      const ranked = characters
        .filter((character) =>
          characterSatisfiesRequirement(String(character.id), requirement, knowledge)
        )
        .sort(
          (left, right) =>
            scoreForHalf(right, enemies, input) - scoreForHalf(left, enemies, input) ||
            left.id - right.id
        );
      const specialist =
        ranked.find((character) => !usedByOtherHalf[halfIndex]?.has(character.id)) ?? ranked[0];
      if (!specialist) return;
      selected.push(specialist);
      selectedByHalf[halfIndex]?.add(specialist.id);
      usedByOtherHalf[halfIndex === 0 ? 1 : 0]?.add(specialist.id);
    });
  });
  return uniqueCharacters(selected);
}

function buildMechanicallyFeasibleSeed(
  characters: CharacterProfile[],
  locked: Set<string>,
  firstEnemies: EnemyInstance[],
  secondEnemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput,
  knowledge: CharacterKnowledgeReader | undefined,
  stateBudget: number
): FeasibilityResult<Pick<JointAssignment, 'first' | 'second'>> {
  return findFeasibleJointSeed(
    characters,
    [...locked],
    firstEnemies,
    secondEnemies,
    input,
    knowledge,
    stateBudget
  );
}

interface HardConstraint {
  key: string;
  matches: (character: CharacterProfile) => boolean;
}

interface SingleSeedState {
  team: CharacterProfile[];
  coverage: bigint;
  locked: bigint;
  score: number;
}

interface JointSeedState {
  first: CharacterProfile[];
  second: CharacterProfile[];
  firstCoverage: bigint;
  secondCoverage: bigint;
  locked: bigint;
  score: number;
}

function findFeasibleTeam(
  characters: CharacterProfile[],
  lockedIds: string[],
  enemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput,
  knowledge: CharacterKnowledgeReader | undefined,
  stateBudget: number
): FeasibilityResult<CharacterProfile[]> {
  const constraints = hardConstraintsFor(enemies, knowledge);
  const coverability = canCoverWithinFour(characters, constraints, stateBudget);
  if (coverability !== 'feasible') return { status: coverability };
  const fullCoverage = fullMask(constraints.length);
  const lockBits = bitIndex(lockedIds);
  const fullLocks = fullMask(lockBits.size);
  let states = new Map<string, SingleSeedState>([
    ['0|0|0', { team: [], coverage: 0n, locked: 0n, score: 0 }]
  ]);
  for (const character of characters.slice().sort((left, right) => left.id - right.id)) {
    const coverage = coverageMask(character, constraints);
    const locked = memberMask(String(character.id), lockBits);
    // A locked character must occupy this team. Dropping the skip branch is both exact and
    // prevents 2^N dead lock states from surviving through large rosters.
    const next = locked === 0n ? new Map(states) : new Map<string, SingleSeedState>();
    for (const state of states.values()) {
      if (state.team.length >= 4) continue;
      const candidate: SingleSeedState = {
        team: [...state.team, character],
        coverage: state.coverage | coverage,
        locked: state.locked | locked,
        score: state.score + scoreForHalf(character, enemies, input)
      };
      keepBestSingle(next, candidate);
      if (next.size > stateBudget) return { status: 'budget-exceeded' };
    }
    states = next;
  }
  const result = states.get(`4|${fullCoverage}|${fullLocks}`);
  if (!result || findAbyssMechanicCoverageGaps(result.team, enemies, knowledge).length > 0) {
    return { status: 'infeasible' };
  }
  return {
    status: 'feasible',
    value: result.team.slice().sort((left, right) => left.id - right.id)
  };
}

function findFeasibleJointSeed(
  characters: CharacterProfile[],
  lockedIds: string[],
  firstEnemies: EnemyInstance[],
  secondEnemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput,
  knowledge: CharacterKnowledgeReader | undefined,
  stateBudget: number
): FeasibilityResult<Pick<JointAssignment, 'first' | 'second'>> {
  const firstConstraints = hardConstraintsFor(firstEnemies, knowledge);
  const secondConstraints = hardConstraintsFor(secondEnemies, knowledge);
  const firstCoverability = canCoverWithinFour(characters, firstConstraints, stateBudget);
  if (firstCoverability !== 'feasible') return { status: firstCoverability };
  const secondCoverability = canCoverWithinFour(characters, secondConstraints, stateBudget);
  if (secondCoverability !== 'feasible') return { status: secondCoverability };
  const fullFirst = fullMask(firstConstraints.length);
  const fullSecond = fullMask(secondConstraints.length);
  const lockBits = bitIndex(lockedIds);
  const fullLocks = fullMask(lockBits.size);
  let states = new Map<string, JointSeedState>([
    [
      '0|0|0|0|0',
      {
        first: [],
        second: [],
        firstCoverage: 0n,
        secondCoverage: 0n,
        locked: 0n,
        score: 0
      }
    ]
  ]);
  for (const character of characters.slice().sort((left, right) => left.id - right.id)) {
    const firstCoverage = coverageMask(character, firstConstraints);
    const secondCoverage = coverageMask(character, secondConstraints);
    const locked = memberMask(String(character.id), lockBits);
    // Locked characters must be assigned to one of the halves; keeping a skip branch would only
    // create states that can never reach fullLocks and makes the search needlessly exponential.
    const next = locked === 0n ? new Map(states) : new Map<string, JointSeedState>();
    for (const state of states.values()) {
      if (state.first.length < 4) {
        keepBestJoint(next, {
          first: [...state.first, character],
          second: state.second,
          firstCoverage: state.firstCoverage | firstCoverage,
          secondCoverage: state.secondCoverage,
          locked: state.locked | locked,
          score: state.score + scoreForHalf(character, firstEnemies, input)
        });
        if (next.size > stateBudget) return { status: 'budget-exceeded' };
      }
      if (state.second.length < 4) {
        keepBestJoint(next, {
          first: state.first,
          second: [...state.second, character],
          firstCoverage: state.firstCoverage,
          secondCoverage: state.secondCoverage | secondCoverage,
          locked: state.locked | locked,
          score: state.score + scoreForHalf(character, secondEnemies, input)
        });
        if (next.size > stateBudget) return { status: 'budget-exceeded' };
      }
    }
    states = next;
  }
  const result = states.get(`4|4|${fullFirst}|${fullSecond}|${fullLocks}`);
  if (
    !result ||
    findAbyssMechanicCoverageGaps(result.first, firstEnemies, knowledge).length > 0 ||
    findAbyssMechanicCoverageGaps(result.second, secondEnemies, knowledge).length > 0
  ) {
    return { status: 'infeasible' };
  }
  return {
    status: 'feasible',
    value: {
      first: result.first.slice().sort((left, right) => left.id - right.id),
      second: result.second.slice().sort((left, right) => left.id - right.id)
    }
  };
}

function hardConstraintsFor(
  enemies: EnemyInstance[],
  knowledge?: CharacterKnowledgeReader
): HardConstraint[] {
  const constraints = new Map<string, HardConstraint>();
  for (const enemy of enemies) {
    for (const shield of enemy.mechanics.shields) {
      const counters = ABYSS_SHIELD_COUNTERS[shield.element] ?? [];
      if (counters.length === 0) continue;
      const key = `shield:${shield.element}`;
      constraints.set(key, {
        key,
        matches: (character) => counters.includes(character.element.toLowerCase())
      });
    }
    const immuneElements = recognizedImmuneElements(enemy.mechanics.immunities);
    if (immuneElements.size > 0) {
      const signature = [...immuneElements].sort().join(',');
      const key = `immunity:${signature}`;
      constraints.set(key, {
        key,
        matches: (character) => {
          const element = character.element.toLowerCase();
          return element in ELEMENTS && !immuneElements.has(element);
        }
      });
    }
    for (const requirement of parseRequiredCapabilities(enemy.mechanics.tags)) {
      const key = `capability:${requirement.value}`;
      constraints.set(key, {
        key,
        matches: (character) =>
          requirement.known &&
          characterSatisfiesRequirement(String(character.id), requirement.value, knowledge)
      });
    }
  }
  return [...constraints.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function recognizedImmuneElements(values: string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (normalized in ELEMENTS) result.add(normalized);
    Object.entries(ELEMENTS).forEach(([element, label]) => {
      if (value.includes(`${label}元素伤害`)) result.add(element);
    });
  }
  return result;
}

function coverageMask(character: CharacterProfile, constraints: HardConstraint[]): bigint {
  return constraints.reduce(
    (mask, constraint, index) =>
      constraint.matches(character) ? mask | (1n << BigInt(index)) : mask,
    0n
  );
}

function canCoverWithinFour(
  characters: CharacterProfile[],
  constraints: HardConstraint[],
  stateBudget: number
): FeasibilityResult<never>['status'] {
  if (constraints.length > MAX_HARD_CONSTRAINT_BITS) return 'budget-exceeded';
  const target = fullMask(constraints.length);
  if (target === 0n) return 'feasible';
  const reachable = Array.from({ length: 5 }, () => new Set<bigint>());
  reachable[0]?.add(0n);
  let stateCount = 1;
  for (const character of characters) {
    const mask = coverageMask(character, constraints);
    for (let count = 4; count >= 1; count -= 1) {
      const previous = reachable[count - 1];
      const current = reachable[count];
      if (!previous || !current) continue;
      for (const coverage of previous) {
        const combined = coverage | mask;
        if (combined === target) return 'feasible';
        if (!current.has(combined)) {
          current.add(combined);
          stateCount += 1;
          if (stateCount > stateBudget) return 'budget-exceeded';
        }
      }
    }
  }
  return 'infeasible';
}

function bitIndex(values: string[]): Map<string, number> {
  return new Map(Array.from(new Set(values)).map((value, index) => [value, index]));
}

function memberMask(value: string, index: Map<string, number>): bigint {
  const bit = index.get(value);
  return bit === undefined ? 0n : 1n << BigInt(bit);
}

function fullMask(size: number): bigint {
  return size === 0 ? 0n : (1n << BigInt(size)) - 1n;
}

function normalizeStateBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FEASIBILITY_STATE_BUDGET;
  return Math.max(1, Math.min(Math.floor(value), DEFAULT_FEASIBILITY_STATE_BUDGET));
}

function searchBudgetIssue(path: Array<string | number>): AbyssPlanIssue {
  return issue(
    'SEARCH_BUDGET_EXCEEDED',
    path,
    '角色组合搜索达到安全上限。请缩小角色池，或锁定关键角色后重试。',
    { stateBudgetExceeded: true }
  );
}

function keepBestSingle(states: Map<string, SingleSeedState>, candidate: SingleSeedState): void {
  const key = `${candidate.team.length}|${candidate.coverage}|${candidate.locked}`;
  const current = states.get(key);
  if (
    !current ||
    candidate.score > current.score ||
    (candidate.score === current.score && teamKey(candidate.team) < teamKey(current.team))
  ) {
    states.set(key, candidate);
  }
}

function keepBestJoint(states: Map<string, JointSeedState>, candidate: JointSeedState): void {
  const key = `${candidate.first.length}|${candidate.second.length}|${candidate.firstCoverage}|${candidate.secondCoverage}|${candidate.locked}`;
  const current = states.get(key);
  if (
    !current ||
    candidate.score > current.score ||
    (candidate.score === current.score && assignmentKey(candidate) < assignmentKey(current))
  ) {
    states.set(key, candidate);
  }
}

function teamKey(team: CharacterProfile[]): string {
  return team
    .map(({ id }) => id)
    .sort((left, right) => left - right)
    .join(',');
}

interface TeamCandidate {
  team: CharacterProfile[];
  ids: Set<string>;
  score: number;
}

function buildTeamCandidates(
  pool: CharacterProfile[],
  enemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput,
  knowledge?: CharacterKnowledgeReader
): TeamCandidate[] {
  return combinations(pool, 4)
    .filter((team) => findAbyssMechanicCoverageGaps(team, enemies, knowledge).length === 0)
    .map((team) => {
      const sorted = team.slice().sort((left, right) => left.id - right.id);
      return {
        team: sorted,
        ids: new Set(sorted.map(({ id }) => String(id))),
        score: sorted.reduce(
          (total, character) => total + scoreForHalf(character, enemies, input),
          0
        )
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.team
          .map(({ id }) => id)
          .join(',')
          .localeCompare(right.team.map(({ id }) => id).join(','))
    );
}

function scoreForHalf(
  character: CharacterProfile,
  enemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput
): number {
  const stats = character.build?.stats;
  const element = character.element.toLowerCase();
  let score =
    (character.level ?? 1) * 4 +
    character.rarity * 20 +
    (character.completeness === 'detailed' ? 35 : character.completeness === 'build' ? 18 : 0) +
    (stats?.energyRecharge ?? 100) * 0.12 +
    (stats?.atk ?? 0) / 80 +
    (stats?.hp ?? 0) / 1800 +
    (stats?.critRate ?? 0) * 0.4 +
    (stats?.critDmg ?? 0) * 0.2 +
    (stats?.elementalMastery ?? 0) / 25;
  if (input.preferences.lowInvestment === 'high') score += (character.level ?? 1) * 1.5;
  if (input.preferences.noBuildChange) score += character.completeness === 'detailed' ? 24 : 0;
  if (input.preferences.comfort === 'high' && (stats?.energyRecharge ?? 0) >= 160) score += 18;
  if (input.preferences.survival === 'high') score += (stats?.hp ?? 0) / 1000;

  for (const enemy of enemies) {
    for (const shield of enemy.mechanics.shields) {
      if (ABYSS_SHIELD_COUNTERS[shield.element]?.includes(element)) score += 95 * enemy.count;
    }
    for (const resistance of enemy.mechanics.resistances) {
      if (resistance.damageType.toLowerCase() === element) score -= resistance.percent * 1.8;
    }
    const localizedElement = ELEMENTS[element];
    if (
      localizedElement &&
      enemy.mechanics.immunities.some(
        (immunity) =>
          immunity.toLowerCase() === element || immunity.includes(`${localizedElement}元素伤害`)
      )
    ) {
      score -= 10_000;
    }
  }
  return score;
}

function tacticsForHalf(enemies: EnemyInstance[]) {
  const tactics: string[] = [];
  enemies.forEach((enemy, index) => {
    const name = enemy.enemy.names['zh-CN'] ?? enemy.enemy.names['zh'] ?? '未命名敌人';
    const prefix = `第 ${index + 1} 波（${name}×${enemy.count}，等级 ${enemy.level}）`;
    const mechanics: string[] = [];
    if (enemy.mechanics.shields.length > 0) {
      mechanics.push(
        `优先处理${enemy.mechanics.shields
          .map(({ element }) => `${abyssElementLabel(element)}元素护盾`)
          .join('、')}`
      );
    }
    if (enemy.mechanics.resistances.length > 0) {
      mechanics.push(
        `留意${enemy.mechanics.resistances
          .map(
            ({ damageType, percent }) =>
              `${localizedMechanicTerm(damageType).replace(/(?:元素)?伤害$/u, '')}抗性 ${percent}%`
          )
          .join('、')}`
      );
    }
    if (enemy.mechanics.immunities.length > 0) {
      mechanics.push(
        `不要依赖其免疫的${enemy.mechanics.immunities.map(localizedMechanicTerm).join('、')}`
      );
    }
    const playerFacingTags = enemy.mechanics.tags.filter((tag) => /[\u3400-\u9fff]/u.test(tag));
    if (playerFacingTags.length > 0) {
      mechanics.push(`机制标签：${playerFacingTags.join('、')}`);
    }
    tactics.push(
      `${prefix}：${mechanics.length > 0 ? mechanics.join('；') : '资料未标注特殊机制，按保守节奏处理'}。`
    );
  });
  return {
    tactics,
    risks: ['本地规则无法确认角色职责与技能覆盖范围，若实战循环不顺应及时调整。'],
    substitutionNotes: ['调整锁定或排除后，需要重新生成完整双队以继续检查跨队冲突。']
  };
}

function validateInputConstraints(
  input: AbyssAdvisorPlanInput,
  characters: CharacterProfile[]
): AbyssPlanIssue[] {
  const issues: AbyssPlanIssue[] = [];
  const owned = new Set(characters.map(({ id }) => String(id)));
  const excluded = new Set(input.excludedCharacterIds);
  if (input.lockedCharacterIds.length > 8) {
    issues.push(
      issue('LOCK_LIMIT_EXCEEDED', ['lockedCharacterIds'], '锁定角色不能超过 8 名。', {
        locked: input.lockedCharacterIds.length,
        maximum: 8
      })
    );
  }
  input.lockedCharacterIds.forEach((id, index) => {
    if (excluded.has(id)) {
      issues.push(
        issue('LOCK_EXCLUDE_CONFLICT', ['lockedCharacterIds', index], '角色不能同时锁定和排除。', {
          characterId: id
        })
      );
    }
    if (!owned.has(id)) {
      issues.push(
        issue(
          'CHARACTER_NOT_OWNED',
          ['lockedCharacterIds', index],
          '锁定角色不在当前角色资料中。',
          {
            characterId: id
          }
        )
      );
    }
  });
  return issues;
}

function buildWarnings(assignment: JointAssignment, chamberCount: number): string[] {
  const incomplete = [...assignment.first, ...assignment.second].filter(
    ({ completeness }) => completeness !== 'detailed'
  ).length;
  return [
    `本地规则已联合检查 ${chamberCount} 个房间的上下半分配。`,
    ...(incomplete > 0 ? [`双队中有 ${incomplete} 名角色的装备资料不完整，建议把握会降低。`] : [])
  ];
}

function confidenceFor(assignment: JointAssignment): 'low' | 'medium' | 'high' {
  const detailed = [...assignment.first, ...assignment.second].filter(
    ({ completeness }) => completeness === 'detailed'
  ).length;
  return detailed >= 8 ? 'high' : detailed >= 4 ? 'medium' : 'low';
}

function combinations<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  const choose = (start: number, selected: T[]): void => {
    if (selected.length === size) {
      result.push(selected.slice());
      return;
    }
    for (let index = start; index <= values.length - (size - selected.length); index += 1) {
      const value = values[index];
      if (value === undefined) continue;
      selected.push(value);
      choose(index + 1, selected);
      selected.pop();
    }
  };
  choose(0, []);
  return result;
}

function assignmentKey(assignment: Pick<JointAssignment, 'first' | 'second'>): string {
  return `${assignment.first.map(({ id }) => id).join(',')}|${assignment.second
    .map(({ id }) => id)
    .join(',')}`;
}

function uniqueCharacters(characters: CharacterProfile[]): CharacterProfile[] {
  const seen = new Set<number>();
  return characters.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function blocked(issues: AbyssPlanIssue[]): AbyssAdvisorResult {
  return abyssAdvisorResultSchema.parse({
    status: 'blocked',
    source: 'local-rules',
    issues,
    warnings: [],
    assumptions: [],
    knowledgeSummary: { trusted: 0, ephemeral: 0, unknown: 0, searched: false }
  });
}

function summarizeKnowledgeCoverage(
  characterIds: string[],
  knowledge: CharacterKnowledgeReader | undefined
) {
  const uniqueIds = [...new Set(characterIds)];
  if (!knowledge) {
    return {
      trusted: 0,
      ephemeral: 0,
      unknown: uniqueIds.length,
      searched: false
    };
  }
  const coverage = knowledge.coverageFor(uniqueIds);
  return {
    trusted: coverage.known,
    ephemeral: 0,
    unknown: coverage.unknownCharacterIds.length,
    searched: false
  };
}

function issue(
  code: AbyssPlanIssue['code'],
  path: Array<string | number>,
  message: string,
  details?: Record<string, unknown>
): AbyssPlanIssue {
  return { code, path, message, ...(details ? { details } : {}) };
}
