import { describe, expect, it } from 'vitest';
import {
  dataClearCopy,
  formatStorageSize,
  hasClearableChallengeCache,
  settingsLoadPresentation
} from '../../../src/renderer/pages/Settings/settings-presentation.js';

describe('settings presentation', () => {
  it('never invents a storage size', () => {
    expect(formatStorageSize(undefined, 'zh')).toBe('暂未统计');
    expect(formatStorageSize(1536, 'zh')).toBe('1.5 KB');
  });

  it('keeps challenge clearing available for a zero-entry physical guide cache', () => {
    expect(
      hasClearableChallengeCache({
        scenarios: { count: 3, clearableCount: 0, sizeBytes: 0 },
        guideResearch: { count: 0, sizeBytes: 17 }
      })
    ).toBe(true);
    expect(
      hasClearableChallengeCache({
        scenarios: { count: 3, clearableCount: 0, sizeBytes: 0 },
        guideResearch: { count: 0, sizeBytes: 0 }
      })
    ).toBe(true);
    expect(
      hasClearableChallengeCache({
        scenarios: { count: 3, clearableCount: 0, sizeBytes: 0 },
        guideResearch: { count: 0 }
      })
    ).toBe(false);
  });

  it('names every destructive scope and what it preserves', () => {
    expect(dataClearCopy('profiles', 2, 'zh')).toMatchObject({
      title: '清除 2 份角色资料？',
      preserves: expect.stringContaining('推荐记录')
    });
    expect(dataClearCopy('scenarios', 3, 'zh').effect).toContain('下载');
    expect(dataClearCopy('scenarios', 3, 'zh')).toMatchObject({
      effect: expect.stringContaining('临时攻略'),
      preserves: expect.stringContaining('重新取得可验证挑战资料前，可能无法生成本期方案')
    });
    expect(dataClearCopy('scenarios', 3, 'en')).toMatchObject({
      effect: expect.stringContaining('temporary guide'),
      preserves: expect.stringContaining(
        'Current-cycle plans may be unavailable until verifiable challenge data is downloaded again'
      )
    });
    expect(dataClearCopy('history', 4, 'zh').effect).toContain('4 条');
    expect(dataClearCopy('service-key', 1, 'en').title).toBe('Clear the saved service key?');
  });

  it('turns a load failure into a retryable state instead of endless loading', () => {
    expect(settingsLoadPresentation('', 'zh')).toEqual({
      state: 'loading',
      loadingLabel: '正在读取…'
    });
    expect(settingsLoadPresentation('读取失败', 'zh')).toEqual({
      state: 'error',
      retryLabel: '重新读取设置'
    });
  });
});
