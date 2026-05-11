import { z } from 'zod';
import { IpcError, IpcErrorCodes } from '../../shared/errors.js';
import type { ConfigService } from '../services/config-service.js';
import type { AdvisorAgent } from '../services/advisor-agent.js';
import { registerHandler } from './registry.js';

const llmConfigInputSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z
    .string()
    .url('baseUrl 必须是合法的 URL')
    .optional()
    .or(z.literal('')),
  model: z.string().trim().optional(),
  customHeaders: z.record(z.string()).optional()
});

export interface ConfigIpcDeps {
  config: ConfigService;
  advisor: AdvisorAgent;
}

export function registerConfigIpc({ config, advisor }: ConfigIpcDeps): void {
  registerHandler('config:get-public', async () => {
    return config.getPublicConfig();
  });

  registerHandler('config:set-llm', async (payload) => {
    const parsed = llmConfigInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError(
        IpcErrorCodes.ValidationFailed,
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }

    const { apiKey, baseUrl, model, customHeaders } = parsed.data;
    const trimmedKey = apiKey?.trim();

    config.setLlm({
      apiKey: trimmedKey && trimmedKey.length > 0 ? trimmedKey : undefined,
      baseUrl: baseUrl === '' ? undefined : baseUrl,
      model,
      customHeaders
    });

    return { ok: true } as const;
  });

  registerHandler('config:test-llm', async () => {
    return advisor.testConnection();
  });

  registerHandler('config:clear-llm', async () => {
    config.clearLlm();
    return { ok: true } as const;
  });
}
