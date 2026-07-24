import { describe, expect, it } from 'vitest';

import {
  privacySafeResearchText,
  privacySafeResearchUrl
} from '../../../src/main/services/research-privacy.js';

describe('privacySafeResearchText', () => {
  it.each([
    '班尼特提供攻击力加成',
    '生命值提升取决于治疗角色',
    '暴击率需求应结合武器和圣遗物',
    '普通编号 12345678',
    '攻击力: 2000',
    '攻击力: 2000，暴击率: 70%'
  ])('allows ordinary guide prose and fewer than three numeric panel fields: %s', (value) => {
    expect(privacySafeResearchText(value)).toBeDefined();
  });

  it.each([
    '攻击力: 2000，生命值: 25000，暴击率: 70%',
    'ATK: 2000 HP: 25000 CRITICAL RATE: 70%',
    'UID: 123456789',
    'Ｕ\u200bＩＤ：１２３４５６７８９',
    encodeLayers('UID: 123456789', 4),
    'Authorization: Bearer private-token',
    'api_key=sk-private',
    '123456789',
    '这份攻略适用于 123456789',
    'Guide post for １２３４５６７８９',
    encodeLayers('这份攻略适用于 123456789', 4)
  ])('rejects identity, credential, or full-panel material after canonicalization: %s', (value) => {
    expect(privacySafeResearchText(value)).toBeUndefined();
  });
});

describe('privacySafeResearchUrl', () => {
  it.each([
    'https://example.test/articles/%31%32%33%34%35%36%37%38%39',
    'https://example.test/articles/１２３４５６７８９',
    'https://example.test/articles%2F123456789',
    'https://example.test/%2561rticles/123456789',
    'https://example.test/%2e/articles/123456789',
    'https://example.test/Articles/123456789',
    'https://example.test/articles/123456789-extra',
    'https://example.test/not-articles/123456789',
    'https://example.test/articlez/123456789'
  ])(
    'rejects a long article number unless its raw path uses exact literal ASCII segments: %s',
    (url) => {
      expect(privacySafeResearchUrl(url)).toBeUndefined();
    }
  );

  it.each([
    'https://example.test/article/123456789',
    'https://example.test/articles/123456789',
    'https://example.test/guides/articles/123456789/teams'
  ])('allows literal lowercase ASCII article ID path segments: %s', (url) => {
    expect(privacySafeResearchUrl(url)).toBe(url);
  });
});

function encodeLayers(value: string, count: number): string {
  let encoded = value;
  for (let index = 0; index < count; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}
