import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../../shared/domain.js';
import type {
  LlmConfigInput,
  LlmConfigPublicView,
  PublicConfig
} from '../../shared/domain.js';

interface PersistedSchema {
  llm: {
    encryptedApiKey?: string;
    baseUrl?: string;
    model?: string;
    encryptedCustomHeaders?: Record<string, string>;
    /** @deprecated v1 migration source; values are encrypted on first access. */
    customHeaders?: Record<string, string>;
  };
  monthlyUsage?: {
    month: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

const DEFAULTS: PersistedSchema = {
  llm: {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL
  }
};

export class ConfigService {
  private readonly store: Store<PersistedSchema>;

  constructor() {
    this.store = new Store<PersistedSchema>({
      name: 'config',
      defaults: DEFAULTS
    });
    this.migrateLegacyCustomHeaders();
  }

  getApiKey(): string | undefined {
    const encrypted = this.store.get('llm').encryptedApiKey;
    if (!encrypted) {
      return undefined;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return undefined;
    }

    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return undefined;
    }
  }

  getBaseUrl(): string {
    return this.store.get('llm').baseUrl ?? DEFAULT_BASE_URL;
  }

  getModel(): string {
    return this.store.get('llm').model ?? DEFAULT_MODEL;
  }

  getCustomHeaders(): Record<string, string> {
    if (!safeStorage.isEncryptionAvailable()) {
      return {};
    }
    const llm = this.store.get('llm');
    const encryptedHeaders = llm.encryptedCustomHeaders ?? {};
    const decrypted = this.decryptHeaders(encryptedHeaders);

    if (llm.customHeaders && Object.keys(llm.customHeaders).length > 0) {
      return { ...llm.customHeaders, ...decrypted };
    }

    return decrypted;
  }

  setLlm(input: LlmConfigInput): void {
    const llm = this.store.get('llm');
    const next: PersistedSchema['llm'] = { ...llm };

    if (input.apiKey && input.apiKey.length > 0) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'safeStorage encryption is not available on this platform. ' +
            'Please ensure your OS keychain / Credential Vault is unlocked.'
        );
      }
      next.encryptedApiKey = safeStorage.encryptString(input.apiKey).toString('base64');
    }

    if (input.baseUrl !== undefined) {
      next.baseUrl = input.baseUrl.trim() || DEFAULT_BASE_URL;
    }

    if (input.model !== undefined) {
      next.model = input.model.trim() || DEFAULT_MODEL;
    }

    if (input.customHeaders !== undefined) {
      if (Object.keys(input.customHeaders).length > 0) {
        next.encryptedCustomHeaders = this.encryptHeaders(input.customHeaders);
      } else {
        delete next.encryptedCustomHeaders;
      }
      delete next.customHeaders;
    }

    this.store.set('llm', next);
  }

  clearLlm(): void {
    this.store.set('llm', { ...DEFAULTS.llm });
  }

  getPublicView(): LlmConfigPublicView {
    const llm = this.store.get('llm');
    return {
      hasApiKey: Boolean(llm.encryptedApiKey),
      baseUrl: llm.baseUrl ?? DEFAULT_BASE_URL,
      model: llm.model ?? DEFAULT_MODEL,
      customHeaderKeys: Array.from(
        new Set([
          ...Object.keys(llm.encryptedCustomHeaders ?? {}),
          ...Object.keys(llm.customHeaders ?? {})
        ])
      ).sort()
    };
  }

  getPublicConfig(): PublicConfig {
    return {
      llm: this.getPublicView(),
      appVersion: app.getVersion(),
      monthlyUsage: this.getMonthlyUsage()
    };
  }

  recordUsage(inputTokens: number, outputTokens: number, estimatedCostUsd = 0): void {
    const month = new Date().toISOString().slice(0, 7);
    const current = this.getMonthlyUsage();
    this.store.set('monthlyUsage', {
      month,
      inputTokens: (current.month === month ? current.inputTokens : 0) + Math.max(0, inputTokens),
      outputTokens:
        (current.month === month ? current.outputTokens : 0) + Math.max(0, outputTokens),
      estimatedCostUsd:
        (current.month === month ? current.estimatedCostUsd : 0) +
        Math.max(0, estimatedCostUsd)
    });
  }

  private getMonthlyUsage(): NonNullable<PersistedSchema['monthlyUsage']> {
    const month = new Date().toISOString().slice(0, 7);
    const usage = this.store.get('monthlyUsage');
    return usage?.month === month
      ? usage
      : { month, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }

  private encryptHeaders(headers: Record<string, string>): Record<string, string> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'safeStorage encryption is not available on this platform. ' +
          'Please ensure your OS keychain / Credential Vault is unlocked.'
      );
    }

    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        safeStorage.encryptString(value).toString('base64')
      ])
    );
  }

  private migrateLegacyCustomHeaders(): void {
    const llm = this.store.get('llm');
    if (
      !llm.customHeaders ||
      Object.keys(llm.customHeaders).length === 0 ||
      !safeStorage.isEncryptionAvailable()
    ) {
      return;
    }

    const migrated = {
      ...llm.customHeaders,
      ...this.decryptHeaders(llm.encryptedCustomHeaders ?? {})
    };
    const next = { ...llm, encryptedCustomHeaders: this.encryptHeaders(migrated) };
    delete next.customHeaders;
    this.store.set('llm', next);
  }

  private decryptHeaders(headers: Record<string, string>): Record<string, string> {
    if (!safeStorage.isEncryptionAvailable()) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(headers).flatMap(([key, value]) => {
        try {
          return [[key, safeStorage.decryptString(Buffer.from(value, 'base64'))]];
        } catch {
          return [];
        }
      })
    );
  }
}
