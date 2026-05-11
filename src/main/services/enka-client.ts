import { request } from 'undici';
import type { CharacterProfile, CharacterStats } from '../../shared/domain.js';
import type { AvatarMetadataService } from './avatar-metadata.js';
import { buildIconUrl } from './icon-proxy.js';

export interface EnkaProfileResult {
  uid: string;
  region?: string;
  nickname?: string;
  level?: number;
  characters: CharacterProfile[];
}

export interface EnkaClientOptions {
  apiUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}

interface ShowAvatarInfo {
  avatarId?: number;
  level?: number;
}

interface AvatarInfo {
  avatarId?: number;
  propMap?: Record<string, { val?: string }>;
  fightPropMap?: Record<string, number | string>;
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

const DEFAULT_API_URL = 'https://enka.network/api/uid';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_UA = 'genshin-team-advisor/0.2 (local-tool)';

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
  const fromProp = toNumber(avatar.propMap?.['4001']?.val);
  if (fromProp > 0) {
    return fromProp;
  }
  return fallback ?? 1;
}

function buildStats(avatar: AvatarInfo, levelFallback?: number): CharacterStats {
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

export class EnkaClient {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(
    private readonly metadata: AvatarMetadataService,
    options: EnkaClientOptions = {}
  ) {
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_UA;
  }

  async fetchProfile(uid: string): Promise<EnkaProfileResult> {
    const trimmed = uid.trim();
    if (!/^\d{9}$/.test(trimmed)) {
      throw new Error('UID 必须为 9 位数字');
    }

    const metadata = await this.metadata.load();
    const url = `${this.apiUrl.replace(/\/+$/, '')}/${trimmed}`;
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers: {
        'user-agent': this.userAgent,
        accept: 'application/json'
      },
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs
    });

    if (statusCode === 404) {
      throw new Error('Enka 未找到该 UID（可能从未在游戏内进入角色展示柜）');
    }

    if (statusCode < 200 || statusCode >= 300) {
      const text = await body.text();
      throw new Error(`Enka 请求失败 HTTP ${statusCode}: ${text.slice(0, 200)}`);
    }

    const json = (await body.json()) as EnkaResponse;

    const showLevelMap = new Map<number, number>();
    for (const avatar of json.playerInfo?.showAvatarInfoList ?? []) {
      if (typeof avatar.avatarId === 'number' && typeof avatar.level === 'number') {
        showLevelMap.set(avatar.avatarId, avatar.level);
      }
    }

    const characters: CharacterProfile[] = (json.avatarInfoList ?? [])
      .filter((avatar): avatar is AvatarInfo & { avatarId: number } => typeof avatar.avatarId === 'number')
      .map((avatar) => {
        const meta = metadata.get(avatar.avatarId);
        return {
          id: avatar.avatarId,
          name: meta?.name ?? `角色-${avatar.avatarId}`,
          element: meta?.element ?? 'Unknown',
          rarity: meta?.rarity ?? 4,
          imageUrl: meta?.icon ?? buildIconUrl('UI_AvatarIcon_PlayerBoy.png'),
          stats: buildStats(avatar, showLevelMap.get(avatar.avatarId))
        };
      });

    return {
      uid: json.uid ?? trimmed,
      region: json.region,
      nickname: json.playerInfo?.nickname,
      level: json.playerInfo?.level,
      characters
    };
  }
}
