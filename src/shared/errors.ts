export const IpcErrorCodes = {
  ValidationFailed: 'IPC_VALIDATION_FAILED',
  Unauthorized: 'IPC_UNAUTHORIZED',
  UpstreamUnavailable: 'IPC_UPSTREAM_UNAVAILABLE',
  Internal: 'IPC_INTERNAL'
} as const;

export type IpcErrorCode = (typeof IpcErrorCodes)[keyof typeof IpcErrorCodes];

export class IpcError extends Error {
  override readonly name = 'IpcError';
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
  }

  toJSON(): { code: IpcErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}
