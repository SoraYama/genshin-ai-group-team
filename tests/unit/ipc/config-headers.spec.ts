import { describe, expect, it } from 'vitest';

import { llmConfigInputSchema } from '../../../src/main/ipc/config.ipc.js';

describe('LLM custom header IPC contract', () => {
  it('accepts the complete RFC token name set used by generation', () => {
    expect(
      llmConfigInputSchema.safeParse({
        customHeaders: { "!#$%&'*+-.^_`|~012AZaz": 'route-value' }
      }).success
    ).toBe(true);
  });

  it.each([
    ['NUL', 'safe\u0000tail'],
    ['horizontal tab', 'safe\u0009tail'],
    ['unit separator', 'safe\u001ftail'],
    ['DEL', 'safe\u007ftail'],
    ['C1 control', 'safe\u0085tail'],
    ['line separator', 'safe\u2028tail'],
    ['bidi override', 'safe\u202etail'],
    ['lone surrogate', 'safe\ud800tail'],
    ['CRLF', 'safe\r\nAuthorization: injected']
  ])('rejects %s before the value can be saved or tested', (_label, value) => {
    expect(
      llmConfigInputSchema.safeParse({
        customHeaders: { 'X-Route': value }
      }).success
    ).toBe(false);
  });
});
