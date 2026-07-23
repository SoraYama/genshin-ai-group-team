import type { CharacterProfile } from '../../shared/domain.js';
import {
  stygianAdvisorPlanSchema,
  type StygianAdvisorPlanInput,
  type StygianPlanIssue,
  type StygianPlanOutput,
  type StygianScenario
} from '../../shared/stygian-advisor.js';
import { findAbyssMechanicCoverageGaps } from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';
import { isStygianTargetDifficultyCompatible } from '../../shared/stygian-reward-policy.js';

export type StygianPlanValidationResult =
  | { ok: true; issues: []; plan: StygianPlanOutput }
  | { ok: false; issues: StygianPlanIssue[] };

export interface ValidateStygianPlanOptions {
  input: StygianAdvisorPlanInput;
  scenario: StygianScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
  plan: unknown;
}

export function validateStygianPlan({
  input,
  scenario,
  characters,
  knowledge,
  plan
}: ValidateStygianPlanOptions): StygianPlanValidationResult {
  const issues: StygianPlanIssue[] = [];
  const raw = isRecord(plan) ? plan : {};
  const rawPhases = Array.isArray(raw['phases']) ? raw['phases'] : [];
  const phaseTeams = rawPhases.map((phase) => ({
    phase: isRecord(phase) && typeof phase['phase'] === 'number' ? phase['phase'] : -1,
    ids: isRecord(phase) && isRecord(phase['team']) ? teamIds(phase['team']) : []
  }));
  const allIds = phaseTeams.flatMap(({ ids }) => ids);
  const owned = new Map(characters.map((character) => [String(character.id), character]));
  const excluded = new Set(input.excludedCharacterIds);

  if (raw['scenarioId'] !== input.scenarioId || input.scenarioId !== scenario.id) {
    addIssue(issues, 'SCENARIO_MISMATCH', ['scenarioId'], '方案与所选幽境危战场景不一致。');
  }
  if (raw['dataVersion'] !== input.dataVersion || input.dataVersion !== scenario.meta.dataVersion) {
    addIssue(issues, 'DATA_VERSION_MISMATCH', ['dataVersion'], '方案使用的挑战资料版本不一致。');
  }

  const difficulty = scenario.difficulties.find(({ id }) => id === input.difficultyId);
  if (!difficulty) {
    addIssue(issues, 'DIFFICULTY_NOT_FOUND', ['difficultyId'], '所选难度不在当前资料中。', {
      difficultyId: input.difficultyId
    });
  } else if (!isStygianTargetDifficultyCompatible(input.target, difficulty.order)) {
    addIssue(
      issues,
      'TARGET_DIFFICULTY_CONFLICT',
      ['target'],
      '所选难度低于当前应用内目标档位，请提高难度或降低奖励目标。',
      { target: input.target, difficultyOrder: difficulty.order, policy: 'app-target-orders-v1' }
    );
  }
  if (input.phase !== undefined && !scenario.phases.some(({ phase }) => phase === input.phase)) {
    addIssue(issues, 'PHASE_NOT_FOUND', ['phase'], '所选阶段不在当前资料中。', {
      phase: input.phase
    });
  }

  if (
    !sameUniqueSet(
      phaseTeams.map(({ phase }) => phase),
      [1, 2, 3]
    )
  ) {
    addIssue(issues, 'PHASE_COVERAGE_INVALID', ['phases'], '方案必须且只能覆盖第 1、2、3 阶段。');
  }
  phaseTeams.forEach(({ phase, ids }, index) => {
    if (ids.length !== 4) {
      addIssue(
        issues,
        'TEAM_SIZE_INVALID',
        ['phases', index, 'team', 'characterIds'],
        '每个阶段必须恰好使用 4 名角色。',
        {
          phase,
          actual: ids.length
        }
      );
    }
    if (new Set(ids).size !== ids.length) {
      addIssue(
        issues,
        'TEAM_DUPLICATE',
        ['phases', index, 'team', 'characterIds'],
        '同一阶段的队伍内不能重复角色。'
      );
    }
    const rawPhase = rawPhases[index];
    const rawTeam = isRecord(rawPhase) && isRecord(rawPhase['team']) ? rawPhase['team'] : undefined;
    const rotationNotes = rawTeam?.['rotationNotes'];
    if (
      !Array.isArray(rotationNotes) ||
      rotationNotes.length === 0 ||
      rotationNotes.some((note) => typeof note !== 'string' || note.trim().length === 0)
    ) {
      addIssue(
        issues,
        'PLAN_SCHEMA_INVALID',
        ['phases', index, 'team', 'rotationNotes'],
        '每个阶段必须保留至少一条可执行的循环依据。'
      );
    }
  });

  unique(allIds).forEach((id) => {
    if (!owned.has(id)) {
      addIssue(issues, 'CHARACTER_NOT_OWNED', ['teams', id], '方案包含未拥有的角色。', {
        characterId: id
      });
    }
    if (excluded.has(id)) {
      addIssue(issues, 'CHARACTER_EXCLUDED', ['teams', id], '方案使用了已排除角色。', {
        characterId: id
      });
    }
  });
  if (input.lockedCharacterIds.length > 12) {
    addIssue(issues, 'LOCK_LIMIT_EXCEEDED', ['lockedCharacterIds'], '锁定角色超过三队总位置数。');
  }
  input.lockedCharacterIds.forEach((id, index) => {
    if (excluded.has(id)) {
      addIssue(
        issues,
        'LOCK_EXCLUDE_CONFLICT',
        ['lockedCharacterIds', index],
        '同一角色不能同时锁定和排除。',
        {
          characterId: id
        }
      );
    }
    if (!owned.has(id)) {
      addIssue(
        issues,
        'CHARACTER_NOT_OWNED',
        ['lockedCharacterIds', index],
        '锁定角色不在当前角色资料中。',
        {
          characterId: id
        }
      );
    }
    if (!allIds.includes(id)) {
      addIssue(
        issues,
        'LOCKED_CHARACTER_MISSING',
        ['lockedCharacterIds', index],
        '锁定角色没有出现在最终三队中。',
        {
          characterId: id
        }
      );
    }
  });

  const policy = scenario.crossPartyReusePolicy;
  if (raw['reusePolicyAcknowledgement'] !== policy.rule) {
    addIssue(
      issues,
      'REUSE_ACKNOWLEDGEMENT_MISMATCH',
      ['reusePolicyAcknowledgement'],
      '方案记录的跨队角色规则与当前挑战资料不一致。'
    );
  }
  const appearances = new Map<string, number>();
  phaseTeams.forEach(({ ids }) => {
    new Set(ids).forEach((id) => appearances.set(id, (appearances.get(id) ?? 0) + 1));
  });
  const maximum =
    policy.rule === 'forbidden'
      ? 1
      : policy.rule === 'limited'
        ? policy.maxPartyAppearancesPerCharacter
        : 3;
  const overused = [...appearances.entries()].filter(([, count]) => count > maximum);
  if (overused.length > 0) {
    addIssue(
      issues,
      'REUSE_POLICY_VIOLATION',
      ['phases'],
      '三队中有角色超过当期允许的跨队出场次数。',
      {
        maximum,
        characterAppearances: Object.fromEntries(overused)
      }
    );
  }

  for (const scenarioPhase of scenario.phases) {
    const planned = phaseTeams.find(({ phase }) => phase === scenarioPhase.phase);
    if (!planned) continue;
    const team = planned.ids.flatMap((id) => {
      const character = owned.get(id);
      return character ? [character] : [];
    });
    findAbyssMechanicCoverageGaps(team, [scenarioPhase.boss], knowledge).forEach((gap) => {
      addIssue(
        issues,
        'MECHANIC_COVERAGE_INVALID',
        ['phases', scenarioPhase.phase, 'team'],
        gap.message,
        {
          phase: scenarioPhase.phase,
          enemyName: gap.enemyName,
          mechanic: gap.kind,
          ...(gap.requirement ? { requirement: gap.requirement } : {}),
          ...(gap.unknownRequirement ? { unknownRequirement: true } : {})
        }
      );
    });
  }

  const parsed = stygianAdvisorPlanSchema.safeParse(plan);
  if (!parsed.success) {
    const firstSchemaIssue = parsed.error.issues[0];
    const unsafePlayerText = parsed.error.issues.some(({ message }) =>
      message.includes('raw technical identifier')
    );
    addIssue(
      issues,
      unsafePlayerText ? 'AGENT_OUTPUT_INVALID' : 'PLAN_SCHEMA_INVALID',
      (firstSchemaIssue?.path ?? []).map((part) =>
        typeof part === 'symbol' ? String(part) : part
      ),
      unsafePlayerText ? '方案包含不应直接展示给玩家的技术标识。' : '方案结构不完整，无法安全使用。'
    );
  }
  if (issues.length > 0 || !parsed.success) return { ok: false, issues };
  return { ok: true, issues: [], plan: parsed.data };
}

function teamIds(team: Record<string, unknown>): string[] {
  return Array.isArray(team['characterIds'])
    ? team['characterIds'].filter((value): value is string => typeof value === 'string')
    : [];
}

function addIssue(
  issues: StygianPlanIssue[],
  code: StygianPlanIssue['code'],
  path: Array<string | number>,
  message: string,
  details?: Record<string, unknown>
): void {
  issues.push({ code, path, message, ...(details ? { details } : {}) });
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function sameUniqueSet(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    right.every((item) => left.includes(item))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
