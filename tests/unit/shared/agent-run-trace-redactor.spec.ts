import { describe, expect, it } from 'vitest';

import {
  buildTraceSensitiveRegistry,
  canonicalizeTraceText,
  redactTraceSecrets
} from '../../../src/shared/agent-run-trace-redactor.js';

describe('agent run trace redactor', () => {
  it.each([
    ['percent-encoded UID', 'UID%3A%20%31%32%33%34%35%36%37%38%39'],
    ['fullwidth UID', 'ＵＩＤ：１２３４５６７８９'],
    ['default-ignorable UID', 'UID: 1\u200b2\u200b3\u200b4\u200b5\u200b6\u200b7\u200b8\u200b9'],
    ['double-encoded UID', 'UID%253A%2520%2531%2532%2533%2534%2535%2536%2537%2538%2539'],
    ['percent-encoded API secret', 'key=%73%6B%2D%41%70%69%5F%4F%6E%65'],
    ['fullwidth API secret', 'key=ｓｋ－Ａｐｉ＿Ｏｎｅ'],
    ['default-ignorable API secret', 'key=s\u200bk-A\u200bpi_O\u200bne'],
    ['double-encoded API secret', 'key=%2573%256B%252D%2541%2570%2569%255F%254F%256E%2565']
  ])('fails closed for a registered %s canonical form', (_name, raw) => {
    const registry = buildTraceSensitiveRegistry([], ['123456789', 'sk-Api_One']);

    const result = redactTraceSecrets(raw, registry);
    const canonical = canonicalizeTraceText(result.text);
    expect(result.redacted).toBe(true);
    expect(canonical).not.toContain('123456789');
    expect(canonical.toLowerCase()).not.toContain('sk-api_one'.toLowerCase());
  });

  it('uses numeric boundaries for registered UIDs without hiding ordinary damage numbers', () => {
    const registry = buildTraceSensitiveRegistry([], ['123456789']);

    expect(redactTraceSecrets('伤害 1234567890；UID: 123456789', registry).text).toBe(
      '伤害 1234567890；UID: [REDACTED]'
    );
  });
});
