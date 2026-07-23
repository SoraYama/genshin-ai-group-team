import { describe, expect, it } from 'vitest';

import { llmConfigInputSchema } from '../../../src/main/ipc/config.ipc.js';

describe('LLM custom header IPC contract', () => {
  it('accepts the complete RFC token name set used by generation', () => {
    expect(
      llmConfigInputSchema.safeParse({
        customHeaders: { 'X_Test!': 'route-value' }
      }).success
    ).toBe(true);
  });

  it('rejects CRLF values before they can be saved or tested', () => {
    expect(
      llmConfigInputSchema.safeParse({
        customHeaders: { 'X-Route': 'safe\r\nAuthorization: injected' }
      }).success
    ).toBe(false);
  });
});
