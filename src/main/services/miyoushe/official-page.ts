const OFFICIAL_RECORD_PAGE =
  'https://webstatic.mihoyo.com/app/community-game-records/index.html';

export type OfficialRecordResponseKind = 'index' | 'list' | 'detail';
export type OfficialVerificationResponseKind = 'create' | 'verify';

export interface OfficialRosterUrlInput {
  communityUid: string;
  gameUid: string;
  region: string;
}

/**
 * Build the public-web variant of MiHoYo's own “全部获得角色” page.
 * `uid` is the community account id while `role_id` is the in-game UID;
 * conflating them makes the SPA render without ever requesting roster data.
 */
export function buildOfficialRosterUrl(input: OfficialRosterUrlInput): string {
  const pageQuery = new URLSearchParams({
    bbs_auth_required: 'true',
    bbs_presentation_style: 'fullscreen',
    gid: '2',
    uid: input.communityUid
  });
  const routeQuery = new URLSearchParams({
    role_id: input.gameUid,
    server: input.region
  });
  return `${OFFICIAL_RECORD_PAGE}?${pageQuery.toString()}#/ys/role/all?${routeQuery.toString()}`;
}

/** Match both the public H5 (`/game_record/genshin`) and app webview form. */
export function classifyOfficialRecordUrl(value: string): OfficialRecordResponseKind | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api-takumi-record.mihoyo.com') {
    return undefined;
  }
  const match = url.pathname.match(
    /^\/game_record\/(?:app\/)?genshin\/api\/(index|character\/list|character\/detail)$/
  );
  if (!match) return undefined;
  if (match[1] === 'index') return 'index';
  return match[1] === 'character/list' ? 'list' : 'detail';
}

export function classifyOfficialVerificationUrl(
  value: string
): OfficialVerificationResponseKind | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api-takumi-record.mihoyo.com') {
    return undefined;
  }
  if (url.pathname === '/game_record/card/wapi/createVerification') return 'create';
  if (url.pathname === '/game_record/card/wapi/verifyVerification') return 'verify';
  return undefined;
}

/**
 * The official SPA normally replaces itself with an app-download landing page
 * outside the native miHoYoBBS webview. Its own `isDebug` switch disables only
 * that landing page; requests still go to the production API base.
 */
export const OFFICIAL_PAGE_PRELOAD_SCRIPT = `
  try {
    localStorage.setItem('isDebug', '1');
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (window.chrome === undefined) window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en']
    });
  } catch (_) {}
`;
