import { request } from 'undici';
import type {
  ArtifactPiece,
  CharacterTalents,
  CharacterWeapon,
  StatPair
} from '../../shared/domain.js';
import {
  CLIENT_TYPE_WEB,
  MIYOUSHE_APP_VERSION_WEB,
  signDsV2
} from './miyoushe/ds-token.js';
import { MIYOUSHE_UA } from './miyoushe-client.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_CN = 'https://api-takumi-record.mihoyo.com';
const DEFAULT_BASE_GLOBAL = 'https://bbs-api-os.hoyolab.com';

const PATH_INDEX = '/game_record/app/genshin/api/index';
const PATH_SPIRAL_ABYSS = '/game_record/app/genshin/api/spiralAbyss';
const PATH_ROLE_COMBAT = '/game_record/app/genshin/api/role_combat';

const VERBOSE_LOG = process.env.MIYOUSHE_DEBUG !== '0';

function logInfo(message: string): void {
  if (VERBOSE_LOG) console.info(`[miyoushe-record] ${message}`);
}
function logWarn(message: string): void {
  if (VERBOSE_LOG) console.warn(`[miyoushe-record] ${message}`);
}
function redactCookie(cookie: string): string {
  return cookie
    .split(';')
    .map((p) => {
      const i = p.indexOf('=');
      if (i < 0) return p.trim();
      return `${p.slice(0, i).trim()}=…(${p.length - i - 1}b)`;
    })
    .join('; ');
}

export interface MiyousheGameRecordClientOptions {
  baseUrlCn?: string;
  baseUrlGlobal?: string;
  timeoutMs?: number;
  userAgent?: string;
}

export interface MiyousheRegion {
  region: string;
  isGlobal: boolean;
}

export type MiyousheFetchError =
  | { kind: 'auth-expired'; retcode?: number; message: string }
  | { kind: 'captcha-required'; retcode?: number; message: string }
  | { kind: 'rate-limited'; retcode?: number; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'parse'; message: string }
  | { kind: 'upstream'; retcode?: number; httpStatus?: number; message: string };

export type MiyousheFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: MiyousheFetchError };

export interface MiyousheCharacterDetail {
  id: number;
  name: string;
  element: string;
  level: number;
  rarity: number;
  iconUrl: string;
  imageUrl?: string;
  constellation: number;
  friendship: number;
  weapon?: CharacterWeapon;
  artifacts: ArtifactPiece[];
  talents?: CharacterTalents;
}

export interface MiyoushePlayerIndex {
  nickname?: string;
  worldLevel?: number;
  activeDays?: number;
  totalCharacters?: number;
}

export interface MiyousheAbyssData {
  scheduleId?: string;
  startTime?: string;
  endTime?: string;
  totalBattleTimes?: number;
  maxFloor?: string;
  totalStar?: number;
  raw: unknown;
}

export interface MiyousheRoleCombatData {
  scheduleId?: string;
  maxRoundId?: number;
  raw: unknown;
}

interface RawCharacterListItem {
  id?: number;
  name?: string;
  element?: string;
  level?: number;
  rarity?: number;
  icon?: string;
  image?: string;
  actived_constellation_num?: number;
  fetter?: number;
  weapon?: RawWeapon;
}

interface RawWeapon {
  id?: number;
  name?: string;
  icon?: string;
  type_name?: string;
  rarity?: number;
  level?: number;
  affix_level?: number;
  desc?: string;
  type?: number;
  main_property?: RawProperty;
  sub_property?: RawProperty;
}

interface RawProperty {
  property_type?: number;
  base?: string;
  add?: string;
  final?: string;
  value?: string;
  name?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function regionFromUid(uid: string): MiyousheRegion {
  const first = uid.charAt(0);
  switch (first) {
    case '1':
    case '2':
    case '3':
    case '4':
      return { region: 'cn_gf01', isGlobal: false };
    case '5':
      return { region: 'cn_qd01', isGlobal: false };
    case '6':
      return { region: 'os_usa', isGlobal: true };
    case '7':
      return { region: 'os_euro', isGlobal: true };
    case '8':
      return { region: 'os_asia', isGlobal: true };
    case '9':
      return { region: 'os_cht', isGlobal: true };
    default:
      return { region: 'cn_gf01', isGlobal: false };
  }
}

const STAT_KEY_BY_PROPERTY_TYPE: Record<number, string> = {
  1: 'baseHp',
  2: 'hpFlat',
  3: 'hpPct',
  4: 'baseAtk',
  5: 'atkFlat',
  6: 'atkPct',
  7: 'baseDef',
  8: 'defFlat',
  9: 'defPct',
  10: 'baseSpeed',
  11: 'speedPct',
  20: 'critRate',
  21: 'unknown21',
  22: 'critDmg',
  23: 'energyRecharge',
  26: 'healingBonus',
  27: 'healingReceived',
  28: 'elementalMastery',
  29: 'physResist',
  30: 'physDmg',
  40: 'pyroDmg',
  41: 'electroDmg',
  42: 'hydroDmg',
  43: 'dendroDmg',
  44: 'anemoDmg',
  45: 'geoDmg',
  46: 'cryoDmg'
};

function statKeyFromProperty(prop: RawProperty | undefined): string {
  if (!prop) return 'unknown';
  if (prop.name) return prop.name;
  if (prop.property_type !== undefined) {
    return STAT_KEY_BY_PROPERTY_TYPE[prop.property_type] ?? `prop_${prop.property_type}`;
  }
  return 'unknown';
}

function statValueFromProperty(prop: RawProperty | undefined): number {
  if (!prop) return 0;
  const raw = prop.value ?? prop.final ?? prop.add ?? prop.base ?? '0';
  if (typeof raw === 'number') return raw;
  const cleaned = String(raw).replace(/[,%]/g, '').trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toStatPair(prop: RawProperty | undefined): StatPair {
  return { key: statKeyFromProperty(prop), value: statValueFromProperty(prop) };
}

function mapWeapon(raw: RawWeapon | undefined): CharacterWeapon | undefined {
  if (!raw || raw.id === undefined) return undefined;
  return {
    id: raw.id,
    name: raw.name ?? '',
    iconUrl: raw.icon ?? '',
    level: raw.level ?? 0,
    refinement: raw.affix_level ?? 1,
    rarity: raw.rarity ?? 0,
    mainStat: raw.main_property ? toStatPair(raw.main_property) : undefined,
    subStat: raw.sub_property ? toStatPair(raw.sub_property) : undefined
  };
}

function classifyError(payload: {
  retcode?: number;
  message?: string;
  httpStatus?: number;
}): MiyousheFetchError {
  const retcode = payload.retcode;
  const message = payload.message ?? `retcode=${retcode ?? 'unknown'}`;
  if (retcode === -100 || retcode === 10001 || retcode === 10002) {
    return { kind: 'auth-expired', retcode, message };
  }
  if (retcode === 1034) {
    return { kind: 'captcha-required', retcode, message };
  }
  if (retcode === 10101 || retcode === 10103) {
    return { kind: 'rate-limited', retcode, message };
  }
  // 5003 — typically "endpoint version mismatch" / DS soft-fail. Classified as
  // upstream so the legacy /character fallback gets a chance.
  return {
    kind: 'upstream',
    retcode,
    httpStatus: payload.httpStatus,
    message
  };
}

interface RawEnvelope<T> {
  retcode?: number;
  message?: string;
  data?: T;
}

export class MiyousheGameRecordClient {
  private readonly baseUrlCn: string;
  private readonly baseUrlGlobal: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: MiyousheGameRecordClientOptions = {}) {
    this.baseUrlCn = options.baseUrlCn ?? DEFAULT_BASE_CN;
    this.baseUrlGlobal = options.baseUrlGlobal ?? DEFAULT_BASE_GLOBAL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? MIYOUSHE_UA;
  }

  /**
   * Probe the well-known `/index` endpoint to verify auth + signing work before
   * we touch the more brittle character endpoints. Returns a typed sentinel on
   * failure so the caller can decide what to do.
   */
  async ping(uid: string, cookie: string): Promise<MiyousheFetchResult<MiyoushePlayerIndex>> {
    return this.fetchPlayerIndex(uid, cookie);
  }

  /**
   * Fetch every owned character.
   *
   * The reliable path is `/index` (GET) — it returns an `avatars[]` array
   * with id/name/element/level/rarity/constellation/icon/image for every
   * owned character. This is the same endpoint the miyoushe web profile uses.
   *
   * `/character/list` and `/character/detail` (which carry artifact + talent
   * data) require a matched `device_id` / `device_fp` pair that we don't
   * have a reliable way to produce yet; they consistently return retcode 5003.
   * For v0.6 we accept losing artifact data and prioritize getting the full
   * roster, which is the user-visible value. Weapons / artifacts are still
   * available via Enka for the showcased 8 characters.
   */
  async fetchCharacterDetails(
    uid: string,
    cookie: string
  ): Promise<MiyousheFetchResult<MiyousheCharacterDetail[]>> {
    const region = regionFromUid(uid);
    logInfo(`fetchCharacterDetails uid=${uid} region=${region.region} cookie=${redactCookie(cookie)}`);

    const query = `role_id=${encodeURIComponent(uid)}&server=${encodeURIComponent(region.region)}`;
    const indexResult = await this.getSigned<{ avatars?: RawCharacterListItem[] }>(
      PATH_INDEX,
      region,
      cookie,
      query
    );
    if (!indexResult.ok) return indexResult;

    const avatars = Array.isArray(indexResult.data.avatars) ? indexResult.data.avatars : [];
    logInfo(`/index returned ${avatars.length} avatars`);
    return { ok: true, data: this.fromListOnly(avatars) };
  }

  private fromListOnly(list: RawCharacterListItem[]): MiyousheCharacterDetail[] {
    return list
      .filter((item) => typeof item.id === 'number')
      .map((item) => this.mapListItem(item));
  }

  private mapListItem(item: RawCharacterListItem): MiyousheCharacterDetail {
    return {
      id: item.id ?? 0,
      name: item.name ?? '',
      element: item.element ?? '',
      level: item.level ?? 0,
      rarity: item.rarity ?? 0,
      iconUrl: item.icon ?? '',
      imageUrl: item.image,
      constellation: item.actived_constellation_num ?? 0,
      friendship: item.fetter ?? 0,
      weapon: mapWeapon(item.weapon),
      artifacts: []
    };
  }

  async fetchPlayerIndex(
    uid: string,
    cookie: string
  ): Promise<MiyousheFetchResult<MiyoushePlayerIndex>> {
    const region = regionFromUid(uid);
    const query = `role_id=${encodeURIComponent(uid)}&server=${encodeURIComponent(region.region)}`;
    const result = await this.getSigned<Record<string, unknown>>(PATH_INDEX, region, cookie, query);
    if (!result.ok) return result;
    const stats = isObject(result.data.stats) ? result.data.stats : {};
    const role = isObject(result.data.role) ? result.data.role : {};
    const avatars = Array.isArray((result.data as { avatars?: unknown[] }).avatars)
      ? ((result.data as { avatars?: unknown[] }).avatars as unknown[])
      : undefined;
    return {
      ok: true,
      data: {
        nickname: typeof role['nickname'] === 'string' ? (role['nickname'] as string) : undefined,
        worldLevel: typeof stats['world_level'] === 'number'
          ? (stats['world_level'] as number)
          : undefined,
        activeDays: typeof stats['active_day_number'] === 'number'
          ? (stats['active_day_number'] as number)
          : undefined,
        totalCharacters: typeof stats['avatar_number'] === 'number'
          ? (stats['avatar_number'] as number)
          : avatars?.length
      }
    };
  }

  async fetchSpiralAbyss(
    uid: string,
    cookie: string,
    schedule: 1 | 2 = 1
  ): Promise<MiyousheFetchResult<MiyousheAbyssData>> {
    const region = regionFromUid(uid);
    const query = `role_id=${encodeURIComponent(uid)}&schedule_type=${schedule}&server=${encodeURIComponent(region.region)}`;
    const result = await this.getSigned<Record<string, unknown>>(
      PATH_SPIRAL_ABYSS,
      region,
      cookie,
      query
    );
    if (!result.ok) return result;
    return {
      ok: true,
      data: {
        scheduleId: typeof result.data['schedule_id'] === 'string'
          ? (result.data['schedule_id'] as string)
          : undefined,
        startTime: typeof result.data['start_time'] === 'string'
          ? (result.data['start_time'] as string)
          : undefined,
        endTime: typeof result.data['end_time'] === 'string'
          ? (result.data['end_time'] as string)
          : undefined,
        totalBattleTimes: typeof result.data['total_battle_times'] === 'number'
          ? (result.data['total_battle_times'] as number)
          : undefined,
        maxFloor: typeof result.data['max_floor'] === 'string'
          ? (result.data['max_floor'] as string)
          : undefined,
        totalStar: typeof result.data['total_star'] === 'number'
          ? (result.data['total_star'] as number)
          : undefined,
        raw: result.data
      }
    };
  }

  async fetchRoleCombat(
    uid: string,
    cookie: string
  ): Promise<MiyousheFetchResult<MiyousheRoleCombatData>> {
    const region = regionFromUid(uid);
    const query = `role_id=${encodeURIComponent(uid)}&server=${encodeURIComponent(region.region)}&need_detail=true`;
    const result = await this.getSigned<Record<string, unknown>>(
      PATH_ROLE_COMBAT,
      region,
      cookie,
      query
    );
    if (!result.ok) return result;
    return {
      ok: true,
      data: {
        scheduleId: typeof result.data['schedule_id'] === 'string'
          ? (result.data['schedule_id'] as string)
          : undefined,
        maxRoundId: typeof result.data['max_round_id'] === 'number'
          ? (result.data['max_round_id'] as number)
          : undefined,
        raw: result.data
      }
    };
  }

  private resolveBase(region: MiyousheRegion): string {
    return region.isGlobal ? this.baseUrlGlobal : this.baseUrlCn;
  }

  private buildHeaders(
    region: MiyousheRegion,
    cookie: string,
    ds: string
  ): Record<string, string> {
    // genshin.py's minimal working recipe. We deliberately do NOT send
    // `x-rpc-device_id` / `x-rpc-device_fp` here: the two must be a matched
    // pair (the fp is issued for a specific id), and sending mismatched ones
    // triggers retcode 5003 on ALL endpoints — including the well-known
    // `/index`. Better to send neither than send a mismatched pair.
    return {
      cookie,
      'user-agent': this.userAgent,
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      DS: ds,
      'x-rpc-app_version': MIYOUSHE_APP_VERSION_WEB,
      'x-rpc-client_type': CLIENT_TYPE_WEB,
      'x-rpc-language': region.isGlobal ? 'en-us' : 'zh-cn',
      Referer: region.isGlobal
        ? 'https://act.hoyolab.com/'
        : 'https://webstatic.mihoyo.com/',
      Origin: region.isGlobal
        ? 'https://act.hoyolab.com'
        : 'https://webstatic.mihoyo.com'
    };
  }

  private async getSigned<T>(
    path: string,
    region: MiyousheRegion,
    cookie: string,
    query: string
  ): Promise<MiyousheFetchResult<T>> {
    return this.doSignedRequest<T>({
      method: 'GET',
      path,
      region,
      cookie,
      query,
      body: ''
    });
  }

  private async doSignedRequest<T>(args: {
    method: 'GET' | 'POST';
    path: string;
    region: MiyousheRegion;
    cookie: string;
    query: string;
    body: string;
    isRetry?: boolean;
  }): Promise<MiyousheFetchResult<T>> {
    const { method, path, region, cookie, query, body, isRetry } = args;
    const token = signDsV2({ query, body, clientType: CLIENT_TYPE_WEB });
    const url = `${this.resolveBase(region)}${path}${query ? `?${query}` : ''}`;
    const headers = this.buildHeaders(region, cookie, token.header);

    logInfo(
      `→ ${method} ${path}${query ? `?${query}` : ''} ` +
        `ds=${token.header.slice(0, 30)}… body=${body || '∅'}` +
        (isRetry ? ' [retry]' : '')
    );

    try {
      const response = await request(url, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs
      });
      const text = await response.body.text();
      let parsed: RawEnvelope<T> | undefined;
      try {
        parsed = JSON.parse(text) as RawEnvelope<T>;
      } catch {
        logWarn(`← HTTP ${response.statusCode} non-JSON: ${text.slice(0, 200)}`);
        return {
          ok: false,
          error: { kind: 'parse', message: `非 JSON 响应：${text.slice(0, 200)}` }
        };
      }
      const retcode = parsed?.retcode;
      const message = parsed?.message;
      logInfo(
        `← HTTP ${response.statusCode} retcode=${retcode ?? '?'}` +
          (message ? ` message="${message}"` : '') +
          (retcode === 0 ? ` data-keys=${parsed?.data ? Object.keys(parsed.data as object).join(',') : 'null'}` : '')
      );
      if (retcode === 0 && parsed?.data !== undefined) {
        return { ok: true, data: parsed.data };
      }

      const classified = classifyError({
        retcode,
        message,
        httpStatus: response.statusCode
      });

      // Retry once on auth/5xx with a fresh DS — only one attempt to avoid loops.
      if (!isRetry && (classified.kind === 'auth-expired' || (response.statusCode >= 500 && response.statusCode < 600))) {
        return this.doSignedRequest<T>({ ...args, isRetry: true });
      }

      return { ok: false, error: classified };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'miyoushe request failed';
      logWarn(`network error: ${msg}`);
      return {
        ok: false,
        error: { kind: 'network', message: msg }
      };
    }
  }
}
