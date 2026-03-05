import type { AppConfig } from '../config.js';

export interface MiyousheValidationResult {
  ok: boolean;
  retcode?: number;
  message?: string;
  roleCount?: number;
}

export interface MiyousheRole {
  gameUid: string;
  region: string;
  regionName?: string;
  nickname?: string;
  level?: number;
}

export interface MiyousheRoleResult {
  ok: boolean;
  retcode?: number;
  message?: string;
  roles: MiyousheRole[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function validateMiyousheCookie(options: {
  cookie: string;
  config: AppConfig;
  fetchImpl?: typeof fetch;
}): Promise<MiyousheValidationResult> {
  const roleResult = await fetchMiyousheRoles(options);

  return {
    ok: roleResult.ok,
    retcode: roleResult.retcode,
    message: roleResult.message,
    roleCount: roleResult.roles.length
  };
}

export async function fetchMiyousheRoles(options: {
  cookie: string;
  config: AppConfig;
  fetchImpl?: typeof fetch;
}): Promise<MiyousheRoleResult> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(options.config.miyousheRoleUrl, {
    method: 'GET',
    headers: {
      Cookie: options.cookie
    }
  });

  const json = (await response.json()) as unknown;

  if (!isObject(json) || typeof json.retcode !== 'number') {
    return {
      ok: false,
      message: 'Unexpected Miyoushe response',
      roles: []
    };
  }

  const list = Array.isArray(json.data)
    ? json.data
    : isObject(json.data) && Array.isArray(json.data.list)
      ? json.data.list
      : [];

  const roles: MiyousheRole[] = list
    .filter((item): item is Record<string, unknown> => isObject(item))
    .map((item) => ({
      gameUid: typeof item.game_uid === 'string' ? item.game_uid : String(item.game_uid ?? ''),
      region: typeof item.region === 'string' ? item.region : '',
      regionName: typeof item.region_name === 'string' ? item.region_name : undefined,
      nickname: typeof item.nickname === 'string' ? item.nickname : undefined,
      level: typeof item.level === 'number' ? item.level : undefined
    }))
    .filter((item) => item.gameUid.length > 0 && item.region.length > 0);

  return {
    ok: response.status >= 200 && response.status < 300 && json.retcode === 0,
    retcode: json.retcode,
    message: typeof json.message === 'string' ? json.message : undefined,
    roles
  };
}
