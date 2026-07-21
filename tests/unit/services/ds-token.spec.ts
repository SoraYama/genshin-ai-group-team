import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CLIENT_TYPE_ANDROID,
  CLIENT_TYPE_WEB,
  resolveSalt,
  signDsV1,
  signDsV2
} from '../../../src/main/services/miyoushe/ds-token.js';

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

describe('signDsV2', () => {
  it('produces a deterministic header for fixed ts+r+inputs (web)', () => {
    const salt = 'TEST_SALT_FOR_WEB_KEYABCDEFGHIJ';
    const token = signDsV2({
      query: 'role_id=123456789&server=cn_gf01',
      body: '',
      clientType: CLIENT_TYPE_WEB,
      salt,
      nowSeconds: 1_715_000_000,
      randomString: 'abcDEF'
    });

    const expectedDs = md5(
      `salt=${salt}&t=1715000000&r=abcDEF&b=&q=role_id=123456789&server=cn_gf01`
    );
    expect(token).toEqual({
      ts: 1_715_000_000,
      r: 'abcDEF',
      ds: expectedDs,
      header: `1715000000,abcDEF,${expectedDs}`
    });
  });

  it('hashes the request body for POST calls', () => {
    const salt = 'POST_BODY_SALT_XXXXXXXXXXXXXXXX1';
    const body = JSON.stringify({ role_id: '123456789', server: 'cn_gf01' });
    const token = signDsV2({
      query: '',
      body,
      clientType: CLIENT_TYPE_WEB,
      salt,
      nowSeconds: 1_715_000_100,
      randomString: 'zzzzzz'
    });
    const expectedDs = md5(`salt=${salt}&t=1715000100&r=zzzzzz&b=${body}&q=`);
    expect(token.ds).toBe(expectedDs);
  });

  it('falls back to the env-configurable SALT_TABLE when no explicit salt is given', () => {
    const web = resolveSalt(CLIENT_TYPE_WEB);
    const android = resolveSalt(CLIENT_TYPE_ANDROID);
    expect(web).toBeTruthy();
    expect(android).toBeTruthy();
    expect(web).not.toBe(android);

    const token = signDsV2({
      query: 'role_id=1',
      body: '',
      clientType: CLIENT_TYPE_WEB,
      nowSeconds: 100,
      randomString: 'rrrrrr'
    });
    const expectedDs = md5(`salt=${web}&t=100&r=rrrrrr&b=&q=role_id=1`);
    expect(token.ds).toBe(expectedDs);
  });

  it('throws on unknown client type', () => {
    expect(() => resolveSalt('99')).toThrowError(/No DS salt/);
  });
});

describe('signDsV1', () => {
  it('uses the calculator web salt without binding request body or query', () => {
    const token = signDsV1({
      salt: 'CALCULATOR_SALT',
      nowSeconds: 1_715_000_200,
      randomString: 'a1b2c3'
    });
    const expectedDs = md5('salt=CALCULATOR_SALT&t=1715000200&r=a1b2c3');
    expect(token).toEqual({
      ts: 1_715_000_200,
      r: 'a1b2c3',
      ds: expectedDs,
      header: `1715000200,a1b2c3,${expectedDs}`
    });
  });
});
