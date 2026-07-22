import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() }
}));

vi.mock('../../../src/main/services/miyoushe-client.js', () => ({
  MIYOUSHE_UA: 'test-agent'
}));

import {
  buildVerificationBody,
  parseCreatedChallenge,
  parseVerifiedChallenge
} from '../../../src/main/services/miyoushe/verification.js';

describe('MiHoYo natural 1034 verification payloads', () => {
  it('normalizes the Geetest validation body expected by verifyVerification', () => {
    expect(
      buildVerificationBody({
        geetest_challenge: 'rotated-challenge',
        geetest_validate: 'validate-token',
        geetest_seccode: 'validate-token'
      })
    ).toEqual({
      geetest_challenge: 'rotated-challenge',
      geetest_validate: 'validate-token',
      geetest_seccode: 'validate-token|jordan'
    });
  });

  it('accepts only complete successful createVerification envelopes', () => {
    expect(
      parseCreatedChallenge(200, {
        retcode: 0,
        data: { gt: 'gt', challenge: 'challenge', new_captcha: 1, success: 1 }
      })
    ).toEqual({ gt: 'gt', challenge: 'challenge', new_captcha: 1, success: 1 });
    expect(
      parseCreatedChallenge(200, {
        retcode: 0,
        data: { gt: 'gt', challenge: 'challenge', new_captcha: 1 }
      })
    ).toBeUndefined();
    expect(
      parseCreatedChallenge(500, {
        retcode: 0,
        data: { gt: 'gt', challenge: 'challenge', new_captcha: 1, success: 1 }
      })
    ).toBeUndefined();
  });

  it('accepts only an explicit final challenge from verifyVerification', () => {
    expect(
      parseVerifiedChallenge(200, { retcode: 0, data: { challenge: 'final-challenge' } })
    ).toBe('final-challenge');
    expect(parseVerifiedChallenge(200, { retcode: 0, data: {} })).toBeUndefined();
    expect(
      parseVerifiedChallenge(200, {
        retcode: 10306,
        data: { challenge: 'must-not-be-used' }
      })
    ).toBeUndefined();
  });
});
