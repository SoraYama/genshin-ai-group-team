export const IpcErrorCodes = {
  ValidationFailed: 'IPC_VALIDATION_FAILED',
  Unauthorized: 'IPC_UNAUTHORIZED',
  UpstreamUnavailable: 'IPC_UPSTREAM_UNAVAILABLE',
  Internal: 'IPC_INTERNAL',
  ConfirmationExpired: 'IPC_CONFIRMATION_EXPIRED',
  SelectionChanged: 'IPC_SELECTION_CHANGED',
  HistoryIdentityUnknown: 'IPC_HISTORY_IDENTITY_UNKNOWN',
  FileInspectionFailed: 'IPC_FILE_INSPECTION_FAILED',
  NothingToClear: 'IPC_NOTHING_TO_CLEAR'
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
