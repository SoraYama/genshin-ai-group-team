import type { CharacterProfile } from '../../shared/domain.js';
import {
  type AbyssAdvisorPlanInput,
  type AbyssPlanIssue,
  type AbyssPlanOutput,
  type AbyssScenario
} from '../../shared/abyss-advisor.js';
import { abyssPlanSchema } from '../../shared/scenario-v2.js';
import { findAbyssMechanicCoverageGaps } from '../../shared/abyss-mechanics.js';

export type AbyssPlanValidationResult =
  | { ok: true; issues: []; plan: AbyssPlanOutput }
  | { ok: false; issues: AbyssPlanIssue[] };

export interface ValidateAbyssPlanOptions {
  input: AbyssAdvisorPlanInput;
  scenario: AbyssScenario;
  characters: CharacterProfile[];
  plan: unknown;
}

export function validateAbyssPlan({
  input,
  scenario,
  characters,
  plan
}: ValidateAbyssPlanOptions): AbyssPlanValidationResult {
  const issues: AbyssPlanIssue[] = [];
  const raw = isRecord(plan) ? plan : {};
  const firstIds = teamIds(raw['firstHalfTeam']);
  const secondIds = teamIds(raw['secondHalfTeam']);
  const allIds = [...firstIds, ...secondIds];
  const ownedIds = new Set(characters.map(({ id }) => String(id)));
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
  const excludedIds = new Set(input.excludedCharacterIds);

  if (raw['scenarioId'] !== input.scenarioId || input.scenarioId !== scenario.id) {
    addIssue(issues, 'SCENARIO_MISMATCH', ['scenarioId'], '方案与所选深境螺旋场景不一致。');
  }
  if (raw['dataVersion'] !== input.dataVersion || input.dataVersion !== scenario.meta.dataVersion) {
    addIssue(issues, 'DATA_VERSION_MISMATCH', ['dataVersion'], '方案使用的资料版本不一致。');
  }

  const targetFloor = scenario.floors.find(({ floor }) => floor === input.floor);
  const targetChambers = targetFloor
    ? input.chamber === undefined
      ? targetFloor.chambers
      : targetFloor.chambers.filter(({ chamber }) => chamber === input.chamber)
    : [];
  if (!targetFloor || targetChambers.length === 0) {
    addIssue(issues, 'TARGET_NOT_FOUND', ['target'], '所选楼层或房间不在当前资料中。', {
      floor: input.floor,
      chamber: input.chamber
    });
  }

  validateTeam(firstIds, 'firstHalfTeam', issues);
  validateTeam(secondIds, 'secondHalfTeam', issues);
  const firstSet = new Set(firstIds);
  const overlap = secondIds.filter((id) => firstSet.has(id));
  if (overlap.length > 0) {
    addIssue(
      issues,
      'CROSS_TEAM_DUPLICATE',
      ['secondHalfTeam', 'characterIds'],
      '上下半队伍不能使用同一角色。',
      { characterIds: unique(overlap) }
    );
  }

  unique(allIds).forEach((id) => {
    if (!ownedIds.has(id)) {
      addIssue(issues, 'CHARACTER_NOT_OWNED', ['teams', id], '方案包含未拥有的角色。', {
        characterId: id
      });
    }
    if (excludedIds.has(id)) {
      addIssue(issues, 'CHARACTER_EXCLUDED', ['teams', id], '方案使用了已排除角色。', {
        characterId: id
      });
    }
  });

  if (input.lockedCharacterIds.length > 8) {
    addIssue(
      issues,
      'LOCK_LIMIT_EXCEEDED',
      ['lockedCharacterIds'],
      '锁定角色不能超过两队共 8 个位置。',
      { locked: input.lockedCharacterIds.length, maximum: 8 }
    );
  }
  input.lockedCharacterIds.forEach((id, index) => {
    if (excludedIds.has(id)) {
      addIssue(
        issues,
        'LOCK_EXCLUDE_CONFLICT',
        ['lockedCharacterIds', index],
        '同一角色不能同时锁定和排除。',
        { characterId: id }
      );
    }
    if (!ownedIds.has(id)) {
      addIssue(
        issues,
        'CHARACTER_NOT_OWNED',
        ['lockedCharacterIds', index],
        '锁定角色不在当前角色资料中。',
        { characterId: id }
      );
    }
    if (!allIds.includes(id)) {
      addIssue(
        issues,
        'LOCKED_CHARACTER_MISSING',
        ['lockedCharacterIds', index],
        '锁定角色没有出现在最终双队中。',
        { characterId: id }
      );
    }
  });

  const rawChambers = Array.isArray(raw['chambers']) ? raw['chambers'] : [];
  const expectedCoordinates = targetChambers.map(({ chamber }) => `${input.floor}:${chamber}`);
  const actualCoordinates = rawChambers.map((chamber) => {
    if (!isRecord(chamber)) return 'invalid';
    return `${String(chamber['floor'])}:${String(chamber['chamber'])}`;
  });
  if (!sameUniqueSet(expectedCoordinates, actualCoordinates)) {
    addIssue(issues, 'CHAMBER_COVERAGE_INVALID', ['chambers'], '方案必须且只能覆盖所选房间。', {
      expected: expectedCoordinates,
      actual: actualCoordinates
    });
  }
  rawChambers.forEach((chamber, chamberIndex) => {
    if (!isRecord(chamber)) return;
    for (const half of ['firstHalf', 'secondHalf'] as const) {
      const halfPlan = chamber[half];
      const tactics = isRecord(halfPlan) ? halfPlan['tactics'] : undefined;
      if (
        !Array.isArray(tactics) ||
        tactics.length === 0 ||
        tactics.some((tactic) => typeof tactic !== 'string' || tactic.trim().length === 0)
      ) {
        addIssue(
          issues,
          'TACTICS_MISSING',
          ['chambers', chamberIndex, half, 'tactics'],
          '每个房间的上下半都必须给出可执行打法。'
        );
      }
    }
  });

  if (targetChambers.length > 0) {
    const firstTeam = firstIds.flatMap((id) => {
      const character = charactersById.get(id);
      return character ? [character] : [];
    });
    const secondTeam = secondIds.flatMap((id) => {
      const character = charactersById.get(id);
      return character ? [character] : [];
    });
    const halves = [
      {
        key: 'firstHalfTeam',
        team: firstTeam,
        enemies: targetChambers.flatMap(({ firstHalf }) =>
          firstHalf.waves.flatMap(({ enemies }) => enemies)
        )
      },
      {
        key: 'secondHalfTeam',
        team: secondTeam,
        enemies: targetChambers.flatMap(({ secondHalf }) =>
          secondHalf.waves.flatMap(({ enemies }) => enemies)
        )
      }
    ] as const;
    halves.forEach(({ key, team, enemies }) => {
      findAbyssMechanicCoverageGaps(team, enemies).forEach((gap) =>
        addIssue(issues, 'MECHANIC_COVERAGE_INVALID', [key], gap.message, {
          enemyName: gap.enemyName,
          mechanic: gap.kind
        })
      );
    });
  }

  const parsed = abyssPlanSchema.safeParse(plan);
  if (!parsed.success) {
    addIssue(
      issues,
      'PLAN_SCHEMA_INVALID',
      (parsed.error.issues[0]?.path ?? []).map((segment) =>
        typeof segment === 'symbol' ? String(segment) : segment
      ),
      '方案结构不完整，无法安全使用。'
    );
  }

  if (issues.length > 0 || !parsed.success) return { ok: false, issues };
  return { ok: true, issues: [], plan: parsed.data };
}

function validateTeam(ids: string[], teamKey: string, issues: AbyssPlanIssue[]): void {
  if (ids.length !== 4) {
    addIssue(
      issues,
      'TEAM_SIZE_INVALID',
      [teamKey, 'characterIds'],
      '每支队伍必须正好包含 4 名角色。',
      { actual: ids.length }
    );
  }
  if (new Set(ids).size !== ids.length) {
    addIssue(issues, 'TEAM_DUPLICATE', [teamKey, 'characterIds'], '同一支队伍不能重复角色。');
  }
}

function teamIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value['characterIds'])) return [];
  return value['characterIds'].filter((id): id is string => typeof id === 'string');
}

function sameUniqueSet(expected: string[], actual: string[]): boolean {
  return (
    expected.length === actual.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: AbyssPlanIssue[],
  code: AbyssPlanIssue['code'],
  path: Array<string | number>,
  message: string,
  details?: Record<string, unknown>
): void {
  issues.push({ code, path, message, ...(details ? { details } : {}) });
}
