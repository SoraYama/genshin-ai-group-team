import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() }
}));

vi.mock('../../../src/main/services/miyoushe-client.js', () => ({
  MIYOUSHE_UA: 'test-agent'
}));

import { buildVerificationBody } from '../../../src/main/services/miyoushe/verification.js';

describe('buildVerificationBody', () => {
  it('uses the Geetest response challenge and normalizes the seccode', () => {
    expect(
      buildVerificationBody({
        geetest_challenge: 'rotated-challenge',
        geetest_validate: 'validate',
        geetest_seccode: 'validate'
      })
    ).toEqual({
      geetest_challenge: 'rotated-challenge',
      geetest_validate: 'validate',
      geetest_seccode: 'validate|jordan'
    });
  });

  it('preserves a complete Geetest seccode', () => {
    expect(
      buildVerificationBody({
        geetest_challenge: 'challenge',
        geetest_validate: 'validate',
        geetest_seccode: 'validate|jordan'
      }).geetest_seccode
    ).toBe('validate|jordan');
  });
});
