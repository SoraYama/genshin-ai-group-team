import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ADVISOR_AGENT_TIMEOUT_MS,
  MAX_ADVISOR_AGENT_TIMEOUT_MS,
  resolveAdvisorAgentTimeoutMs
} from '../../../src/main/services/advisor-agent-timeout.js';

describe('advisor agent timeout budget', () => {
  it('allows the complete multi-stage pipeline 240 seconds by default', () => {
    expect(DEFAULT_ADVISOR_AGENT_TIMEOUT_MS).toBe(240_000);
    expect(resolveAdvisorAgentTimeoutMs()).toBe(240_000);
  });

  it('keeps explicit test overrides bounded between one millisecond and the safe maximum', () => {
    expect(resolveAdvisorAgentTimeoutMs(0)).toBe(1);
    expect(resolveAdvisorAgentTimeoutMs(60_000)).toBe(60_000);
    expect(resolveAdvisorAgentTimeoutMs(300_000)).toBe(MAX_ADVISOR_AGENT_TIMEOUT_MS);
    expect(MAX_ADVISOR_AGENT_TIMEOUT_MS).toBe(240_000);
  });
});
