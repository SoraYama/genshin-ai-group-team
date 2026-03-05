import type { AppConfig } from '../config.js';
import { getAvatarMetadata } from './avatar-metadata.js';
import type { CharacterProfile } from '../types/profile.js';

interface AvatarInfo {
  avatarId?: number;
  propMap?: Record<string, { val?: string }>;
  fightPropMap?: Record<string, number | string>;
}

interface ShowAvatarInfo {
  avatarId?: number;
  level?: number;
}

interface EnkaPlayerInfo {
  nickname?: string;
  level?: number;
  showAvatarInfoList?: ShowAvatarInfo[];
}

interface EnkaResponse {
  uid?: string;
  region?: string;
  playerInfo?: EnkaPlayerInfo;
  avatarInfoList?: AvatarInfo[];
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function readLevel(avatar: AvatarInfo, fallback?: number): number {
  const fromPropMap = avatar.propMap?.['4001']?.val;
  const parsed = toNumber(fromPropMap);
  if (parsed > 0) {
    return parsed;
  }

  return fallback ?? 1;
}

function buildStats(avatar: AvatarInfo, levelFallback?: number) {
  const fight = avatar.fightPropMap ?? {};

  return {
    level: readLevel(avatar, levelFallback),
    hp: Math.round(toNumber(fight['2000']) || toNumber(fight['1'])),
    atk: Math.round(toNumber(fight['2001']) || toNumber(fight['4'])),
    def: Math.round(toNumber(fight['2002']) || toNumber(fight['7'])),
    critRate: Number((toNumber(fight['20']) * 100).toFixed(1)),
    critDmg: Number((toNumber(fight['22']) * 100).toFixed(1)),
    energyRecharge: Number((toNumber(fight['23']) * 100).toFixed(1)),
    elementalMastery: Math.round(toNumber(fight['28']))
  };
}

export interface EnkaImportResult {
  uid: string;
  region?: string;
  nickname?: string;
  level?: number;
  profiles: CharacterProfile[];
}

export async function fetchEnkaProfiles(options: {
  uid: string;
  config: AppConfig;
  fetchImpl?: typeof fetch;
}): Promise<EnkaImportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const metadata = await getAvatarMetadata({ config: options.config, fetchImpl });

  const response = await fetchImpl(`${options.config.enkaApiUrl}/${options.uid}`);
  const json = (await response.json()) as EnkaResponse;

  const showList = json.playerInfo?.showAvatarInfoList ?? [];
  const showLevelMap = new Map<number, number>();
  for (const avatar of showList) {
    if (typeof avatar.avatarId === 'number' && typeof avatar.level === 'number') {
      showLevelMap.set(avatar.avatarId, avatar.level);
    }
  }

  const avatars = json.avatarInfoList ?? [];
  const profiles: CharacterProfile[] = avatars
    .filter((avatar) => typeof avatar.avatarId === 'number')
    .map((avatar) => {
      const avatarId = avatar.avatarId as number;
      const meta = metadata.get(avatarId);
      return {
        id: avatarId,
        name: meta?.name ?? `角色-${avatarId}`,
        element: meta?.element ?? 'Unknown',
        rarity: meta?.rarity ?? 4,
        imageUrl: meta?.icon ?? 'https://enka.network/ui/UI_AvatarIcon_PlayerBoy.png',
        stats: buildStats(avatar, showLevelMap.get(avatarId))
      };
    });

  return {
    uid: json.uid ?? options.uid,
    region: json.region,
    nickname: json.playerInfo?.nickname,
    level: json.playerInfo?.level,
    profiles
  };
}
