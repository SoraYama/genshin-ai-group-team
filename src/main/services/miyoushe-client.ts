import { request } from 'undici';
import type { BindCookieResult, MiyousheRole } from '../../shared/domain.js';

export interface MiyousheClientOptions {
  rolesUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_ROLES_URL =
  'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hk4e_cn';
const DEFAULT_TIMEOUT_MS = 8_000;

export const MIYOUSHE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) miHoYoBBS/2.55.1';

const DEFAULT_UA = MIYOUSHE_UA;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class MiyousheClient {
  private readonly rolesUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: MiyousheClientOptions = {}) {
    this.rolesUrl = options.rolesUrl ?? DEFAULT_ROLES_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_UA;
  }

  async fetchRoles(cookie: string): Promise<BindCookieResult> {
    const trimmed = cookie.trim();
    if (trimmed.length < 10) {
      return { ok: false, message: 'Cookie 长度异常', roles: [] };
    }

    try {
      const { statusCode, body } = await request(this.rolesUrl, {
        method: 'GET',
        headers: {
          cookie: trimmed,
          'user-agent': this.userAgent,
          accept: 'application/json'
        },
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs
      });

      const text = await body.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return {
          ok: false,
          message: '米游社返回非 JSON 响应',
          roles: []
        };
      }

      if (!isObject(json) || typeof json.retcode !== 'number') {
        return { ok: false, message: '米游社响应格式异常', roles: [] };
      }

      const list = isObject(json.data)
        ? Array.isArray(json.data.list)
          ? json.data.list
          : []
        : Array.isArray(json.data)
          ? json.data
          : [];

      const roles: MiyousheRole[] = list
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => ({
          gameUid:
            typeof item.game_uid === 'string'
              ? item.game_uid
              : typeof item.game_uid === 'number'
                ? String(item.game_uid)
                : '',
          region: typeof item.region === 'string' ? item.region : '',
          regionName: typeof item.region_name === 'string' ? item.region_name : undefined,
          nickname: typeof item.nickname === 'string' ? item.nickname : undefined,
          level: typeof item.level === 'number' ? item.level : undefined
        }))
        .filter((role) => role.gameUid.length > 0 && role.region.length > 0);

      const ok = statusCode >= 200 && statusCode < 300 && json.retcode === 0 && roles.length > 0;

      return {
        ok,
        retcode: json.retcode,
        message: typeof json.message === 'string' ? json.message : undefined,
        roles
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Miyoushe request failed',
        roles: []
      };
    }
  }
}
