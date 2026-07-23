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
  findAbyssMechanicCoverageGaps,
  localizedCapabilityRequirement,
  localizedMechanicTerm,
  parseRequiredCapabilities
} from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
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
  strongEvidenceRatio: 0.7,
  cautiousEvidenceRatio: 0.45,
  suggestedCeilingOrderWhenEvidenceIsWeak: 4
} as const;

const DEFAULT_SEARCH_STATE_BUDGET = 200_000;

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
      ? ['资料或练度证据不足，建议先降一档确认实战余量。']
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
  let states = 0;
  const candidatesByPhase: TeamCandidate[][] = [];
  for (const phase of options.scenario.phases.slice().sort((a, b) => a.phase - b.phase)) {
    const candidates = buildCandidates(
      options.available,
      phase.boss,
      phaseModifiers(options.difficulty, phase),
      options.input,
      options.knowledge,
      () => {
        states += 1;
        return states <= options.budget;
      }
    );
    if (states > options.budget) return { status: 'budget-exceeded' };
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
  let best: { teams: TeamCandidate[]; score: number; key: string } | undefined;

  const visit = (
    phaseIndex: number,
    chosen: TeamCandidate[],
    appearances: Map<string, number>,
    score: number
  ) => {
    states += 1;
    if (states > options.budget) return;
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
      if (states > options.budget) return;
    }
  };
  visit(0, [], new Map(), 0);
  const resolvedBest = best as { teams: TeamCandidate[]; score: number; key: string } | undefined;
  if (resolvedBest) {
    return {
      status: 'planned',
      teams: resolvedBest.teams,
      budgetExhausted: states > options.budget
    };
  }
  return states > options.budget ? { status: 'budget-exceeded' } : { status: 'infeasible' };
}

function phaseModifiers(
  difficulty: StygianScenario['difficulties'][number],
  phase: StygianScenario['phases'][number]
): Array<{ description: string }> {
  return [...difficulty.modifiers, ...phase.phaseModifiers, ...phase.bossModifiers];
}

function buildCandidates(
  characters: CharacterProfile[],
  boss: EnemyInstance,
  modifiers: Array<{ description: string }>,
  input: StygianAdvisorPlanInput,
  knowledge: CharacterKnowledgeReader | undefined,
  consumeState: () => boolean
): TeamCandidate[] {
  const candidates: TeamCandidate[] = [];
  for (let a = 0; a < characters.length - 3; a += 1) {
    for (let b = a + 1; b < characters.length - 2; b += 1) {
      for (let c = b + 1; c < characters.length - 1; c += 1) {
        for (let d = c + 1; d < characters.length; d += 1) {
          if (!consumeState()) return candidates;
          const team = [characters[a]!, characters[b]!, characters[c]!, characters[d]!];
          if (findAbyssMechanicCoverageGaps(team, [boss], knowledge).length > 0) continue;
          const ids = team.map(({ id }) => String(id));
          candidates.push({
            characters: team,
            ids,
            score: team.reduce(
              (total, character) => total + scoreCharacter(character, boss, modifiers, input),
              0
            ),
            key: ids.join(',')
          });
        }
      }
    }
  }
  return candidates.sort(
    (left, right) => right.score - left.score || left.key.localeCompare(right.key)
  );
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
  const modifierText = modifiers.map(({ description }) => description).join(' ');
  if (/(?:能量|充能|energy)/iu.test(modifierText)) {
    score += Math.max(0, (character.build?.stats?.energyRecharge ?? 100) - 100) / 4;
  }
  if (/(?:限时|时间|time)/iu.test(modifierText)) {
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
  const highRequest =
    options.difficultyOrder >= STYGIAN_DIFFICULTY_EVIDENCE_POLICY.highDifficultyStartsAtOrder ||
    options.target === 'dire-challenge';
  const recommendation = !highRequest
    ? ('proceed' as const)
    : ratio < STYGIAN_DIFFICULTY_EVIDENCE_POLICY.cautiousEvidenceRatio
      ? ('lower-difficulty' as const)
      : ratio < STYGIAN_DIFFICULTY_EVIDENCE_POLICY.strongEvidenceRatio
        ? ('proceed-with-caution' as const)
        : ('proceed' as const);
  const suggestedDifficultyId =
    recommendation === 'lower-difficulty'
      ? options.difficultyIdsByOrder[
          Math.min(
            STYGIAN_DIFFICULTY_EVIDENCE_POLICY.suggestedCeilingOrderWhenEvidenceIsWeak,
            options.difficultyIdsByOrder.length
          ) - 1
        ]
      : undefined;
  return {
    recommendation,
    evidence: [
      `练度证据覆盖分 ${points} / ${uniqueSelected.length * 5}（角色等级、资料完整度、武器与天赋是否可见）。`,
      '该评估只表示资料和练度证据是否足以支撑继续冲刺，不是通关阈值或成功承诺。'
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
    ...phase.phaseModifiers.map(({ description }) => description),
    ...phase.bossModifiers.map(({ description }) => description),
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
    ...difficultyModifiers.map(({ description }) => description),
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
  const hasEnergyPressure = difficultyModifiers.some(({ description }) =>
    /(?:能量|充能|energy)/iu.test(description)
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
