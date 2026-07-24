import { describe, expect, it } from 'vitest';

import { privacySafeResearchText } from '../../../src/main/services/research-privacy.js';

describe('privacySafeResearchText', () => {
  it.each([
    '班尼特提供攻击力加成',
    '生命值提升取决于治疗角色',
    '暴击率需求应结合武器和圣遗物',
    '公开攻略文章 123456789',
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
    '123456789'
  ])('rejects identity, credential, or full-panel material after canonicalization: %s', (value) => {
    expect(privacySafeResearchText(value)).toBeUndefined();
  });
});

function encodeLayers(value: string, count: number): string {
  let encoded = value;
  for (let index = 0; index < count; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}
