import type { CharacterProfile } from '../../shared/domain.js';
import type {
  TheaterAdvisorPlanInput,
  TheaterEligibilityReport,
  TheaterScenario
} from '../../shared/theater-advisor.js';
import { parseRequiredCapabilities } from '../../shared/abyss-mechanics.js';
import type { CharacterKnowledgeReader } from '../../shared/character-knowledge.js';

export interface EvaluateTheaterEligibilityOptions {
  input: TheaterAdvisorPlanInput;
  scenario: TheaterScenario;
  characters: CharacterProfile[];
  knowledge?: CharacterKnowledgeReader;
}

export function evaluateTheaterEligibility({
  input,
  scenario,
  characters,
  knowledge
}: EvaluateTheaterEligibilityOptions): TheaterEligibilityReport {
  const allowed = new Set(scenario.eligibility.elements.map((value) => value.toLowerCase()));
  const excluded = new Set(input.excludedCharacterIds);
  const ownedById = new Map(characters.map((character) => [String(character.id), character]));
  const eligibleOwned: string[] = [];
  const ineligibleOwned: TheaterEligibilityReport['ineligibleOwned'] = [];

  for (const character of characters) {
    const id = String(character.id);
    if (excluded.has(id)) continue;
    const levelQualified = (character.level ?? 0) >= scenario.eligibility.minimumLevel;
    const elementQualified = allowed.has(character.element.toLowerCase());
    if (levelQualified && elementQualified) {
      eligibleOwned.push(id);
      continue;
    }
    const reasons: Array<'element' | 'level'> = [];
    if (!elementQualified) reasons.push('element');
    if (!levelQualified) reasons.push('level');
    ineligibleOwned.push({
      characterId: id,
      reasons,
      ...(character.level === undefined ? {} : { level: character.level }),
      element: character.element
    });
  }

  const pools: TheaterEligibilityReport['pools'] = [];
  const selectedBySource = [
    ['opening', input.selectedOpeningCharacterIds, scenario.pools.opening] as const,
    ['trial', input.selectedTrialCharacterIds, scenario.pools.trial] as const,
    ['special-guest', input.selectedSpecialGuestCharacterIds, scenario.pools.specialGuest] as const,
    ['support', input.selectedSupportCharacterIds, scenario.pools.support] as const
  ];
  for (const [source, selected, available] of selectedBySource) {
    const knownPool = new Set(available.map(({ id }) => id));
    for (const id of selected) {
      const owned = ownedById.get(id);
      if (!knownPool.has(id)) {
        pools.push({
          id,
          source,
          qualification: 'unqualified',
          countsTowardRequirement: false,
          owned: Boolean(owned),
          note: '该演员不在当期对应名单中。'
        });
        continue;
      }
      if (owned) {
        pools.push({
          id,
          source,
          qualification: 'unknown',
          countsTowardRequirement: false,
          owned: true,
          note: '本次选择的是外部来源演员实例，即使玩家拥有同角色，也不计入自有硬资格。'
        });
      } else {
        pools.push({
          id,
          source,
          qualification: 'unknown',
          countsTowardRequirement: false,
          owned: false,
          note: '场景资料未说明该外部演员是否计入硬资格，暂不计入。'
        });
      }
    }
  }

  const hardQualifiedCount = new Set(eligibleOwned).size;
  const shortage = Math.max(0, scenario.eligibility.requiredHeadcount - hardQualifiedCount);
  const constructionAdvice: TheaterEligibilityReport['constructionAdvice'] = [];
  if (shortage > 0) {
    constructionAdvice.push({
      kind: 'headcount-gap',
      missing: shortage,
      note: `按已确认规则还缺 ${shortage} 名可入场角色。`
    });
    for (const item of ineligibleOwned) {
      if (!item.reasons.includes('level') || item.reasons.includes('element')) continue;
      constructionAdvice.push({
        kind: 'raise-level',
        characterId: item.characterId,
        targetLevel: scenario.eligibility.minimumLevel,
        note: `该角色元素符合，优先提升到 ${scenario.eligibility.minimumLevel} 级可补充人数。`
      });
    }
  }
  const requiredCapabilities = new Set(
    scenario.acts.flatMap(({ encounters }) =>
      encounters.flatMap(({ waves }) =>
        waves.flatMap(({ enemies }) =>
          enemies.flatMap(({ mechanics }) =>
            parseRequiredCapabilities(mechanics.tags).map(({ value }) => value)
          )
        )
      )
    )
  );
  for (const capability of requiredCapabilities) {
    const covered = eligibleOwned.some((id) => {
      const record = knowledge?.lookup(id);
      return (
        record?.status === 'known' &&
        (record.weaponType === capability || record.capabilities?.includes(capability as never))
      );
    });
    if (!covered) {
      constructionAdvice.push({
        kind: 'capability-gap',
        capability,
        note: `已知演员资料尚无法确认“${capability}”对策能力；这是应用内建设建议，不是官方攻略。`
      });
    }
  }

  return {
    status: shortage === 0 ? 'eligible' : 'blocked',
    requiredHeadcount: scenario.eligibility.requiredHeadcount,
    eligibleOwnedCount: eligibleOwned.length,
    hardQualifiedCount,
    shortage,
    eligibleOwnedCharacterIds: eligibleOwned,
    ineligibleOwned,
    pools,
    constructionAdvice
  };
}
