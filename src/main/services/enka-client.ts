import { request } from 'undici';
import type {
  ArtifactPiece,
  ArtifactSlot,
  CharacterProfile,
  CharacterStats,
  CharacterTalents,
  CharacterWeapon,
  StatPair
} from '../../shared/domain.js';
import type { AvatarMetadataService } from './avatar-metadata.js';
import { buildIconUrl } from './icon-proxy.js';
import { describeBuild } from './profile-merger.js';

export type EnkaShowcaseStatus = 'available' | 'closed-or-empty';

export interface EnkaProfileResult {
  uid: string;
  region?: string;
  nickname?: string;
  level?: number;
  ttlSeconds: number;
  showcaseStatus: EnkaShowcaseStatus;
  characters: CharacterProfile[];
}

export interface EnkaClientOptions {
  apiUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
  now?: () => number;
}

export class EnkaClientError extends Error {
  constructor(
    readonly kind: 'not-found' | 'rate-limited' | 'maintenance' | 'upstream',
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'EnkaClientError';
  }
}

interface ShowAvatarInfo {
  avatarId?: number;
  level?: number;
}

interface EnkaFlatStat {
  appendPropId?: string;
  mainPropId?: string;
  statValue?: number;
}

interface EnkaFlatEquip {
  itemType?: string;
  equipType?: string;
  icon?: string;
  rankLevel?: number;
  nameTextMapHash?: number | string;
  setNameTextMapHash?: number | string;
  weaponStats?: EnkaFlatStat[];
  reliquaryMainstat?: EnkaFlatStat;
  reliquarySubstats?: EnkaFlatStat[];
}

interface EnkaEquip {
  itemId?: number;
  weapon?: {
    level?: number;
    affixMap?: Record<string, number>;
  };
  reliquary?: { level?: number };
  flat?: EnkaFlatEquip;
}

interface AvatarInfo {
  avatarId?: number;
  propMap?: Record<string, { val?: string }>;
  fightPropMap?: Record<string, number | string>;
  equipList?: EnkaEquip[];
  skillLevelMap?: Record<string, number>;
  talentIdList?: number[];
}

interface EnkaPlayerInfo {
  nickname?: string;
  level?: number;
  showAvatarInfoList?: ShowAvatarInfo[];
}

interface EnkaResponse {
  uid?: string;
  region?: string;
  ttl?: number;
  playerInfo?: EnkaPlayerInfo;
  avatarInfoList?: AvatarInfo[];
}

const DEFAULT_API_URL = 'https://enka.network/api/uid';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_UA = 'genshin-team-advisor/1.0 (local-tool; github-release)';

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readLevel(avatar: AvatarInfo, fallback?: number): number | undefined {
  const fromProp = toNumber(avatar.propMap?.['4001']?.val);
  return fromProp > 0 ? fromProp : fallback;
}

function buildStats(avatar: AvatarInfo): CharacterStats | undefined {
  const fight = avatar.fightPropMap;
  if (!fight || Object.keys(fight).length === 0) return undefined;
  return {
    hp: Math.round(toNumber(fight['2000']) || toNumber(fight['1'])) || undefined,
    atk: Math.round(toNumber(fight['2001']) || toNumber(fight['4'])) || undefined,
    def: Math.round(toNumber(fight['2002']) || toNumber(fight['7'])) || undefined,
    critRate: Number((toNumber(fight['20']) * 100).toFixed(1)),
    critDmg: Number((toNumber(fight['22']) * 100).toFixed(1)),
    energyRecharge: Number((toNumber(fight['23']) * 100).toFixed(1)),
    elementalMastery: Math.round(toNumber(fight['28']))
  };
}

function statPair(raw: EnkaFlatStat | undefined): StatPair | undefined {
  const key = raw?.appendPropId ?? raw?.mainPropId;
  if (!key || typeof raw?.statValue !== 'number') return undefined;
  return { key, value: raw.statValue };
}

function mapWeapon(equip: EnkaEquip | undefined): CharacterWeapon | undefined {
  if (!equip?.weapon || equip.itemId === undefined) return undefined;
  const stats = equip.flat?.weaponStats ?? [];
  const refinementValue = Object.values(equip.weapon.affixMap ?? {})[0];
  return {
    id: equip.itemId,
    name: `Weapon-${equip.itemId}`,
    iconUrl: equip.flat?.icon ? buildIconUrl(`${equip.flat.icon}.png`) : '',
    level: equip.weapon.level ?? 0,
    refinement: typeof refinementValue === 'number' ? refinementValue + 1 : 1,
    rarity: equip.flat?.rankLevel ?? 0,
    mainStat: statPair(stats[0]),
    subStat: statPair(stats[1])
  };
}

const SLOT_BY_EQUIP_TYPE: Record<string, ArtifactSlot> = {
  EQUIP_BRACER: 'flower',
  EQUIP_NECKLACE: 'plume',
  EQUIP_SHOES: 'sands',
  EQUIP_RING: 'goblet',
  EQUIP_DRESS: 'circlet'
};

function mapArtifact(equip: EnkaEquip): ArtifactPiece | undefined {
  const slot = equip.flat?.equipType ? SLOT_BY_EQUIP_TYPE[equip.flat.equipType] : undefined;
  const mainStat = statPair(equip.flat?.reliquaryMainstat);
  if (!equip.reliquary || equip.itemId === undefined || !slot || !mainStat) return undefined;
  const setHash = equip.flat?.setNameTextMapHash;
  const setId = typeof setHash === 'number' ? setHash : 0;
  return {
    slot,
    setId,
    setName: setHash ? `Set-${setHash}` : `Set-${Math.floor(equip.itemId / 1000)}`,
    level: Math.max(0, (equip.reliquary.level ?? 1) - 1),
    rarity: equip.flat?.rankLevel ?? 0,
    mainStat,
    subStats: (equip.flat?.reliquarySubstats ?? [])
      .map(statPair)
      .filter((stat): stat is StatPair => stat !== undefined),
    iconUrl: equip.flat?.icon ? buildIconUrl(`${equip.flat.icon}.png`) : undefined
  };
}

function mapTalents(skillLevelMap: Record<string, number> | undefined): CharacterTalents | undefined {
  const levels = Object.entries(skillLevelMap ?? {})
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, level]) => level)
    .filter((level) => Number.isFinite(level));
  if (levels.length < 3) return undefined;
  return {
    normalAttack: levels[0]!,
    elementalSkill: levels[1]!,
    elementalBurst: levels[2]!
  };
}

export class EnkaClient {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expiresAt: number; value: EnkaProfileResult }>();

  constructor(
    private readonly metadata: AvatarMetadataService,
    options: EnkaClientOptions = {}
  ) {
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_UA;
    this.now = options.now ?? Date.now;
  }

  async fetchProfile(uid: string): Promise<EnkaProfileResult> {
    const trimmed = uid.trim();
    if (!/^\d{9}$/.test(trimmed)) throw new Error('UID 必须为 9 位数字');

    const cached = this.cache.get(trimmed);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const metadata = await this.metadata.load();
    const url = `${this.apiUrl.replace(/\/+$/, '')}/${trimmed}`;
    const response = await request(url, {
      method: 'GET',
      headers: { 'user-agent': this.userAgent, accept: 'application/json' },
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs
    });

    if (response.statusCode === 404) {
      throw new EnkaClientError('not-found', 'Enka 未找到该 UID（可能从未进入角色展示柜）');
    }
    if (response.statusCode === 429) {
      const retryAfter = Number(response.headers?.['retry-after']);
      throw new EnkaClientError(
        'rate-limited',
        'Enka 请求过于频繁，请等待 TTL 后重试',
        Number.isFinite(retryAfter) ? retryAfter : undefined
      );
    }
    if (response.statusCode === 424) {
      throw new EnkaClientError('maintenance', 'Enka 或游戏服务正在维护');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump();
      throw new EnkaClientError('upstream', `Enka 请求失败 HTTP ${response.statusCode}`);
    }

    const json = (await response.body.json()) as EnkaResponse;
    const fetchedAt = new Date(this.now()).toISOString();
    const showLevelMap = new Map<number, number>();
    for (const avatar of json.playerInfo?.showAvatarInfoList ?? []) {
      if (typeof avatar.avatarId === 'number' && typeof avatar.level === 'number') {
        showLevelMap.set(avatar.avatarId, avatar.level);
      }
    }

    const characters: CharacterProfile[] = (json.avatarInfoList ?? [])
      .filter(
        (avatar): avatar is AvatarInfo & { avatarId: number } =>
          typeof avatar.avatarId === 'number'
      )
      .map((avatar) => {
        const meta = metadata.get(avatar.avatarId);
        const equips = avatar.equipList ?? [];
        const weapon = mapWeapon(equips.find((equip) => equip.weapon !== undefined));
        const artifacts = equips
          .map(mapArtifact)
          .filter((artifact): artifact is ArtifactPiece => artifact !== undefined);
        const build = {
          stats: buildStats(avatar),
          weapon,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          talents: mapTalents(avatar.skillLevelMap)
        };
        const shape = describeBuild(build);
        return {
          id: avatar.avatarId,
          name: meta?.name ?? `角色-${avatar.avatarId}`,
          element: meta?.element ?? 'Unknown',
          rarity: meta?.rarity ?? 4,
          imageUrl: meta?.icon ?? buildIconUrl('UI_AvatarIcon_PlayerBoy.png'),
          level: readLevel(avatar, showLevelMap.get(avatar.avatarId)),
          constellation: avatar.talentIdList?.length,
          build,
          source: 'enka' as const,
          ...shape,
          provenance: {
            ownership: { source: 'enka' as const, fetchedAt },
            build:
              build.weapon || build.artifacts || build.talents
                ? { source: 'enka' as const, fetchedAt }
                : undefined,
            stats: build.stats ? { source: 'enka' as const, fetchedAt } : undefined
          }
        };
      });

    const ttlSeconds = Math.max(1, json.ttl ?? DEFAULT_TTL_SECONDS);
    const result: EnkaProfileResult = {
      uid: json.uid ?? trimmed,
      region: json.region,
      nickname: json.playerInfo?.nickname,
      level: json.playerInfo?.level,
      ttlSeconds,
      showcaseStatus: json.avatarInfoList ? 'available' : 'closed-or-empty',
      characters
    };
    this.cache.set(trimmed, { expiresAt: this.now() + ttlSeconds * 1000, value: result });
    return result;
  }
}
