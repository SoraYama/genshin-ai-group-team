import { describe, expect, it } from 'vitest';
import {
  dataClearCopy,
  formatStorageSize,
  settingsLoadPresentation
} from '../../../src/renderer/pages/Settings/settings-presentation.js';

describe('settings presentation', () => {
  it('never invents a storage size', () => {
    expect(formatStorageSize(undefined, 'zh')).toBe('暂未统计');
    expect(formatStorageSize(1536, 'zh')).toBe('1.5 KB');
  });

  it('names every destructive scope and what it preserves', () => {
    expect(dataClearCopy('profiles', 2, 'zh')).toMatchObject({
      title: '清除 2 份角色资料？',
      preserves: expect.stringContaining('推荐记录')
    });
    expect(dataClearCopy('scenarios', 3, 'zh').effect).toContain('下载');
    expect(dataClearCopy('scenarios', 3, 'zh')).toMatchObject({
      effect: '这会清除已下载的挑战资料缓存。',
      preserves: expect.stringContaining('重新取得可验证挑战资料前，可能无法生成本期方案')
    });
    expect(dataClearCopy('scenarios', 3, 'en')).toMatchObject({
      effect: 'This clears the downloaded challenge-data cache.',
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
