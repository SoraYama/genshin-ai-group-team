export const MAX_AGENT_PAYLOAD_BYTES = 48 * 1024;

export type AgentPayloadScope =
  | 'pipeline-context'
  | 'compose-prompt'
  | 'repair-prompt'
  | 'strict-stage-prompt'
  | 'profile-tool-result'
  | 'business-tool-result';

export interface AgentPayloadTooLargeDescriptor {
  code: 'AGENT_PAYLOAD_TOO_LARGE';
  scope: AgentPayloadScope;
  maxBytes: number;
  actualBytes: number;
}

export class AgentPayloadTooLargeError extends Error {
  override readonly name: string = 'AgentPayloadTooLargeError';
  readonly code = 'AGENT_PAYLOAD_TOO_LARGE' as const;

  constructor(
    readonly scope: AgentPayloadScope,
    readonly actualBytes: number,
    readonly maxBytes = MAX_AGENT_PAYLOAD_BYTES
  ) {
    super(`AGENT_PAYLOAD_TOO_LARGE:${scope}:${actualBytes}>${maxBytes}`);
  }

  toDescriptor(): AgentPayloadTooLargeDescriptor {
    return {
      code: this.code,
      scope: this.scope,
      maxBytes: this.maxBytes,
      actualBytes: this.actualBytes
    };
  }
}

export function assertAgentPayloadSize(
  serialized: string,
  scope: AgentPayloadScope,
  maxBytes = MAX_AGENT_PAYLOAD_BYTES
): void {
  const actualBytes = Buffer.byteLength(serialized, 'utf8');
  if (actualBytes > maxBytes) {
    throw new AgentPayloadTooLargeError(scope, actualBytes, maxBytes);
  }
}

export function stringifyAgentPayload(
  value: unknown,
  scope: AgentPayloadScope,
  maxBytes = MAX_AGENT_PAYLOAD_BYTES
): string {
  const serialized = JSON.stringify(value);
  assertAgentPayloadSize(serialized, scope, maxBytes);
  return serialized;
}
