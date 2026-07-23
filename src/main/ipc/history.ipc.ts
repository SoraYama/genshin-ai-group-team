import { z } from 'zod';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import type { HistoryStore } from '../services/history-store.js';
import { registerHandler } from './registry.js';

const listSchema = z.object({
  uid: z.string().optional(),
  source: z.enum(['llm', 'fallback']).optional(),
  enemyKeyword: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional()
});

const deleteSchema = z.object({
  id: z.string().min(8, '历史 id 异常')
});

const abyssListSchema = z.object({
  uid: z
    .string()
    .regex(/^\d{9}$/)
    .optional()
});

const clearSchema = z
  .object({
    uid: z.string().optional(),
    source: z.enum(['llm', 'fallback']).optional(),
    enemyKeyword: z.string().optional()
  })
  .refine((value) => Boolean(value.uid || value.source || value.enemyKeyword), {
    message: '至少需要指定 uid / source / enemyKeyword 之一，避免误清空全部历史'
  });

const deleteScopeSelectionSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('group'),
      uid: z.string().regex(/^\d{9}$/),
      mode: z.enum(['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater']),
      scenarioId: z.string().trim().min(1).max(256)
    })
    .strict(),
  z
    .object({
      scope: z.literal('uid'),
      uid: z.string().regex(/^\d{9}$/)
    })
    .strict(),
  z
    .object({
      scope: z.literal('all')
    })
    .strict()
]);
const deleteScopeSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('group'),
      uid: z.string().regex(/^\d{9}$/),
      mode: z.enum(['spiral-abyss', 'stygian-onslaught', 'imaginarium-theater']),
      scenarioId: z.string().trim().min(1).max(256),
      expectedCount: z.number().int().positive(),
      confirmationToken: z.string().trim().min(8).max(128)
    })
    .strict(),
  z
    .object({
      scope: z.literal('uid'),
      uid: z.string().regex(/^\d{9}$/),
      expectedCount: z.number().int().positive(),
      confirmationToken: z.string().trim().min(8).max(128)
    })
    .strict(),
  z
    .object({
      scope: z.literal('all'),
      expectedCount: z.number().int().positive(),
      confirmationToken: z.string().trim().min(8).max(128)
    })
    .strict()
]);

export interface HistoryIpcDeps {
  history: HistoryStore;
}

export function registerHistoryIpc({ history }: HistoryIpcDeps): void {
  registerHandler('history:list', async (payload) => {
    const parsed = listSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    return history.query(parsed.data);
  });

  registerHandler('history:delete', async (payload) => {
    const parsed = deleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    return { ok: history.removeById(parsed.data.id) };
  });

  registerHandler('history:abyss-list', async (payload) => {
    const parsed = abyssListSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    return history.queryAbyss(parsed.data);
  });

  registerHandler('history:abyss-delete', async (payload) => {
    const parsed = deleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    return { ok: history.removeAbyssById(parsed.data.id) };
  });

  registerHandler('history:stygian-list', async (payload) => {
    const parsed = abyssListSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    return history.queryStygian(parsed.data);
  });

  registerHandler('history:stygian-delete', async (payload) => {
    const parsed = deleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    return { ok: history.removeStygianById(parsed.data.id) };
  });

  registerHandler('history:theater-list', async (payload) => {
    const parsed = abyssListSchema.safeParse(payload ?? {});
    if (!parsed.success)
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    return history.queryTheater(parsed.data);
  });

  registerHandler('history:theater-delete', async (payload) => {
    const parsed = deleteSchema.safeParse(payload);
    if (!parsed.success)
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    return { ok: history.removeTheaterById(parsed.data.id) };
  });

  registerHandler('history:prepare-delete-scope', async (payload) => {
    const parsed = deleteScopeSelectionSchema.safeParse(payload);
    if (!parsed.success)
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    return history.getChallengeScopeConfirmation(parsed.data);
  });

  registerHandler('history:delete-scope', async (payload) => {
    const parsed = deleteScopeSchema.safeParse(payload);
    if (!parsed.success)
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    try {
      return { removed: history.removeChallengeScope(parsed.data) };
    } catch (error) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        error instanceof Error ? error.message : 'History selection changed'
      );
    }
  });

  registerHandler('history:clear', async (payload) => {
    const parsed = clearSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    try {
      const removed = history.removeMany(parsed.data);
      return { removed };
    } catch (error) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        error instanceof Error ? error.message : 'history clear failed'
      );
    }
  });
}
