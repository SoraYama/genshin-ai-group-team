import { createHash, randomInt } from 'node:crypto';

// updated: 2026-07-20 — version confirmed against SIMNet's rotating DS table
// and the public Battle Chronicle v6.7.2-gr-cn bundle.
// (https://github.com/UIGF-org/mihoyo-api-collect/blob/main/other/authentication.md).
// When米游社 rotates these salts after a major game version bump, override at runtime via:
//   MIYOUSHE_DS_SALT_V2_WEB=<new-salt> npm start
//   MIYOUSHE_DS_SALT_V2_ANDROID=<new-salt> npm start
//
// 4X salt for web client_type=5 — used by `api-takumi-record.mihoyo.com/game_record/...`.
const SALT_TABLE: Record<string, string> = {
  '5': process.env.MIYOUSHE_DS_SALT_V2_WEB ?? 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs',
  '2': process.env.MIYOUSHE_DS_SALT_V2_ANDROID ?? 'lk1HCqdSWUAvR4Wke4lNFEPFcrubM34I'
};

// Game-record DS2 still uses the X4 salt, while the native app version and
// request profile advance independently. A stale app profile is itself a
// risk-control signal, so keep these values covered by the opt-in live gate.
export const MIYOUSHE_APP_VERSION_WEB = process.env.MIYOUSHE_APP_VERSION_WEB ?? '2.111.0';
export const MIYOUSHE_APP_VERSION_ANDROID = '2.71.1';
export const CLIENT_TYPE_WEB = '5';
export const CLIENT_TYPE_ANDROID = '2';
export const MIYOUSHE_RECORD_TOOL_VERSION =
  process.env.MIYOUSHE_RECORD_TOOL_VERSION ?? 'v6.7.2-gr-cn';
export const MIYOUSHE_RECORD_PAGE = `${MIYOUSHE_RECORD_TOOL_VERSION}_#/ys`;
export const MIYOUSHE_DS_SALT_V1_WEB =
  process.env.MIYOUSHE_DS_SALT_V1_WEB ?? 'ce8dd6509bf20296fceb94793c8c10bd';

export interface DsToken {
  /** Unix seconds */
  ts: number;
  /** 6-character random nonce */
  r: string;
  /** md5 hash component */
  ds: string;
  /** Full `${ts},${r},${ds}` header value */
  header: string;
}

export interface SignParams {
  /** URL-encoded query string without leading '?'. Use empty string for none. */
  query?: string;
  /** Stringified request body. Use empty string for GET / no body. */
  body?: string;
  /**
   * `'5'` web (default) or `'2'` android. The salt + random charset both
   * depend on this — keep it in sync with the `x-rpc-client_type` header
   * you send on the same request.
   */
  clientType?: string;
  /** Explicit override; bypasses the env-aware SALT_TABLE lookup. */
  salt?: string;
  /** Test seam — defaults to Date.now()/1000. */
  nowSeconds?: number;
  /** Test seam — defaults to a random 6-char string. */
  randomString?: string;
}

export interface SignDsV1Params {
  salt?: string;
  nowSeconds?: number;
  randomString?: string;
}

function defaultRandomFor(_clientType: string): string {
  // Per genshin.py / UIGF-org reference, miyoushe DS2 (and DS1) expect `r`
  // to be a 6-digit integer-as-string in the range [100001, 200000]. They
  // verify the FORMAT of r, not just the md5 — so letters-as-r silently
  // fail with retcode 5003 (signature soft-fail, no message).
  const n = 100001 + Math.floor(Math.random() * 100000);
  return String(n);
}

export function resolveSalt(clientType: string): string {
  const salt = SALT_TABLE[clientType];
  if (!salt) {
    throw new Error(`No DS salt registered for client_type=${clientType}`);
  }
  return salt;
}

export function signDsV2(params: SignParams = {}): DsToken {
  const clientType = params.clientType ?? CLIENT_TYPE_WEB;
  const salt = params.salt ?? resolveSalt(clientType);
  const ts = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const r = params.randomString ?? defaultRandomFor(clientType);
  const body = params.body ?? '';
  const query = params.query ?? '';

  const material = `salt=${salt}&t=${ts}&r=${r}&b=${body}&q=${query}`;
  const ds = createHash('md5').update(material).digest('hex');

  return { ts, r, ds, header: `${ts},${r},${ds}` };
}

/** DS1 used by the official enhancement-calculator APIs. */
export function signDsV1(params: SignDsV1Params = {}): DsToken {
  const salt = params.salt ?? MIYOUSHE_DS_SALT_V1_WEB;
  const ts = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const r = params.randomString ?? defaultDs1Random();
  const material = `salt=${salt}&t=${ts}&r=${r}`;
  const ds = createHash('md5').update(material).digest('hex');
  return { ts, r, ds, header: `${ts},${r},${ds}` };
}

function defaultDs1Random(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  while (result.length < 6) {
    const candidate = alphabet.charAt(randomInt(alphabet.length));
    if (!result.includes(candidate)) result += candidate;
  }
  return result;
}
