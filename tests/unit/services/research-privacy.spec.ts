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
    ['encoded digits', 'https://example.test/articles/%31%32%33%34%35%36%37%38%39'],
    ['fullwidth digits', 'https://example.test/articles/１２３４５６７８９'],
    ['encoded slash', 'https://example.test/articles%2F123456789'],
    ['double-encoded label', 'https://example.test/%2561rticles/123456789'],
    ['encoded dot segment', 'https://example.test/%2e/articles/123456789'],
    ['backslash separator', 'https://example.test/articles\\123456789'],
    ['backslash after authority', 'https://example.test\\articles/123456789'],
    ['private segment before dot traversal', 'https://example.test/uid/../articles/123456789'],
    ['current dot segment', 'https://example.test/./articles/123456789'],
    ['parent dot segment', 'https://example.test/guides/../articles/123456789'],
    ['consecutive slash', 'https://example.test/guides//articles/123456789'],
    ['terminal current dot', 'https://example.test/articles/123456789/.'],
    ['terminal parent dot', 'https://example.test/articles/123456789/..'],
    ['tab in path', 'https://example.test/articles/\t123456789'],
    ['newline in path', 'https://example.test/articles/\n123456789'],
    ['carriage return in path', 'https://example.test/articles/\r123456789'],
    ['tab in authority', 'https://example.test\t/articles/123456789'],
    ['uppercase label', 'https://example.test/Articles/123456789'],
    ['numeric suffix', 'https://example.test/articles/123456789-extra'],
    ['similar segment', 'https://example.test/not-articles/123456789'],
    ['similar label', 'https://example.test/articlez/123456789'],
    ['trailing dot', 'https://example.test/articles/123456789.'],
    ['consecutive trailing dots', 'https://example.test/articles/123456789..']
  ])(
    'rejects a long article number unless its raw path uses exact literal ASCII segments: %s',
    (_label, url) => {
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
