import { describe, expect, it } from 'vitest';
import {
  buildOfficialRosterUrl,
  classifyOfficialRecordUrl,
  classifyOfficialVerificationUrl,
  OFFICIAL_PAGE_PRELOAD_SCRIPT
} from '../../../src/main/services/miyoushe/official-page.js';

describe('MiHoYo official roster page', () => {
  it('opens the all-owned-character route with account and game identity separated', () => {
    const url = buildOfficialRosterUrl({
      communityUid: '123456789',
      gameUid: '500000001',
      region: 'cn_qd01'
    });

    expect(url).toContain('uid=123456789');
    expect(url).toContain('gid=2');
    expect(url).toContain('#/ys/role/all?');
    expect(url).toContain('role_id=500000001');
    expect(url).toContain('server=cn_qd01');
  });

  it('recognizes both public-web and app-webview record endpoints', () => {
    expect(
      classifyOfficialRecordUrl(
        'https://api-takumi-record.mihoyo.com/game_record/genshin/api/character/list'
      )
    ).toBe('list');
    expect(
      classifyOfficialRecordUrl(
        'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/character/detail'
      )
    ).toBe('detail');
    expect(
      classifyOfficialRecordUrl(
        'https://api-takumi-record.mihoyo.com/game_record/genshin/api/index'
      )
    ).toBe('index');
    expect(classifyOfficialRecordUrl('https://evil.example/game_record/genshin/api/index')).toBe(
      undefined
    );
  });

  it('recognizes only official verification endpoints', () => {
    expect(
      classifyOfficialVerificationUrl(
        'https://api-takumi-record.mihoyo.com/game_record/card/wapi/createVerification'
      )
    ).toBe('create');
    expect(
      classifyOfficialVerificationUrl(
        'https://api-takumi-record.mihoyo.com/game_record/card/wapi/verifyVerification'
      )
    ).toBe('verify');
    expect(
      classifyOfficialVerificationUrl(
        'https://evil.example/game_record/card/wapi/createVerification'
      )
    ).toBe(undefined);
  });

  it('bypasses the official SPA landing page before application startup', () => {
    expect(OFFICIAL_PAGE_PRELOAD_SCRIPT).toContain("localStorage.setItem('isDebug', '1')");
  });

});
