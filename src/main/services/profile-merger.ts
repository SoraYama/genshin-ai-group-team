import type { CharacterProfile, ProfileSource } from '../../shared/domain.js';
import type { MiyousheCharacterDetail } from './miyoushe-game-record.js';

export interface ProfileMergeInput {
  enkaCharacters: CharacterProfile[];
  miyousheCharacters?: MiyousheCharacterDetail[];
}

export interface ProfileMergeOutput {
  characters: CharacterProfile[];
  source: ProfileSource;
}

/**
 * Combine miyoushe game_record characters (full ownership + weapon + artifacts)
 * with Enka showcase characters (precise fightPropMap stats). Conflict rules:
 *
 * - `stats`: Enka wins — only Enka exposes substat-accurate numbers.
 * - `level`, `friendship`, `constellation`, `talents`: miyoushe wins.
 * - `weapon`, `artifacts`: miyoushe is the canonical source; Enka would only
 *   override here if it ever gains artifact extraction (future). For now we
 *   take miyoushe verbatim and let the Advisor render it.
 * - `imageUrl`: prefer whichever IconProxy can serve; Enka's CDN is the one
 *   wired into `gtai-img://`, so Enka wins when present, else miyoushe icon.
 * - Characters only present in miyoushe: included with `source: 'miyoushe'` and
 *   the Enka-only `stats` block omitted (renderers must tolerate undefined).
 * - Characters only in Enka (unusual — showcase character not yet in miyoushe
 *   list, possible during transitional fetch order): included as `source: 'enka'`.
 */
export function mergeProfile(input: ProfileMergeInput): ProfileMergeOutput {
  const enkaById = new Map<number, CharacterProfile>();
  for (const c of input.enkaCharacters) {
    enkaById.set(c.id, c);
  }

  const miyousheList = input.miyousheCharacters ?? [];
  const miyousheById = new Map<number, MiyousheCharacterDetail>();
  for (const c of miyousheList) {
    miyousheById.set(c.id, c);
  }

  const merged: CharacterProfile[] = [];
  const seen = new Set<number>();

  if (miyousheList.length > 0) {
    for (const m of miyousheList) {
      const enka = enkaById.get(m.id);
      merged.push(buildFromMiyoushe(m, enka));
      seen.add(m.id);
    }
  }

  for (const e of input.enkaCharacters) {
    if (seen.has(e.id)) continue;
    merged.push({ ...e, source: 'enka' });
  }

  const source: ProfileSource = pickSource(input);
  return { characters: merged, source };
}

function buildFromMiyoushe(
  miyoushe: MiyousheCharacterDetail,
  enka: CharacterProfile | undefined
): CharacterProfile {
  const characterSource = enka ? 'merged' : 'miyoushe';
  const imageUrl = enka?.imageUrl && enka.imageUrl.length > 0 ? enka.imageUrl : miyoushe.iconUrl;
  return {
    id: miyoushe.id,
    name: enka?.name ?? miyoushe.name,
    element: enka?.element ?? miyoushe.element,
    rarity: enka?.rarity ?? miyoushe.rarity,
    imageUrl,
    stats: enka?.stats ?? {
      level: miyoushe.level,
      hp: 0,
      atk: 0,
      def: 0,
      critRate: 0,
      critDmg: 0,
      energyRecharge: 0,
      elementalMastery: 0
    },
    weapon: miyoushe.weapon,
    artifacts: miyoushe.artifacts,
    constellation: miyoushe.constellation,
    talents: miyoushe.talents,
    friendship: miyoushe.friendship,
    source: characterSource
  };
}

function pickSource(input: ProfileMergeInput): ProfileSource {
  const hasEnka = input.enkaCharacters.length > 0;
  const hasMiyoushe = (input.miyousheCharacters?.length ?? 0) > 0;
  if (hasEnka && hasMiyoushe) return 'merged';
  if (hasMiyoushe) return 'miyoushe';
  if (hasEnka) return 'enka';
  return 'miyoushe-stale';
}
