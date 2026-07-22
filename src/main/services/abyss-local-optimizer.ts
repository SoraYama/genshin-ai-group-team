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
  localizedMechanicTerm
} from '../../shared/abyss-mechanics.js';
import { validateAbyssPlan } from './abyss-plan-validator.js';

export interface BuildLocalAbyssPlanOptions {
  input: AbyssAdvisorPlanInput;
  scenario: AbyssScenario;
  characters: CharacterProfile[];
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

export function buildLocalAbyssPlan({
  input,
  scenario,
  characters
}: BuildLocalAbyssPlanOptions): AbyssAdvisorResult {
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
  const assignment = optimizeJointAssignment(
    available,
    input.lockedCharacterIds,
    firstEnemies,
    secondEnemies,
    input
  );
  if (!assignment) {
    return blocked([
      issue(
        'MECHANIC_COVERAGE_INVALID',
        ['teams'],
        '当前角色与干预条件无法组成同时覆盖上下半硬机制的两支队伍。'
      )
    ]);
  }

  const warnings = buildWarnings(assignment, chambers.length);
  const assumptions = [
    '本地规则只使用已知的元素、等级、资料完整度、充能与敌人机制；未知角色职责没有被当作确定事实。',
    '角色职责、技能范围和实战操作未进入本地知识时，打法采用保守描述。'
  ];
  const plan = {
    mode: 'spiral-abyss' as const,
    schemaVersion: 2 as const,
    scenarioId: scenario.id,
    dataVersion: scenario.meta.dataVersion,
    confidence: confidenceFor(assignment) as 'low' | 'medium' | 'high',
    warnings,
    assumptions,
    firstHalfTeam: {
      id: 'first-half',
      characterIds: assignment.first.map(({ id }) => String(id)),
      purpose: `固定覆盖 ${input.floor} 层上半${input.chamber ? `第 ${input.chamber} 间` : '全部所选房间'}`,
      rotationNotes: ['根据实战充能调整技能顺序，保留关键技能处理下一波或阶段转场。']
    },
    secondHalfTeam: {
      id: 'second-half',
      characterIds: assignment.second.map(({ id }) => String(id)),
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

  const validation = validateAbyssPlan({ input, scenario, characters, plan });
  if (!validation.ok) return blocked(validation.issues);
  return abyssAdvisorResultSchema.parse({
    status: 'planned',
    source: 'local-rules',
    issues: [],
    warnings,
    assumptions,
    plan: validation.plan
  });
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
  input: AbyssAdvisorPlanInput
): JointAssignment | undefined {
  const locked = new Set(lockedIds);
  const rankedFor = (enemies: EnemyInstance[]) =>
    characters.slice().sort((left, right) => {
      const difference = scoreForHalf(right, enemies, input) - scoreForHalf(left, enemies, input);
      return difference || left.id - right.id;
    });
  const rankedFirst = rankedFor(firstEnemies);
  const rankedSecond = rankedFor(secondEnemies);
  const lockedCharacters = characters.filter(({ id }) => locked.has(String(id)));
  const seenElements = new Set<string>();
  const elementSpecialists = [...rankedFirst, ...rankedSecond].filter(({ element }) => {
    const normalized = element.toLowerCase();
    if (!(normalized in ELEMENTS) || seenElements.has(normalized)) return false;
    seenElements.add(normalized);
    return true;
  });
  const pool = uniqueCharacters([
    ...lockedCharacters,
    ...rankedFirst.slice(0, 8),
    ...rankedSecond.slice(0, 8),
    ...elementSpecialists
  ]);
  const firstCandidates = buildTeamCandidates(pool, firstEnemies, input);
  const secondCandidates = buildTeamCandidates(pool, secondEnemies, input);
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
  return best;
}

interface TeamCandidate {
  team: CharacterProfile[];
  ids: Set<string>;
  score: number;
}

function buildTeamCandidates(
  pool: CharacterProfile[],
  enemies: EnemyInstance[],
  input: AbyssAdvisorPlanInput
): TeamCandidate[] {
  return combinations(pool, 4)
    .filter((team) => findAbyssMechanicCoverageGaps(team, enemies).length === 0)
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
    assumptions: []
  });
}

function issue(
  code: AbyssPlanIssue['code'],
  path: Array<string | number>,
  message: string,
  details?: Record<string, unknown>
): AbyssPlanIssue {
  return { code, path, message, ...(details ? { details } : {}) };
}
