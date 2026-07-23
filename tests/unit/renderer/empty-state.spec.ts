import { describe, expect, it } from 'vitest';
import { emptyStateCopy } from '../../../src/renderer/components/ui/empty-state-copy.js';

describe('reusable empty state copy', () => {
  it('covers empty history, unavailable data, and missing service configuration', () => {
    expect(emptyStateCopy('history', 'zh')).toMatchObject({
      title: '还没有推荐记录',
      actionHint: expect.stringContaining('挑战配队')
    });
    expect(emptyStateCopy('offline', 'zh')).toMatchObject({
      title: '挑战资料暂不可用',
      actionHint: expect.stringContaining('旧方案')
    });
    expect(emptyStateCopy('service', 'en')).toMatchObject({
      title: 'Smart service is not configured'
    });
  });
});
