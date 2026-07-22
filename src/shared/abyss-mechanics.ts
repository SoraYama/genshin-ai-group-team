import type { CharacterProfile } from './domain.js';
import type { EnemyInstance } from './scenario-v2.js';
import {
  characterCapabilitySchema,
  weaponTypeSchema,
  type CharacterKnowledgeReader
} from './character-knowledge.js';

const ELEMENT_LABELS: Record<string, string> = {
  pyro: '火',
  hydro: '水',
  anemo: '风',
  geo: '岩',
  electro: '雷',
  dendro: '草',
  cryo: '冰'
};

export const ABYSS_CAPABILITY_TAG_CONVENTION_VERSION = 1 as const;

export const ABYSS_SHIELD_COUNTERS: Record<string, string[]> = {
  pyro: ['hydro'],
  hydro: ['dendro', 'cryo', 'electro'],
  electro: ['pyro', 'dendro', 'cryo'],
  cryo: ['pyro'],
  geo: ['geo'],
  untyped: ['geo']
};

export interface AbyssMechanicCoverageGap {
  enemyName: string;
  kind: 'shield' | 'immunity' | 'capability';
  message: string;
  requirement?: string;
  unknownRequirement?: boolean;
}

export function findAbyssMechanicCoverageGaps(
  team: CharacterProfile[],
  enemies: EnemyInstance[],
  knowledge?: CharacterKnowledgeReader,
  options: { ignoreCapabilityRequirements?: boolean } = {}
): AbyssMechanicCoverageGap[] {
  const teamElements = team
    .map(({ element }) => element.toLowerCase())
    .filter((element) => element in ELEMENT_LABELS);
  const gaps: AbyssMechanicCoverageGap[] = [];

  for (const enemy of enemies) {
    const enemyName = enemy.enemy.names['zh-CN'] ?? enemy.enemy.names['zh'] ?? '未命名敌人';
    for (const shield of enemy.mechanics.shields) {
      const counters = ABYSS_SHIELD_COUNTERS[shield.element] ?? [];
      if (counters.length > 0 && !teamElements.some((element) => counters.includes(element))) {
        gaps.push({
          enemyName,
          kind: 'shield',
          message: `${enemyName}的${abyssElementLabel(shield.element)}元素护盾没有已知破盾元素。`
        });
      }
    }

    const immuneElements = new Set(
      enemy.mechanics.immunities.flatMap((immunity) => recognizedImmuneElements(immunity))
    );
    if (
      immuneElements.size > 0 &&
      teamElements.length > 0 &&
      teamElements.every((element) => immuneElements.has(element))
    ) {
      gaps.push({
        enemyName,
        kind: 'immunity',
        message: `${enemyName}会免疫当前队伍全部已知元素伤害。`
      });
    }

    if (options.ignoreCapabilityRequirements) continue;
    for (const requirement of parseRequiredCapabilities(enemy.mechanics.tags)) {
      if (!requirement.known) {
        gaps.push({
          enemyName,
          kind: 'capability',
          requirement: requirement.value,
          unknownRequirement: true,
          message: `${enemyName}声明了无法识别的硬机制要求，已停止自动配队。`
        });
        continue;
      }
      const satisfied = team.some((character) => {
        const record = knowledge?.lookup(String(character.id));
        return (
          record?.status === 'known' &&
          (record.weaponType === requirement.value ||
            record.capabilities?.includes(
              requirement.value as NonNullable<typeof record.capabilities>[number]
            ))
        );
      });
      if (!satisfied) {
        gaps.push({
          enemyName,
          kind: 'capability',
          requirement: requirement.value,
          message: `${enemyName}要求队伍具备${capabilityLabel(requirement.value)}，当前队伍没有已确认满足的角色。`
        });
      }
    }
  }
  return gaps;
}

export function parseRequiredCapabilities(tags: string[]) {
  const allowed = new Set<string>([
    ...characterCapabilitySchema.options,
    ...weaponTypeSchema.options
  ]);
  return tags.flatMap((tag) => {
    const prefix = 'requires-capability:';
    if (!tag.startsWith(prefix)) return [];
    const value = tag.slice(prefix.length).trim().toLowerCase();
    return [
      {
        contractVersion: ABYSS_CAPABILITY_TAG_CONVENTION_VERSION,
        value,
        known: allowed.has(value)
      }
    ];
  });
}

export function characterSatisfiesRequirement(
  characterId: string,
  requirement: string,
  knowledge?: CharacterKnowledgeReader
): boolean {
  const record = knowledge?.lookup(characterId);
  return Boolean(
    record?.status === 'known' &&
    (record.weaponType === requirement ||
      record.capabilities?.includes(requirement as NonNullable<typeof record.capabilities>[number]))
  );
}

export function abyssElementLabel(value: string): string {
  return ELEMENT_LABELS[value.toLowerCase()] ?? '其他';
}

export function localizedMechanicTerm(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'physical') return '物理伤害';
  if (normalized in ELEMENT_LABELS) return `${ELEMENT_LABELS[normalized]}元素伤害`;
  return /[\u3400-\u9fff]/u.test(value) ? value : '未本地化机制';
}

function recognizedImmuneElements(value: string): string[] {
  const normalized = value.toLowerCase();
  if (normalized in ELEMENT_LABELS) return [normalized];
  return Object.entries(ELEMENT_LABELS)
    .filter(([, label]) => value.includes(`${label}元素伤害`))
    .map(([element]) => element);
}

function capabilityLabel(value: string): string {
  const labels: Record<string, string> = {
    healing: '治疗能力',
    shield: '护盾能力',
    grouping: '聚怪能力',
    'off-field': '后台作用能力',
    'on-field': '站场能力',
    onslaught: '正面攻坚能力',
    plunging: '下落攻击能力',
    'normal-attack': '普通攻击能力',
    'charged-attack': '重击能力',
    sword: '单手剑角色',
    claymore: '双手剑角色',
    polearm: '长柄武器角色',
    bow: '弓角色',
    catalyst: '法器角色'
  };
  return labels[value] ?? '未知能力';
}
