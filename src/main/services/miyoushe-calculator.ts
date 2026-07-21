import { request as undiciRequest } from 'undici';
import type { CharacterTalents, CharacterWeapon } from '../../shared/domain.js';
import {
  deviceHeadersFromCookie,
  regionFromUid,
  type MiyousheCharacterDetail,
  type MiyousheDetailedRoster,
  type MiyousheFetchError,
  type MiyousheFetchResult,
  type MiyousheRosterCoverage
} from './miyoushe-game-record.js';
import {
  CLIENT_TYPE_WEB,
  MIYOUSHE_APP_VERSION_WEB,
  signDsV1
} from './miyoushe/ds-token.js';
import { rewriteIconToProxyUrl } from './icon-proxy.js';

const DEFAULT_BASE_CN =
  'https://api-takumi.mihoyo.com/event/e20200928calculate/v1';
const DEFAULT_BASE_GLOBAL =
  'https://sg-public-api.hoyolab.com/event/e20200928calculate/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const CALCULATOR_REFERER_CN =
  'https://webstatic.mihoyo.com/ys/event/e20200923adopt_calculator/index.html?bbs_presentation_style=fullscreen&bbs_auth_required=true&utm_source=bbs&utm_medium=mys&utm_campaign=icon#/';
const CALCULATOR_USER_AGENT_CN =
  'Mozilla/5.0 (Linux; Genshin Team Advisor) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36 ' +
  'miHoYoBBS/2.46.1';

export interface CalculatorRequestOptions {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface CalculatorResponse {
  statusCode: number;
  bodyText: string;
}

export type CalculatorRequest = (
  url: string,
  options: CalculatorRequestOptions
) => Promise<CalculatorResponse>;

export interface MiyousheCalculatorClientOptions {
  baseUrlCn?: string;
  baseUrlGlobal?: string;
  timeoutMs?: number;
  request?: CalculatorRequest;
}

interface RawCalculatorWeapon {
  id?: number;
  name?: string;
  icon?: string;
  level_current?: number;
  weapon_level?: number;
}

interface RawCalculatorTalent {
  id?: number;
  group_id?: number;
  level_current?: number;
  max_level?: number;
}

interface RawCalculatorCharacter {
  id?: number;
  name?: string;
  element_attr_id?: number;
  avatar_level?: number;
  level_current?: number;
  icon?: string;
  constellation_num?: number;
  fetter_level?: number;
  weapon?: RawCalculatorWeapon;
  skill_list?: RawCalculatorTalent[];
}

interface RawCalculatorRoster {
  list?: RawCalculatorCharacter[];
  total?: number;
}

interface RawEnvelope {
  retcode?: number;
  message?: string;
  data?: unknown;
}

const ELEMENT_BY_ID: Record<number, string> = {
  1: 'Pyro',
  2: 'Anemo',
  3: 'Geo',
  4: 'Dendro',
  5: 'Electro',
  6: 'Hydro',
  7: 'Cryo'
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mapWeapon(raw: RawCalculatorWeapon | undefined): CharacterWeapon | undefined {
  if (
    !raw ||
    typeof raw.id !== 'number' ||
    typeof raw.name !== 'string' ||
    typeof raw.level_current !== 'number' ||
    typeof raw.weapon_level !== 'number'
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    name: raw.name,
    iconUrl: rewriteIconToProxyUrl(raw.icon ?? ''),
    level: raw.level_current,
    rarity: raw.weapon_level
  };
}

function talentType(raw: RawCalculatorTalent): 'attack' | 'skill' | 'burst' | undefined {
  if (typeof raw.id !== 'number' || typeof raw.group_id !== 'number') return undefined;
  if (String(raw.id).length === 6) return 'attack';
  if (raw.id === raw.group_id) return undefined;
  const relevant = raw.group_id % 100;
  const identifier = Math.floor(relevant / 10);
  const order = relevant % 10;
  if (identifier === 2) return undefined;
  if (order === 1) return 'attack';
  if (order === 2) return 'skill';
  if (order === 9) return 'burst';
  return undefined;
}

function mapTalents(raw: RawCalculatorTalent[] | undefined): CharacterTalents | undefined {
  const levels = new Map<'attack' | 'skill' | 'burst', number>();
  for (const talent of raw ?? []) {
    const type = talentType(talent);
    if (type && typeof talent.level_current === 'number') levels.set(type, talent.level_current);
  }
  const normalAttack = levels.get('attack');
  const elementalSkill = levels.get('skill');
  const elementalBurst = levels.get('burst');
  if (
    normalAttack === undefined ||
    elementalSkill === undefined ||
    elementalBurst === undefined
  ) {
    return undefined;
  }
  return { normalAttack, elementalSkill, elementalBurst };
}

export function mapCalculatorRoster(data: unknown): MiyousheDetailedRoster | undefined {
  if (!isObject(data) || !Array.isArray(data['list'])) return undefined;
  const raw = data as RawCalculatorRoster;
  const seen = new Set<number>();
  const duplicateCharacterIds: number[] = [];
  const characters: MiyousheCharacterDetail[] = [];
  for (const item of raw.list ?? []) {
    if (typeof item?.id !== 'number') continue;
    if (seen.has(item.id)) {
      duplicateCharacterIds.push(item.id);
      continue;
    }
    seen.add(item.id);
    characters.push({
      id: item.id,
      name: item.name ?? '',
      element:
        typeof item.element_attr_id === 'number'
          ? (ELEMENT_BY_ID[item.element_attr_id] ?? '')
          : '',
      level: item.level_current ?? 0,
      rarity: item.avatar_level ?? 0,
      iconUrl: rewriteIconToProxyUrl(item.icon ?? ''),
      constellation: item.constellation_num ?? 0,
      friendship: item.fetter_level ?? 0,
      weapon: mapWeapon(item.weapon),
      talents: mapTalents(item.skill_list),
      artifacts: []
    });
  }
  const expectedOwnedCount = typeof raw.total === 'number' ? raw.total : characters.length;
  const fields = {
    weapon: characters.filter((character) => character.weapon !== undefined).length,
    artifacts: 0,
    talents: characters.filter((character) => character.talents !== undefined).length,
    stats: 0
  };
  const coverage: MiyousheRosterCoverage = {
    expectedOwnedCount,
    listedCount: characters.length,
    detailedCount: characters.length,
    missingCharacterIds: [],
    duplicateCharacterIds,
    unexpectedCharacterIds: [],
    failedBatches: [],
    fields,
    partial:
      duplicateCharacterIds.length > 0 ||
      expectedOwnedCount !== characters.length
  };
  return { characters, coverage };
}

function classifyFailure(envelope: RawEnvelope, httpStatus: number): MiyousheFetchError {
  const retcode = envelope.retcode;
  if (retcode === -100 || retcode === 10001 || retcode === 10002) {
    return { kind: 'auth-expired', retcode, message: envelope.message ?? '米游社登录已失效' };
  }
  if (retcode === 5003 || retcode === 1034) {
    return { kind: 'captcha-required', retcode, message: envelope.message ?? '访问触发风控' };
  }
  if (retcode === -502002) {
    return {
      kind: 'upstream',
      retcode,
      httpStatus,
      message: '养成计算器角色同步未开启'
    };
  }
  if (httpStatus === 429 || retcode === 10101 || retcode === 10103) {
    return { kind: 'rate-limited', retcode, message: envelope.message ?? '请求频率受限' };
  }
  return {
    kind: 'upstream',
    retcode,
    httpStatus,
    message: envelope.message ?? `retcode=${retcode ?? 'unknown'}`
  };
}

const defaultRequest: CalculatorRequest = async (url, options) => {
  const response = await undiciRequest(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
    bodyTimeout: options.timeoutMs,
    headersTimeout: options.timeoutMs
  });
  return { statusCode: response.statusCode, bodyText: await response.body.text() };
};

export class MiyousheCalculatorClient {
  private readonly baseUrlCn: string;
  private readonly baseUrlGlobal: string;
  private readonly timeoutMs: number;
  private readonly request: CalculatorRequest;

  constructor(options: MiyousheCalculatorClientOptions = {}) {
    this.baseUrlCn = options.baseUrlCn ?? DEFAULT_BASE_CN;
    this.baseUrlGlobal = options.baseUrlGlobal ?? DEFAULT_BASE_GLOBAL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.request = options.request ?? defaultRequest;
  }

  async fetchOwnedRoster(
    uid: string,
    cookie: string
  ): Promise<MiyousheFetchResult<MiyousheDetailedRoster>> {
    const region = regionFromUid(uid);
    const body = JSON.stringify({
      page: 1,
      size: 200,
      is_all: true,
      element_attr_ids: [],
      weapon_cat_ids: [],
      uid,
      region: region.region,
      lang: region.isGlobal ? 'en-us' : 'zh-cn'
    });
    const baseUrl = region.isGlobal ? this.baseUrlGlobal : this.baseUrlCn;
    try {
      const response = await this.request(`${baseUrl}/sync/avatar/list`, {
        method: 'POST',
        headers: {
          cookie,
          'user-agent': region.isGlobal
            ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/111.0.0.0 Safari/537.36'
            : CALCULATOR_USER_AGENT_CN,
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
          DS: signDsV1().header,
          'x-rpc-app_version': MIYOUSHE_APP_VERSION_WEB,
          'x-rpc-client_type': CLIENT_TYPE_WEB,
          'x-rpc-language': region.isGlobal ? 'en-us' : 'zh-cn',
          Referer: region.isGlobal ? 'https://act.hoyolab.com/' : CALCULATOR_REFERER_CN,
          Origin: region.isGlobal ? 'https://act.hoyolab.com' : 'https://webstatic.mihoyo.com',
          ...deviceHeadersFromCookie(cookie)
        },
        body,
        timeoutMs: this.timeoutMs
      });
      let envelope: RawEnvelope;
      try {
        envelope = JSON.parse(response.bodyText) as RawEnvelope;
      } catch {
        return {
          ok: false,
          error: { kind: 'parse', message: '养成计算器返回非 JSON 响应' }
        };
      }
      if (envelope.retcode !== 0) {
        return { ok: false, error: classifyFailure(envelope, response.statusCode) };
      }
      const roster = mapCalculatorRoster(envelope.data);
      if (!roster) {
        return {
          ok: false,
          error: { kind: 'schema-drift', message: '养成计算器同步响应缺少 list 数组' }
        };
      }
      return { ok: true, data: roster };
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'network',
          message: error instanceof Error ? error.message : '养成计算器请求失败'
        }
      };
    }
  }
}
