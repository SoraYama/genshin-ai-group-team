import { createHash } from 'node:crypto';
import { request } from 'undici';
import type {
  ArtifactPiece,
  ArtifactSlot,
  CharacterStats,
  CharacterTalents,
  CharacterWeapon,
  StatPair
} from '../../shared/domain.js';
import {
  CLIENT_TYPE_WEB,
  MIYOUSHE_APP_VERSION_WEB,
  MIYOUSHE_RECORD_PAGE,
  MIYOUSHE_RECORD_TOOL_VERSION,
  signDsV2
} from './miyoushe/ds-token.js';
import { MIYOUSHE_UA } from './miyoushe-client.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DETAIL_BATCH_SIZE = 20;
const DEFAULT_BASE_CN = 'https://api-takumi-record.mihoyo.com';
const DEFAULT_BASE_GLOBAL = 'https://sg-public-api.hoyolab.com/event';

const PATH_INDEX = '/game_record/app/genshin/api/index';
const PATH_CHARACTER_LIST = '/game_record/app/genshin/api/character/list';
const PATH_CHARACTER_DETAIL = '/game_record/app/genshin/api/character/detail';
const PATH_SPIRAL_ABYSS = '/game_record/app/genshin/api/spiralAbyss';
const PATH_ROLE_COMBAT = '/game_record/app/genshin/api/role_combat';

const VERBOSE_LOG = process.env.MIYOUSHE_DEBUG === '1';

function logInfo(message: string): void {
  if (VERBOSE_LOG) console.info(`[miyoushe-record] ${message}`);
}
function logWarn(message: string): void {
  if (VERBOSE_LOG) console.warn(`[miyoushe-record] ${message}`);
}
function redactUid(uid: string): string {
  return uid.length <= 3 ? '***' : `***${uid.slice(-3)}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function deviceHeadersFromCookie(cookie: string): Record<string, string> {
  const values = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (value) values.set(name, value);
  }
  const deviceId = values.get('_MHYUUID');
  const deviceFp = values.get('DEVICEFP');
  return deviceId && deviceFp ? { 'x-rpc-device_id': deviceId, 'x-rpc-device_fp': deviceFp } : {};
}

export interface MiyousheGameRecordClientOptions {
  baseUrlCn?: string;
  baseUrlGlobal?: string;
  timeoutMs?: number;
  userAgent?: string;
  browserTransport?: MiyousheBrowserTransport;
}

export interface MiyousheBrowserTransportRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface MiyousheBrowserTransportResponse {
  statusCode: number;
  headers: Record<string, string>;
  bodyText: string;
}

export type MiyousheBrowserTransport = (
  url: string,
  request: MiyousheBrowserTransportRequest
) => Promise<MiyousheBrowserTransportResponse>;

export interface MiyousheRegion {
  region: string;
  isGlobal: boolean;
}

export type MiyousheFetchError =
  | { kind: 'auth-expired'; retcode?: number; message: string }
  | { kind: 'captcha-required'; retcode?: number; message: string }
  | { kind: 'rate-limited'; retcode?: number; message: string }
  | { kind: 'signature'; retcode?: number; message: string }
  | { kind: 'schema-drift'; message: string }
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
  stats?: Partial<Omit<CharacterStats, 'level'>>;
}

export interface MiyousheRosterCoverage {
  expectedOwnedCount?: number;
  listedCount: number;
  detailedCount: number;
  missingCharacterIds: number[];
  duplicateCharacterIds: number[];
  unexpectedCharacterIds: number[];
  failedBatches: Array<{ batchIndex: number; kind: MiyousheFetchError['kind'] }>;
  fields: {
    weapon: number;
    artifacts: number;
    talents: number;
    stats: number;
  };
  partial: boolean;
}

export interface MiyousheDetailedRoster {
  characters: MiyousheCharacterDetail[];
  coverage: MiyousheRosterCoverage;
}

export interface FetchDetailedRosterOptions {
  expectedOwnedCount?: number;
  batchSize?: number;
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

interface RawCharacterListData {
  list?: RawCharacterListItem[];
}

interface RawArtifactSet {
  id?: number;
  name?: string;
}

interface RawArtifact {
  id?: number;
  icon?: string;
  pos?: number;
  pos_name?: string;
  rarity?: number;
  level?: number;
  set?: RawArtifactSet;
  main_property?: RawProperty;
  sub_property_list?: RawProperty[];
}

interface RawSkill {
  skill_id?: number;
  skill_type?: number;
  level?: number;
  is_unlock?: boolean;
}

interface RawDetailedCharacter extends RawCharacterListItem {
  base?: RawCharacterListItem;
  relics?: RawArtifact[];
  skills?: RawSkill[];
  base_properties?: RawProperty[];
  selected_properties?: RawProperty[];
  extra_properties?: RawProperty[];
  element_properties?: RawProperty[];
}

interface RawPropertyInfo {
  property_type?: number;
  name?: string;
}

interface RawCharacterDetailData {
  list?: RawDetailedCharacter[];
  property_map?: Record<string, RawPropertyInfo>;
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

function statKeyFromProperty(
  prop: RawProperty | undefined,
  propertyMap?: Record<string, RawPropertyInfo>
): string {
  if (!prop) return 'unknown';
  if (prop.name) return prop.name;
  if (prop.property_type !== undefined) {
    const mapped = propertyMap?.[String(prop.property_type)]?.name;
    if (mapped) return mapped;
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

function toStatPair(
  prop: RawProperty | undefined,
  propertyMap?: Record<string, RawPropertyInfo>
): StatPair {
  return {
    key: statKeyFromProperty(prop, propertyMap),
    value: statValueFromProperty(prop)
  };
}

function mapWeapon(
  raw: RawWeapon | undefined,
  propertyMap?: Record<string, RawPropertyInfo>
): CharacterWeapon | undefined {
  if (!raw || raw.id === undefined) return undefined;
  return {
    id: raw.id,
    name: raw.name ?? '',
    iconUrl: raw.icon ?? '',
    level: raw.level ?? 0,
    refinement: raw.affix_level ?? 1,
    rarity: raw.rarity ?? 0,
    mainStat: raw.main_property ? toStatPair(raw.main_property, propertyMap) : undefined,
    subStat: raw.sub_property ? toStatPair(raw.sub_property, propertyMap) : undefined
  };
}

const ARTIFACT_SLOT_BY_POSITION: Record<number, ArtifactSlot> = {
  1: 'flower',
  2: 'plume',
  3: 'sands',
  4: 'goblet',
  5: 'circlet'
};

function artifactSlot(raw: RawArtifact): ArtifactSlot | undefined {
  if (raw.pos !== undefined && ARTIFACT_SLOT_BY_POSITION[raw.pos]) {
    return ARTIFACT_SLOT_BY_POSITION[raw.pos];
  }
  const name = raw.pos_name?.toLowerCase() ?? '';
  if (name.includes('flower') || name.includes('生之花')) return 'flower';
  if (name.includes('plume') || name.includes('feather') || name.includes('死之羽')) return 'plume';
  if (name.includes('sands') || name.includes('时之沙')) return 'sands';
  if (name.includes('goblet') || name.includes('空之杯')) return 'goblet';
  if (name.includes('circlet') || name.includes('理之冠')) return 'circlet';
  return undefined;
}

function mapArtifact(
  raw: RawArtifact,
  propertyMap?: Record<string, RawPropertyInfo>
): ArtifactPiece | undefined {
  const slot = artifactSlot(raw);
  if (!slot || raw.id === undefined || !raw.main_property) return undefined;
  return {
    slot,
    setId: raw.set?.id ?? 0,
    setName: raw.set?.name ?? '',
    level: raw.level ?? 0,
    rarity: raw.rarity ?? 0,
    mainStat: toStatPair(raw.main_property, propertyMap),
    subStats: (raw.sub_property_list ?? []).map((prop) => toStatPair(prop, propertyMap)),
    iconUrl: raw.icon
  };
}

function mapTalents(skills: RawSkill[] | undefined): CharacterTalents | undefined {
  const unlocked = (skills ?? []).filter(
    (skill): skill is RawSkill & { level: number } =>
      skill.is_unlock !== false && typeof skill.level === 'number'
  );
  const byType = new Map(unlocked.map((skill) => [skill.skill_type, skill.level]));
  const normalAttack = byType.get(1) ?? unlocked[0]?.level;
  const elementalSkill = byType.get(2) ?? unlocked[1]?.level;
  const elementalBurst = byType.get(3) ?? unlocked[2]?.level;
  if (normalAttack === undefined || elementalSkill === undefined || elementalBurst === undefined) {
    return undefined;
  }
  return { normalAttack, elementalSkill, elementalBurst };
}

const CORE_STAT_BY_PROPERTY_TYPE: Record<number, keyof Omit<CharacterStats, 'level'>> = {
  1: 'hp',
  4: 'atk',
  7: 'def',
  20: 'critRate',
  22: 'critDmg',
  23: 'energyRecharge',
  28: 'elementalMastery'
};

function mapCoreStats(
  raw: RawDetailedCharacter
): Partial<Omit<CharacterStats, 'level'>> | undefined {
  const properties = [
    ...(raw.base_properties ?? []),
    ...(raw.selected_properties ?? []),
    ...(raw.extra_properties ?? []),
    ...(raw.element_properties ?? [])
  ];
  const stats: Partial<Omit<CharacterStats, 'level'>> = {};
  for (const property of properties) {
    if (property.property_type === undefined) continue;
    const key = CORE_STAT_BY_PROPERTY_TYPE[property.property_type];
    if (!key) continue;
    const rawValue = statValueFromProperty(property);
    stats[key] =
      (key === 'critRate' || key === 'critDmg' || key === 'energyRecharge') &&
      !String(property.final ?? property.value ?? '').includes('%') &&
      rawValue <= 10
        ? Number((rawValue * 100).toFixed(2))
        : rawValue;
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function mapCharacterListItem(item: RawCharacterListItem): MiyousheCharacterDetail {
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

function mapDetailedCharacter(
  raw: RawDetailedCharacter,
  propertyMap?: Record<string, RawPropertyInfo>
): MiyousheCharacterDetail {
  const base = raw.base ?? raw;
  const mappedBase = mapCharacterListItem(base);
  return {
    ...mappedBase,
    imageUrl: raw.image ?? mappedBase.imageUrl,
    weapon: mapWeapon(raw.weapon ?? base.weapon, propertyMap),
    artifacts: (raw.relics ?? [])
      .map((artifact) => mapArtifact(artifact, propertyMap))
      .filter((artifact): artifact is ArtifactPiece => artifact !== undefined),
    talents: mapTalents(raw.skills),
    stats: mapCoreStats(raw)
  };
}

/** Parse sanitized browser-intercepted list data without exposing raw payloads. */
export function mapMiyousheCharacterListData(data: unknown): MiyousheCharacterDetail[] | undefined {
  if (!isObject(data) || !Array.isArray(data['list'])) return undefined;
  return (data['list'] as RawCharacterListItem[])
    .filter((item) => typeof item?.id === 'number')
    .map(mapCharacterListItem);
}

/** Parse sanitized browser-intercepted detail data through the direct-client mapper. */
export function mapMiyousheCharacterDetailData(
  data: unknown
): MiyousheCharacterDetail[] | undefined {
  if (!isObject(data) || !Array.isArray(data['list'])) return undefined;
  const propertyMap = isObject(data['property_map'])
    ? (data['property_map'] as Record<string, RawPropertyInfo>)
    : undefined;
  return (data['list'] as RawDetailedCharacter[])
    .filter((item) => typeof (item.base ?? item)?.id === 'number')
    .map((item) => mapDetailedCharacter(item, propertyMap));
}

function classifyError(payload: {
  retcode?: number;
  message?: string;
  httpStatus?: number;
}): MiyousheFetchError {
  const retcode = payload.retcode;
  const message = payload.message ?? `retcode=${retcode ?? 'unknown'}`;
  if (payload.httpStatus === 429) {
    return { kind: 'rate-limited', retcode, message };
  }
  if (retcode === -100 || retcode === 10001 || retcode === 10002) {
    return { kind: 'auth-expired', retcode, message };
  }
  if (retcode === 1034 || retcode === 5003) {
    return { kind: 'captcha-required', retcode, message };
  }
  if (retcode === 10101 || retcode === 10103) {
    return { kind: 'rate-limited', retcode, message };
  }
  if (retcode === -5003) {
    return { kind: 'signature', retcode, message };
  }
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
  private readonly browserTransport?: MiyousheBrowserTransport;

  constructor(options: MiyousheGameRecordClientOptions = {}) {
    this.baseUrlCn = options.baseUrlCn ?? DEFAULT_BASE_CN;
    this.baseUrlGlobal = options.baseUrlGlobal ?? DEFAULT_BASE_GLOBAL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? MIYOUSHE_UA;
    this.browserTransport = options.browserTransport;
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
   * Compatibility wrapper used by the current profile IPC. The authoritative
   * implementation is `fetchDetailedRoster`, which preserves ownership order
   * and explicit coverage. Callers that need partial diagnostics should use it
   * directly instead of discarding coverage here.
   */
  async fetchCharacterDetails(
    uid: string,
    cookie: string
  ): Promise<MiyousheFetchResult<MiyousheCharacterDetail[]>> {
    const index = await this.fetchPlayerIndex(uid, cookie);
    if (!index.ok) return index;
    const roster = await this.fetchDetailedRoster(uid, cookie, {
      expectedOwnedCount: index.data.totalCharacters
    });
    return roster.ok ? { ok: true, data: roster.data.characters } : roster;
  }

  async fetchDetailedRoster(
    uid: string,
    cookie: string,
    options: FetchDetailedRosterOptions = {}
  ): Promise<MiyousheFetchResult<MiyousheDetailedRoster>> {
    const region = regionFromUid(uid);
    logInfo(`fetchDetailedRoster uid=${redactUid(uid)} region=${region.region}`);
    const payload = { role_id: uid, server: region.region };
    const listResult = await this.postSigned<RawCharacterListData>(
      PATH_CHARACTER_LIST,
      region,
      cookie,
      payload
    );
    if (!listResult.ok) return listResult;
    if (!Array.isArray(listResult.data.list)) {
      return {
        ok: false,
        error: { kind: 'schema-drift', message: 'character/list 缺少 list 数组' }
      };
    }

    const list = listResult.data.list.filter(
      (item): item is RawCharacterListItem & { id: number } => typeof item.id === 'number'
    );
    const duplicateCharacterIds: number[] = [];
    const uniqueList: Array<RawCharacterListItem & { id: number }> = [];
    const listedIds = new Set<number>();
    for (const item of list) {
      if (listedIds.has(item.id)) {
        duplicateCharacterIds.push(item.id);
      } else {
        listedIds.add(item.id);
        uniqueList.push(item);
      }
    }

    const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_DETAIL_BATCH_SIZE, 100));
    const detailById = new Map<number, MiyousheCharacterDetail>();
    const unexpectedCharacterIds: number[] = [];
    const failedBatches: MiyousheRosterCoverage['failedBatches'] = [];

    for (let offset = 0; offset < uniqueList.length; offset += batchSize) {
      const batchIndex = Math.floor(offset / batchSize);
      const characterIds = uniqueList.slice(offset, offset + batchSize).map((item) => item.id);
      const detailResult = await this.postSigned<RawCharacterDetailData>(
        PATH_CHARACTER_DETAIL,
        region,
        cookie,
        { ...payload, character_ids: characterIds }
      );
      if (!detailResult.ok) {
        failedBatches.push({ batchIndex, kind: detailResult.error.kind });
        continue;
      }
      if (!Array.isArray(detailResult.data.list)) {
        failedBatches.push({ batchIndex, kind: 'schema-drift' });
        continue;
      }
      for (const raw of detailResult.data.list) {
        const base = raw.base ?? raw;
        if (typeof base.id !== 'number') continue;
        if (!listedIds.has(base.id)) {
          unexpectedCharacterIds.push(base.id);
          continue;
        }
        detailById.set(base.id, mapDetailedCharacter(raw, detailResult.data.property_map));
      }
    }

    const characters = uniqueList.map(
      (item) => detailById.get(item.id) ?? mapCharacterListItem(item)
    );
    const missingCharacterIds = uniqueList
      .filter((item) => !detailById.has(item.id))
      .map((item) => item.id);
    const fields = {
      weapon: characters.filter((character) => character.weapon !== undefined).length,
      artifacts: characters.filter((character) => character.artifacts.length > 0).length,
      talents: characters.filter((character) => character.talents !== undefined).length,
      stats: characters.filter((character) => character.stats !== undefined).length
    };
    const listedCount = uniqueList.length;
    const expectedMismatch =
      options.expectedOwnedCount !== undefined && options.expectedOwnedCount !== listedCount;
    const coverage: MiyousheRosterCoverage = {
      expectedOwnedCount: options.expectedOwnedCount,
      listedCount,
      detailedCount: detailById.size,
      missingCharacterIds,
      duplicateCharacterIds,
      unexpectedCharacterIds,
      failedBatches,
      fields,
      partial:
        expectedMismatch ||
        missingCharacterIds.length > 0 ||
        duplicateCharacterIds.length > 0 ||
        unexpectedCharacterIds.length > 0 ||
        failedBatches.length > 0
    };
    logInfo(
      `coverage uid=${redactUid(uid)} listed=${listedCount} detailed=${detailById.size} ` +
        `partial=${coverage.partial} fields=${JSON.stringify(fields)}`
    );
    return { ok: true, data: { characters, coverage } };
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
        worldLevel:
          typeof stats['world_level'] === 'number' ? (stats['world_level'] as number) : undefined,
        activeDays:
          typeof stats['active_day_number'] === 'number'
            ? (stats['active_day_number'] as number)
            : undefined,
        totalCharacters:
          typeof stats['avatar_number'] === 'number'
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
        scheduleId:
          typeof result.data['schedule_id'] === 'string'
            ? (result.data['schedule_id'] as string)
            : undefined,
        startTime:
          typeof result.data['start_time'] === 'string'
            ? (result.data['start_time'] as string)
            : undefined,
        endTime:
          typeof result.data['end_time'] === 'string'
            ? (result.data['end_time'] as string)
            : undefined,
        totalBattleTimes:
          typeof result.data['total_battle_times'] === 'number'
            ? (result.data['total_battle_times'] as number)
            : undefined,
        maxFloor:
          typeof result.data['max_floor'] === 'string'
            ? (result.data['max_floor'] as string)
            : undefined,
        totalStar:
          typeof result.data['total_star'] === 'number'
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
        scheduleId:
          typeof result.data['schedule_id'] === 'string'
            ? (result.data['schedule_id'] as string)
            : undefined,
        maxRoundId:
          typeof result.data['max_round_id'] === 'number'
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
    method: 'GET' | 'POST',
    region: MiyousheRegion,
    cookie: string,
    ds: string
  ): Record<string, string> {
    // Only reuse the matched device pair produced by the same persisted
    // browser session. Manual three-cookie imports continue without these
    // optional headers; we never invent or persist a random pair.
    const headers: Record<string, string> = {
      cookie,
      'user-agent': this.userAgent,
      accept: 'application/json, text/plain, */*',
      DS: ds,
      'x-rpc-app_version': MIYOUSHE_APP_VERSION_WEB,
      'x-rpc-client_type': CLIENT_TYPE_WEB,
      'x-rpc-language': region.isGlobal ? 'en-us' : 'zh-cn',
      Referer: region.isGlobal ? 'https://act.hoyolab.com/' : 'https://webstatic.mihoyo.com/',
      Origin: region.isGlobal ? 'https://act.hoyolab.com' : 'https://webstatic.mihoyo.com',
      ...deviceHeadersFromCookie(cookie)
    };
    if (method === 'POST') {
      headers['content-type'] = 'application/json;charset=UTF-8';
    }
    if (!region.isGlobal) {
      headers['x-rpc-page'] = MIYOUSHE_RECORD_PAGE;
      headers['x-rpc-tool_verison'] = MIYOUSHE_RECORD_TOOL_VERSION;
    }
    return headers;
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

  private async postSigned<T>(
    path: string,
    region: MiyousheRegion,
    cookie: string,
    payload: Record<string, unknown>
  ): Promise<MiyousheFetchResult<T>> {
    // The exact same string is signed and sent. Re-stringifying after signing
    // can reorder/alter bytes and produces an invalid DS signature.
    const body = JSON.stringify(payload);
    return this.doSignedRequest<T>({
      method: 'POST',
      path,
      region,
      cookie,
      query: '',
      body
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
    useBrowserTransport?: boolean;
  }): Promise<MiyousheFetchResult<T>> {
    const {
      method,
      path,
      region,
      cookie,
      query,
      body,
      isRetry,
      useBrowserTransport
    } = args;
    const token = signDsV2({ query, body, clientType: CLIENT_TYPE_WEB });
    const url = `${this.resolveBase(region)}${path}${query ? `?${query}` : ''}`;
    const headers = this.buildHeaders(method, region, cookie, token.header);

    const requestMaterial = `${query}\n${body}`;
    logInfo(
      `→ ${method} ${path} materialLength=${requestMaterial.length} ` +
        `materialHash=${shortHash(requestMaterial)}` +
        (isRetry ? ' [retry]' : '') +
        (useBrowserTransport ? ' [chromium]' : '')
    );

    try {
      const response =
        useBrowserTransport && this.browserTransport
          ? await this.browserTransport(url, {
              method,
              headers,
              body: method === 'POST' ? body : undefined,
              timeoutMs: this.timeoutMs
            })
          : await request(url, {
              method,
              headers,
              body: method === 'POST' ? body : undefined,
              bodyTimeout: this.timeoutMs,
              headersTimeout: this.timeoutMs
            });
      const text = 'bodyText' in response ? response.bodyText : await response.body.text();
      const challengeHeaderNames = Object.keys(response.headers ?? {}).filter((name) =>
        /aigis|challenge|geetest/i.test(name)
      );
      if (challengeHeaderNames.length > 0) {
        logInfo(`challenge-headers=${challengeHeaderNames.join(',')}`);
      }
      let parsed: RawEnvelope<T> | undefined;
      try {
        parsed = JSON.parse(text) as RawEnvelope<T>;
      } catch {
        logWarn(
          `← HTTP ${response.statusCode} non-JSON length=${text.length} hash=${shortHash(text)}`
        );
        return {
          ok: false,
          error: { kind: 'parse', message: `非 JSON 响应（HTTP ${response.statusCode}）` }
        };
      }
      const retcode = parsed?.retcode;
      const message = parsed?.message;
      logInfo(
        `← HTTP ${response.statusCode} retcode=${retcode ?? '?'}` +
          (message ? ` message="${message.replace(/[\r\n]/g, ' ').slice(0, 120)}"` : '') +
          (retcode === 0
            ? ` data-keys=${parsed?.data ? Object.keys(parsed.data as object).join(',') : 'null'}`
            : '')
      );
      if (retcode === 0 && parsed?.data !== undefined) {
        return { ok: true, data: parsed.data };
      }

      const classified = classifyError({
        retcode,
        message,
        httpStatus: response.statusCode
      });
      if (classified.kind === 'captcha-required') {
        logInfo(`risk-context transport=${useBrowserTransport ? 'chromium' : 'node'}`);
      }

      // 5003/1034 can be tied to the Node HTTP/TLS fingerprint even when the
      // cookie and DS are valid. Retry once through Electron's persisted
      // Chromium session. The caller owns any data-source fallback.
      if (classified.kind === 'captcha-required' && this.browserTransport && !useBrowserTransport) {
        return this.doSignedRequest<T>({
          ...args,
          isRetry: false,
          useBrowserTransport: true
        });
      }

      // Retry once on transient 5xx with a fresh DS. Auth/captcha/signature
      // failures are not transient and retrying them only increases risk-control.
      if (!isRetry && response.statusCode >= 500 && response.statusCode < 600) {
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
