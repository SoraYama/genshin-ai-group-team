import type { CharacterProfile } from '../../shared/domain.js';
import {
  stygianAdvisorResultSchema,
  type StygianAdvisorPlanInput,
  type StygianAdvisorResult,
  type StygianPlanIssue,
  type StygianRewardTarget,
  type StygianScenario
} from '../../shared/stygian-advisor.js';
import type { EnemyInstance } from '../../shared/scenario-v2.js';
import {
  ABYSS_SHIELD_COUNTERS,
  characterSatisfiesRequirement,
  findAbyssMechanicCoverageGaps,
  localizedCapabilityRequirement,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import { localizeStygianModifier } from '../../shared/stygian-modifier-localization.js';
import {
  isStygianTargetDifficultyCompatible,
  lowerStygianDifficultyWithinTarget,
  minimumOrderForStygianTarget
} from '../../shared/stygian-reward-policy.js';
import { validateStygianPlan } from './stygian-plan-validator.js';

export interface BuildLocalStygianPlanOptions {
  input: StygianAdvisorPlanInput;
  scenario: StygianScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  searchStateBudget?: number;
}

export const STYGIAN_DIFFICULTY_EVIDENCE_POLICY = {
  highDifficultyStartsAtOrder: 5,
  thresholdsByTarget: {
    primogems: { cautiousEvidenceRatio: 0.45, strongEvidenceRatio: 0.7 },
    'high-reward': { cautiousEvidenceRatio: 0.65, strongEvidenceRatio: 0.82 },
    'dire-challenge': { cautiousEvidenceRatio: 0.7, strongEvidenceRatio: 0.9 }
  }
} as const;

const DEFAULT_SEARCH_STATE_BUDGET = 500_000;
const MAX_STYGIAN_POOL_SIZE = 20;
const MAX_PHASE_CANDIDATES = 256;
const MAX_HARD_CONSTRAINT_BITS = 64;

interface TeamCandidate {
  characters: CharacterProfile[];
  ids: string[];
  score: number;
  key: string;
}

type SearchResult =
  | { status: 'planned'; teams: TeamCandidate[]; budgetExhausted: boolean }
  | { status: 'infeasible' }
  | { status: 'budget-exceeded' };

type FeasibilityResult<T> =
  | { status: 'feasible'; value: T }
  | { status: 'infeasible' }
  | { status: 'budget-exceeded' };

interface SearchBudget {
  readonly limit: number;
  used: number;
  consume(): boolean;
}

interface HardConstraint {
  key: string;
  matches: (character: CharacterProfile) => boolean;
}

interface ThreePhaseSeedState {
  teams: [CharacterProfile[], CharacterProfile[], CharacterProfile[]];
  coverage: [bigint, bigint, bigint];
  lockedSelected: number;
  score: number;
}

export function buildLocalStygianPlan({
  input,
  scenario,
  characters,
  knowledge,
  searchStateBudget
}: BuildLocalStygianPlanOptions): StygianAdvisorResult {
  const difficulty = scenario.difficulties.find(({ id }) => id === input.difficultyId);
  if (!difficulty) {
    return blocked([issue('DIFFICULTY_NOT_FOUND', ['difficultyId'], '所选难度不在当前资料中。')]);
  }
  if (!isStygianTargetDifficultyCompatible(input.target, difficulty.order)) {
    return blocked([
      issue(
        'TARGET_DIFFICULTY_CONFLICT',
        ['target'],
        '所选难度低于当前应用内目标档位，请提高难度或降低奖励目标。',
        {
          target: input.target,
          difficultyOrder: difficulty.order,
          policy: 'app-target-orders-v1'
        }
      )
    ]);
  }
  if (input.phase !== undefined && !scenario.phases.some(({ phase }) => phase === input.phase)) {
    return blocked([issue('PHASE_NOT_FOUND', ['phase'], '所选阶段不在当前资料中。')]);
  }
  const excluded = new Set(input.excludedCharacterIds);
  const ownedIds = new Set(characters.map(({ id }) => String(id)));
  if (input.lockedCharacterIds.length > 12) {
    return blocked([
      issue('LOCK_LIMIT_EXCEEDED', ['lockedCharacterIds'], '锁定角色超过三队总位置数。', {
        maximum: 12,
        actual: input.lockedCharacterIds.length
      })
    ]);
  }
  const overlappingLocks = input.lockedCharacterIds.filter((id) => excluded.has(id));
  if (overlappingLocks.length > 0) {
    return blocked([
      issue('LOCK_EXCLUDE_CONFLICT', ['lockedCharacterIds'], '同一角色不能同时锁定和排除。', {
        characterIds: overlappingLocks
      })
    ]);
  }
  const unownedLocks = input.lockedCharacterIds.filter((id) => !ownedIds.has(id));
  if (unownedLocks.length > 0) {
    return blocked([
      issue('CHARACTER_NOT_OWNED', ['lockedCharacterIds'], '锁定角色不在当前角色资料中。', {
        characterIds: unownedLocks
      })
    ]);
  }
  const available = characters.filter(({ id }) => !excluded.has(String(id)));
  const minimumUnique = minimumUniqueCharacters(scenario.crossPartyReusePolicy);
  if (available.length < minimumUnique) {
    return blocked([
      issue(
        'ROSTER_INSUFFICIENT',
        ['profile', 'characters'],
        '在当期跨队规则下，可用角色数不足以组成三队。',
        {
          required: minimumUnique,
          available: available.length,
          missing: minimumUnique - available.length
        }
      )
    ]);
  }
  const budget = Math.max(1, Math.min(searchStateBudget ?? DEFAULT_SEARCH_STATE_BUDGET, 1_000_000));
  const search = searchJointTeams({
    available,
    scenario,
    difficulty,
    input,
    knowledge,
    budget
  });
  if (search.status === 'budget-exceeded') {
    return blocked([
      issue(
        'SEARCH_BUDGET_EXCEEDED',
        ['phases'],
        '本地联合搜索已达到本次上限；这不代表当前角色一定无解。',
        { stateBudget: budget }
      )
    ]);
  }
  if (search.status === 'infeasible') {
    return blocked([
      issue(
        'MECHANIC_COVERAGE_INVALID',
        ['phases'],
        '当前角色、干预与跨队规则无法同时覆盖三个阶段的硬机制。'
      )
    ]);
  }

  const selectedCharacters = uniqueCharacters(search.teams.flatMap(({ characters: team }) => team));
  const assessment = assessStygianDifficultyEvidence({
    difficultyOrder: difficulty.order,
    target: input.target,
    difficultyIdsByOrder: scenario.difficulties
      .slice()
      .sort((left, right) => left.order - right.order)
      .map(({ id }) => id),
    selectedCharacters
  });
  const warnings = [
    ...(assessment.recommendation === 'lower-difficulty'
      ? assessment.suggestedDifficultyId
        ? ['资料或练度证据不足，建议先改选目标允许范围内的较低难度确认实战余量。']
        : ['资料或练度证据不足，当前已在目标最低档；如需降低难度，请先降低奖励目标。']
      : assessment.recommendation === 'proceed-with-caution'
        ? ['高难度仅建议谨慎尝试；当前资料不足以判定能否通过。']
        : []),
    ...(difficulty.modifiers.length === 0
      ? ['该难度资料未标注额外修正，不据此推断时间或能量阈值。']
      : []),
    ...(search.budgetExhausted
      ? ['联合搜索已达到本次上限；当前返回预算内评分最高的已校验方案，不声称是全局唯一最优。']
      : [])
  ];
  const assumptions = [
    '本地规则只使用已知的角色元素、等级、资料完整度、面板和首领机制。',
    '未知角色能力不会被当作硬机制解法，实战上限不做通关承诺。'
  ];
  const plan = {
    mode: 'stygian-onslaught' as const,
    schemaVersion: 2 as const,
    scenarioId: scenario.id,
    dataVersion: scenario.meta.dataVersion,
    confidence:
      assessment.recommendation === 'proceed'
        ? ('high' as const)
        : assessment.recommendation === 'proceed-with-caution'
          ? ('medium' as const)
          : ('low' as const),
    warnings,
    assumptions,
    reusePolicyAcknowledgement: scenario.crossPartyReusePolicy.rule,
    phases: scenario.phases
      .slice()
      .sort((left, right) => left.phase - right.phase)
      .map((phase, index) => ({
        phase: phase.phase,
        team: {
          id: `phase-${phase.phase}`,
          characterIds: search.teams[index]!.ids,
          purpose: `处理第 ${phase.phase} 阶段的${displayEnemyName(phase.boss)}与已标注机制。`,
          rotationNotes: [
            rotationFor(search.teams[index]!.characters, phaseModifiers(difficulty, phase))
          ]
        }
      }))
  };
  const validation = validateStygianPlan({ input, scenario, characters, knowledge, plan });
  if (!validation.ok) return blocked(validation.issues);
  const phaseGuidance = scenario.phases
    .slice()
    .sort((left, right) => left.phase - right.phase)
    .map((phase) => ({
      phase: phase.phase,
      mechanismBasis: mechanismBasisFor(phase),
      risks: riskNotesFor(phase, difficulty.modifiers)
    }));
  return stygianAdvisorResultSchema.parse({
    status: 'planned',
    source: 'local-rules',
    issues: [],
    warnings,
    assumptions,
    plan: validation.plan,
    phaseGuidance,
    difficultyAssessment: assessment
  });
}

function searchJointTeams(options: {
  available: CharacterProfile[];
  scenario: StygianScenario;
  difficulty: StygianScenario['difficulties'][number];
  input: StygianAdvisorPlanInput;
  knowledge?: CharacterKnowledgeReader;
  budget: number;
}): SearchResult {
  const budget = createSearchBudget(options.budget);
  const phases = options.scenario.phases.slice().sort((a, b) => a.phase - b.phase);
  const seed = findFeasibleThreePhaseSeed({
    available: options.available,
    phases,
    difficulty: options.difficulty,
    input: options.input,
    knowledge: options.knowledge,
    policy: options.scenario.crossPartyReusePolicy,
    budget
  });
  if (seed.status !== 'feasible') return { status: seed.status };

  const pool = buildBoundedJointPool({
    available: options.available,
    phases,
    difficulty: options.difficulty,
    input: options.input,
    knowledge: options.knowledge,
    seed: seed.value
  });
  const candidatesByPhase: TeamCandidate[][] = [];
  for (const [phaseIndex, phase] of phases.entries()) {
    const candidates = buildCandidates(
      pool,
      phase.boss,
      phaseModifiers(options.difficulty, phase),
      options.input,
      options.knowledge,
      budget,
      seed.value[phaseIndex] ?? []
    );
    if (candidates.length === 0) return { status: 'infeasible' };
    candidatesByPhase.push(candidates);
  }

  const maximum =
    options.scenario.crossPartyReusePolicy.rule === 'forbidden'
      ? 1
      : options.scenario.crossPartyReusePolicy.rule === 'limited'
        ? options.scenario.crossPartyReusePolicy.maxPartyAppearancesPerCharacter
        : 3;
  const locked = new Set(options.input.lockedCharacterIds);
  const seedCandidates = candidatesByPhase.map((candidates, index) => {
    const key = seed.value[index]!.map(({ id }) => id)
      .sort((left, right) => left - right)
      .join(',');
    return candidates.find((candidate) => candidate.key === key)!;
  });
  let best: { teams: TeamCandidate[]; score: number; key: string } | undefined = {
    teams: seedCandidates,
    score: seedCandidates.reduce((total, candidate) => total + candidate.score, 0),
    key: seedCandidates.map(({ key }) => key).join('|')
  };

  const visit = (
    phaseIndex: number,
    chosen: TeamCandidate[],
    appearances: Map<string, number>,
    score: number
  ) => {
    if (!budget.consume()) return;
    const optimisticScore =
      score +
      candidatesByPhase
        .slice(phaseIndex)
        .reduce(
          (total, candidates) =>
            total +
            (candidates.find(({ ids }) => ids.every((id) => (appearances.get(id) ?? 0) < maximum))
              ?.score ?? Number.NEGATIVE_INFINITY),
          0
        );
    if (best && optimisticScore <= best.score) return;
    if (phaseIndex === 3) {
      const selected = new Set(chosen.flatMap(({ ids }) => ids));
      if ([...locked].some((id) => !selected.has(id))) return;
      const key = chosen.map(({ key: candidateKey }) => candidateKey).join('|');
      if (!best || score > best.score || (score === best.score && key < best.key)) {
        best = { teams: chosen.slice(), score, key };
      }
      return;
    }
    for (const candidate of candidatesByPhase[phaseIndex] ?? []) {
      if (candidate.ids.some((id) => (appearances.get(id) ?? 0) >= maximum)) continue;
      const next = new Map(appearances);
      candidate.ids.forEach((id) => next.set(id, (next.get(id) ?? 0) + 1));
      visit(phaseIndex + 1, [...chosen, candidate], next, score + candidate.score);
      if (budget.used >= budget.limit) return;
    }
  };
  visit(0, [], new Map(), 0);
  const resolvedBest = best as { teams: TeamCandidate[]; score: number; key: string } | undefined;
  if (resolvedBest) {
    return {
      status: 'planned',
      teams: resolvedBest.teams,
      budgetExhausted: budget.used >= budget.limit
    };
  }
  return budget.used >= budget.limit ? { status: 'budget-exceeded' } : { status: 'infeasible' };
}

function createSearchBudget(limit: number): SearchBudget {
  return {
    limit,
    used: 0,
    consume() {
      this.used += 1;
      return this.used <= this.limit;
    }
  };
}

function findFeasibleThreePhaseSeed(options: {
  available: CharacterProfile[];
  phases: StygianScenario['phases'];
  difficulty: StygianScenario['difficulties'][number];
  input: StygianAdvisorPlanInput;
  knowledge?: CharacterKnowledgeReader;
  policy: StygianScenario['crossPartyReusePolicy'];
  budget: SearchBudget;
}): FeasibilityResult<[CharacterProfile[], CharacterProfile[], CharacterProfile[]]> {
  const constraints = options.phases.map(({ boss }) => hardConstraintsFor(boss, options.knowledge));
  if (constraints.some((items) => items.length > MAX_HARD_CONSTRAINT_BITS)) {
    return { status: 'budget-exceeded' };
  }
  const requiredCoverage = constraints.map((items) => fullMask(items.length)) as [
    bigint,
    bigint,
    bigint
  ];
  const locked = new Set(options.input.lockedCharacterIds);
  const maximumAppearances = maximumAppearancesFor(options.policy);
  let states = new Map<string, ThreePhaseSeedState>([
    [
      '0|0|0|0|0|0|0',
      {
        teams: [[], [], []],
        coverage: [0n, 0n, 0n],
        lockedSelected: 0,
        score: 0
      }
    ]
  ]);

  for (const character of options.available.slice().sort((left, right) => left.id - right.id)) {
    const isLocked = locked.has(String(character.id));
    const placements = phasePlacements(maximumAppearances, !isLocked);
    const next = new Map<string, ThreePhaseSeedState>();
    const characterCoverage = constraints.map((items) => coverageMask(character, items)) as [
      bigint,
      bigint,
      bigint
    ];
    for (const state of states.values()) {
      for (const placement of placements) {
        if (!options.budget.consume()) return { status: 'budget-exceeded' };
        if (placement.some((phaseIndex) => state.teams[phaseIndex].length >= 4)) continue;
        const teams = state.teams.map((team) => team.slice()) as ThreePhaseSeedState['teams'];
        const coverage = state.coverage.slice() as ThreePhaseSeedState['coverage'];
        let score = state.score;
        placement.forEach((phaseIndex) => {
          teams[phaseIndex].push(character);
          coverage[phaseIndex] |= characterCoverage[phaseIndex];
          const phase = options.phases[phaseIndex];
          if (phase) {
            score += scoreCharacter(
              character,
              phase.boss,
              phaseModifiers(options.difficulty, phase),
              options.input
            );
          }
        });
        keepBestSeed(next, {
          teams,
          coverage,
          lockedSelected: state.lockedSelected + (isLocked ? 1 : 0),
          score
        });
      }
    }
    states = next;
    if (states.size === 0) return { status: 'infeasible' };
  }

  const result = states.get(
    `4|4|4|${requiredCoverage[0]}|${requiredCoverage[1]}|${requiredCoverage[2]}|${locked.size}`
  );
  if (!result) return { status: 'infeasible' };
  const hasGap = result.teams.some(
    (team, index) =>
      findAbyssMechanicCoverageGaps(team, [options.phases[index]!.boss], options.knowledge).length >
      0
  );
  if (hasGap) return { status: 'infeasible' };
  return {
    status: 'feasible',
    value: result.teams.map((team) => team.slice().sort((left, right) => left.id - right.id)) as [
      CharacterProfile[],
      CharacterProfile[],
      CharacterProfile[]
    ]
  };
}

function buildBoundedJointPool(options: {
  available: CharacterProfile[];
  phases: StygianScenario['phases'];
  difficulty: StygianScenario['difficulties'][number];
  input: StygianAdvisorPlanInput;
  knowledge?: CharacterKnowledgeReader;
  seed: [CharacterProfile[], CharacterProfile[], CharacterProfile[]];
}): CharacterProfile[] {
  const pool = uniqueCharacters(options.seed.flatMap((team) => team));
  const specialists = options.phases.flatMap((phase) =>
    hardConstraintsFor(phase.boss, options.knowledge).flatMap((constraint) => {
      const specialist = options.available
        .filter(constraint.matches)
        .sort(
          (left, right) =>
            scoreCharacter(
              right,
              phase.boss,
              phaseModifiers(options.difficulty, phase),
              options.input
            ) -
              scoreCharacter(
                left,
                phase.boss,
                phaseModifiers(options.difficulty, phase),
                options.input
              ) || left.id - right.id
        )[0];
      return specialist ? [specialist] : [];
    })
  );
  appendUnique(pool, specialists, MAX_STYGIAN_POOL_SIZE);
  const rankedByPhase = options.phases.map((phase) =>
    options.available
      .slice()
      .sort(
        (left, right) =>
          scoreCharacter(
            right,
            phase.boss,
            phaseModifiers(options.difficulty, phase),
            options.input
          ) -
            scoreCharacter(
              left,
              phase.boss,
              phaseModifiers(options.difficulty, phase),
              options.input
            ) || left.id - right.id
      )
  );
  for (let rank = 0; pool.length < MAX_STYGIAN_POOL_SIZE; rank += 1) {
    const additions = rankedByPhase.flatMap((characters) => characters[rank] ?? []);
    if (additions.length === 0) break;
    appendUnique(pool, additions, MAX_STYGIAN_POOL_SIZE);
  }
  return pool;
}

function appendUnique(
  target: CharacterProfile[],
  additions: CharacterProfile[],
  maximum: number
): void {
  const ids = new Set(target.map(({ id }) => id));
  for (const character of additions) {
    if (target.length >= maximum) return;
    if (ids.has(character.id)) continue;
    target.push(character);
    ids.add(character.id);
  }
}

function maximumAppearancesFor(policy: StygianScenario['crossPartyReusePolicy']): number {
  if (policy.rule === 'forbidden') return 1;
  if (policy.rule === 'limited') return policy.maxPartyAppearancesPerCharacter;
  return 3;
}

function phasePlacements(
  maximumAppearances: number,
  includeEmpty: boolean
): Array<Array<0 | 1 | 2>> {
  const placements: Array<Array<0 | 1 | 2>> = includeEmpty ? [[]] : [];
  for (let mask = 1; mask < 8; mask += 1) {
    const phases = ([0, 1, 2] as const).filter((index) => (mask & (1 << index)) !== 0);
    if (phases.length <= maximumAppearances) placements.push(phases);
  }
  return placements;
}

function keepBestSeed(
  states: Map<string, ThreePhaseSeedState>,
  candidate: ThreePhaseSeedState
): void {
  const key = seedStateKey(candidate);
  const current = states.get(key);
  if (
    !current ||
    candidate.score > current.score ||
    (candidate.score === current.score &&
      seedTeamsKey(candidate.teams) < seedTeamsKey(current.teams))
  ) {
    states.set(key, candidate);
  }
}

function seedStateKey(state: ThreePhaseSeedState): string {
  return `${state.teams[0].length}|${state.teams[1].length}|${state.teams[2].length}|${state.coverage[0]}|${state.coverage[1]}|${state.coverage[2]}|${state.lockedSelected}`;
}

function seedTeamsKey(teams: ThreePhaseSeedState['teams']): string {
  return teams
    .map((team) =>
      team
        .map(({ id }) => id)
        .sort((left, right) => left - right)
        .join(',')
    )
    .join('|');
}

function phaseModifiers(
  difficulty: StygianScenario['difficulties'][number],
  phase: StygianScenario['phases'][number]
): Array<{ id: string; description: string }> {
  return [...difficulty.modifiers, ...phase.phaseModifiers, ...phase.bossModifiers];
}

function buildCandidates(
  characters: CharacterProfile[],
  boss: EnemyInstance,
  modifiers: Array<{ description: string }>,
  input: StygianAdvisorPlanInput,
  knowledge: CharacterKnowledgeReader | undefined,
  budget: SearchBudget,
  feasibleSeed: CharacterProfile[]
): TeamCandidate[] {
  const seedCandidate = teamCandidate(feasibleSeed, boss, modifiers, input);
  const candidates: TeamCandidate[] = [seedCandidate];
  const seedKey = seedCandidate.key;
  for (let a = 0; a < characters.length - 3; a += 1) {
    for (let b = a + 1; b < characters.length - 2; b += 1) {
      for (let c = b + 1; c < characters.length - 1; c += 1) {
        for (let d = c + 1; d < characters.length; d += 1) {
          if (!budget.consume()) return limitPhaseCandidates(candidates, seedKey);
          const team = [characters[a]!, characters[b]!, characters[c]!, characters[d]!];
          if (findAbyssMechanicCoverageGaps(team, [boss], knowledge).length > 0) continue;
          const candidate = teamCandidate(team, boss, modifiers, input);
          if (candidate.key !== seedKey) candidates.push(candidate);
        }
      }
    }
  }
  return limitPhaseCandidates(candidates, seedKey);
}

function teamCandidate(
  team: CharacterProfile[],
  boss: EnemyInstance,
  modifiers: Array<{ description: string }>,
  input: StygianAdvisorPlanInput
): TeamCandidate {
  const characters = team.slice().sort((left, right) => left.id - right.id);
  const ids = characters.map(({ id }) => String(id));
  return {
    characters,
    ids,
    score: characters.reduce(
      (total, character) => total + scoreCharacter(character, boss, modifiers, input),
      0
    ),
    key: ids.join(',')
  };
}

function limitPhaseCandidates(candidates: TeamCandidate[], seedKey: string): TeamCandidate[] {
  const sorted = candidates.sort(
    (left, right) => right.score - left.score || left.key.localeCompare(right.key)
  );
  const limited = sorted.slice(0, MAX_PHASE_CANDIDATES);
  const seed = sorted.find(({ key }) => key === seedKey);
  if (seed && !limited.some(({ key }) => key === seedKey)) {
    limited[limited.length - 1] = seed;
    limited.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  }
  return limited;
}

function hardConstraintsFor(
  boss: EnemyInstance,
  knowledge?: CharacterKnowledgeReader
): HardConstraint[] {
  const constraints = new Map<string, HardConstraint>();
  for (const shield of boss.mechanics.shields) {
    const counters = ABYSS_SHIELD_COUNTERS[shield.element] ?? [];
    if (counters.length === 0) continue;
    const key = `shield:${shield.element}`;
    constraints.set(key, {
      key,
      matches: (character) => counters.includes(character.element.toLowerCase())
    });
  }
  const immuneElements = recognizedImmuneElements(boss.mechanics.immunities);
  if (immuneElements.size > 0) {
    const key = `immunity:${[...immuneElements].sort().join(',')}`;
    constraints.set(key, {
      key,
      matches: (character) => !immuneElements.has(character.element.toLowerCase())
    });
  }
  for (const requirement of parseRequiredCapabilities(boss.mechanics.tags)) {
    const key = `capability:${requirement.value}`;
    constraints.set(key, {
      key,
      matches: (character) =>
        requirement.known &&
        characterSatisfiesRequirement(String(character.id), requirement.value, knowledge)
    });
  }
  return [...constraints.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function recognizedImmuneElements(values: string[]): Set<string> {
  const known = new Set(['pyro', 'hydro', 'anemo', 'geo', 'electro', 'dendro', 'cryo']);
  const localized: Record<string, string> = {
    pyro: '火',
    hydro: '水',
    anemo: '风',
    geo: '岩',
    electro: '雷',
    dendro: '草',
    cryo: '冰'
  };
  const result = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (known.has(normalized)) result.add(normalized);
    Object.entries(localized).forEach(([element, label]) => {
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

function fullMask(size: number): bigint {
  return size === 0 ? 0n : (1n << BigInt(size)) - 1n;
}

function scoreCharacter(
  character: CharacterProfile,
  boss: EnemyInstance,
  modifiers: Array<{ description: string }>,
  input: StygianAdvisorPlanInput
): number {
  let score = character.level ?? 0;
  score += character.completeness === 'detailed' ? 28 : character.completeness === 'build' ? 16 : 4;
  score += Math.min(character.build?.stats?.energyRecharge ?? 100, 220) / 10;
  if (input.preferences.lowInvestment === 'high' && character.rarity === 4) score += 8;
  if (input.preferences.survival === 'high' && (character.build?.stats?.hp ?? 0) >= 20_000)
    score += 6;
  const element = character.element.toLowerCase();
  for (const shield of boss.mechanics.shields) {
    if ((ABYSS_SHIELD_COUNTERS[shield.element] ?? []).includes(element)) score += 80;
  }
  for (const resistance of boss.mechanics.resistances) {
    if (resistance.damageType === element) score -= resistance.percent;
  }
  const localizedModifierText = modifiers.map(localizeStygianModifier).join(' ');
  if (/(?:能量|充能)/u.test(localizedModifierText)) {
    score += Math.max(0, (character.build?.stats?.energyRecharge ?? 100) - 100) / 4;
  }
  if (/(?:限时|时间)/u.test(localizedModifierText)) {
    score += character.completeness === 'detailed' ? 12 : 0;
  }
  return score;
}

export function assessStygianDifficultyEvidence(options: {
  difficultyOrder: number;
  target: StygianRewardTarget;
  difficultyIdsByOrder: string[];
  selectedCharacters: CharacterProfile[];
}) {
  const uniqueSelected = uniqueCharacters(options.selectedCharacters);
  const points = uniqueSelected.reduce((total, character) => {
    return (
      total +
      (character.completeness === 'detailed' ? 2 : character.completeness === 'build' ? 1 : 0) +
      ((character.level ?? 0) >= 90 ? 1 : 0) +
      (character.build?.weapon ? 1 : 0) +
      (character.build?.talents ? 1 : 0)
    );
  }, 0);
  const ratio = uniqueSelected.length === 0 ? 0 : points / (uniqueSelected.length * 5);
  const thresholds = STYGIAN_DIFFICULTY_EVIDENCE_POLICY.thresholdsByTarget[options.target];
  const highRequest =
    options.difficultyOrder >= STYGIAN_DIFFICULTY_EVIDENCE_POLICY.highDifficultyStartsAtOrder ||
    options.target !== 'primogems';
  const recommendation = !highRequest
    ? ('proceed' as const)
    : ratio < thresholds.cautiousEvidenceRatio
      ? ('lower-difficulty' as const)
      : ratio < thresholds.strongEvidenceRatio
        ? ('proceed-with-caution' as const)
        : ('proceed' as const);
  const suggestedDifficultyId =
    recommendation === 'lower-difficulty'
      ? lowerStygianDifficultyWithinTarget(
          options.target,
          options.difficultyOrder,
          options.difficultyIdsByOrder.map((id, index) => ({ id, order: index + 1 }))
        )
      : undefined;
  const atTargetMinimum =
    recommendation === 'lower-difficulty' &&
    options.difficultyOrder === minimumOrderForStygianTarget(options.target);
  return {
    recommendation,
    evidence: [
      `练度证据覆盖分 ${points} / ${uniqueSelected.length * 5}（角色等级、资料完整度、武器与天赋是否可见）。`,
      '目标档位来自应用内规划策略，不代表官方奖励解锁条件。该评估不是通关阈值或成功承诺。',
      ...(atTargetMinimum
        ? ['当前已在该奖励目标的应用内最低档；如需继续降难度，请先降低奖励目标。']
        : [])
    ],
    ...(suggestedDifficultyId ? { suggestedDifficultyId } : {})
  };
}

function minimumUniqueCharacters(policy: StygianScenario['crossPartyReusePolicy']): number {
  if (policy.rule === 'forbidden') return 12;
  if (policy.rule === 'allowed') return 4;
  return Math.ceil(12 / policy.maxPartyAppearancesPerCharacter);
}

function mechanismBasisFor(phase: StygianScenario['phases'][number]): string[] {
  const mechanics = [
    ...phase.phaseModifiers.map(localizeStygianModifier),
    ...phase.bossModifiers.map(localizeStygianModifier),
    ...phase.boss.mechanics.shields.map(({ element }) => `需处理${localizedMechanicTerm(element)}`),
    ...phase.boss.mechanics.immunities.map(
      (value) => `需避开免疫：${localizedMechanicTerm(value)}`
    ),
    ...parseRequiredCapabilities(phase.boss.mechanics.tags).map(
      (requirement) => `需满足硬机制：${localizedCapabilityRequirement(requirement)}`
    ),
    ...phase.boss.mechanics.tags.filter((tag) => /[\u3400-\u9fff]/u.test(tag))
  ];
  return mechanics.length > 0 ? mechanics : ['资料未标注额外首领机制。'];
}

function riskNotesFor(
  phase: StygianScenario['phases'][number],
  difficultyModifiers: Array<{ description: string }>
): string[] {
  const notes = [
    ...difficultyModifiers.map(localizeStygianModifier),
    ...phase.boss.mechanics.resistances.map(
      ({ damageType, percent }) => `${localizedMechanicTerm(damageType)}抗性 ${percent}%`
    )
  ];
  return notes.length > 0 ? notes : ['资料未标注时间、能量或其他额外风险；不做数值推断。'];
}

function rotationFor(
  team: CharacterProfile[],
  difficultyModifiers: Array<{ description: string }>
): string {
  const hasEnergyPressure = difficultyModifiers.some((modifier) =>
    /(?:能量|充能)/u.test(localizeStygianModifier(modifier))
  );
  const bestEnergy = team
    .slice()
    .sort(
      (left, right) =>
        (right.build?.stats?.energyRecharge ?? 0) - (left.build?.stats?.energyRecharge ?? 0) ||
        left.id - right.id
    )[0];
  return hasEnergyPressure && bestEnergy
    ? `开局先用${bestEnergy.name}完成能量铺垫，再进入主要输出窗口；具体技能顺序需按实战充能调整。`
    : '开局先布置已知的辅助手段，再进入输出窗口；未知角色技能顺序不作推测。';
}

function displayEnemyName(enemy: EnemyInstance): string {
  return enemy.enemy.names['zh-CN'] ?? enemy.enemy.names['zh-Hans'] ?? '未命名首领';
}

function uniqueCharacters(characters: CharacterProfile[]): CharacterProfile[] {
  return Array.from(new Map(characters.map((character) => [character.id, character])).values());
}

function blocked(issues: StygianPlanIssue[]): StygianAdvisorResult {
  return stygianAdvisorResultSchema.parse({
    status: 'blocked',
    source: 'local-rules',
    issues,
    warnings: [],
    assumptions: []
  });
}

function issue(
  code: StygianPlanIssue['code'],
  path: Array<string | number>,
  message: string,
  details?: Record<string, unknown>
): StygianPlanIssue {
  return { code, path, message, ...(details ? { details } : {}) };
}
