import { describe, expect, it } from 'vitest';
import {
  dataClearCopy,
  formatStorageSize
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
    expect(dataClearCopy('history', 4, 'zh').effect).toContain('4 条');
    expect(dataClearCopy('service-key', 1, 'en').title).toBe('Clear the saved service key?');
  });
});
