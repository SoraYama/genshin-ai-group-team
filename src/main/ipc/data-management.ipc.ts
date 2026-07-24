import { z } from 'zod';
import type { DataAreaSummary, DataManagementSummary } from '../../shared/domain.js';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import type { DataManagementService } from '../services/data-management-service.js';
import { registerHandler } from './registry.js';

const scopeSchema = z.enum(['profiles', 'scenarios', 'history', 'service-key']);
const prepareSchema = z.object({ scope: scopeSchema }).strict();
const clearSchema = z
  .object({
    scope: scopeSchema,
    expectedCount: z.number().int().positive(),
    confirmationToken: z.string().trim().min(8).max(128)
  })
  .strict();

export function registerDataManagementIpc({ service }: { service: DataManagementService }): void {
  registerHandler('data-management:summary', async () => publicSummary(await service.getSummary()));
  registerHandler('data-management:prepare-clear', async (payload) => {
    const parsed = prepareSchema.safeParse(payload);
    if (!parsed.success)
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    try {
      return await service.prepareClear(parsed.data.scope);
    } catch (error) {
      throw dataManagementRequestError(error);
    }
  });
  registerHandler('data-management:clear', async (payload) => {
    const parsed = clearSchema.safeParse(payload);
    if (!parsed.success)
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    try {
      const result = await service.clear(parsed.data);
      return { removed: result.removed, summary: publicSummary(result.summary) };
    } catch (error) {
      throw dataManagementRequestError(error);
    }
  });
}

function dataManagementRequestError(error: unknown): IpcError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const ipcCode =
    code === 'DATA_CONFIRMATION_EXPIRED' || code === 'HISTORY_CONFIRMATION_EXPIRED'
      ? IpcErrorCodes.ConfirmationExpired
      : code === 'DATA_SELECTION_CHANGED' || code === 'HISTORY_SELECTION_CHANGED'
        ? IpcErrorCodes.SelectionChanged
        : code === 'DATA_FILE_INSPECTION_FAILED'
          ? IpcErrorCodes.FileInspectionFailed
          : code === 'DATA_NOTHING_TO_CLEAR'
            ? IpcErrorCodes.NothingToClear
            : code === 'HISTORY_IDENTITY_UNKNOWN'
              ? IpcErrorCodes.HistoryIdentityUnknown
              : IpcErrorCodes.Internal;
  return new IpcError(ipcCode, 'Data management request failed');
}

function publicSummary(summary: DataManagementSummary): DataManagementSummary {
  return {
    profiles: publicDataArea(summary.profiles),
    scenarios: {
      ...publicDataArea(summary.scenarios),
      clearableCount: summary.scenarios.clearableCount
    },
    history: publicDataArea(summary.history),
    guideResearch: publicDataArea(summary.guideResearch),
    serviceKey: { count: summary.serviceKey.count }
  };
}

function publicDataArea(summary: DataAreaSummary): DataAreaSummary {
  return {
    count: summary.count,
    ...(summary.sizeBytes === undefined ? {} : { sizeBytes: summary.sizeBytes }),
    ...(summary.updatedAt === undefined ? {} : { updatedAt: summary.updatedAt })
  };
}
