export function localizeError<K extends string>(
  error: unknown,
  _locale: 'zh-CN' | 'en-US',
  t: (key: K) => string,
  fallback: K
): string {
  const code = getErrorCode(error);
  if (!code && error instanceof Error && error.message) return error.message;
  const key = {
    IPC_VALIDATION_FAILED: 'common.error.validation',
    IPC_UNAUTHORIZED: 'common.error.unauthorized',
    IPC_UPSTREAM_UNAVAILABLE: 'common.error.upstream',
    IPC_INTERNAL: 'common.error.internal',
    IPC_CONFIRMATION_EXPIRED: 'common.error.confirmationExpired',
    IPC_SELECTION_CHANGED: 'common.error.selectionChanged',
    IPC_HISTORY_IDENTITY_UNKNOWN: 'common.error.historyIdentity',
    IPC_FILE_INSPECTION_FAILED: 'common.error.fileInspection',
    IPC_NOTHING_TO_CLEAR: 'common.error.nothingToClear'
  }[code];
  return t((key ?? fallback) as K);
}

export function getErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
}

export function destructiveErrorRecovery(
  code: string,
  locale: 'zh-CN' | 'en-US'
): { kind: 'retry' | 'reconfirm' | 'none'; label: string } {
  if (code === 'IPC_NOTHING_TO_CLEAR') return { kind: 'none', label: '' };
  if (code === 'IPC_CONFIRMATION_EXPIRED' || code === 'IPC_SELECTION_CHANGED') {
    return {
      kind: 'reconfirm',
      label: locale === 'en-US' ? 'Check again and reconfirm' : '重新检查并确认'
    };
  }
  return {
    kind: 'retry',
    label: locale === 'en-US' ? 'Check again' : '重新检查'
  };
}
