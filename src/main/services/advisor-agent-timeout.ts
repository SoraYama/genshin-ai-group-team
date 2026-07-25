export const DEFAULT_ADVISOR_AGENT_TIMEOUT_MS = 240_000;
export const MAX_ADVISOR_AGENT_TIMEOUT_MS = 240_000;

export function resolveAdvisorAgentTimeoutMs(value?: number): number {
  return Math.max(
    1,
    Math.min(value ?? DEFAULT_ADVISOR_AGENT_TIMEOUT_MS, MAX_ADVISOR_AGENT_TIMEOUT_MS)
  );
}
