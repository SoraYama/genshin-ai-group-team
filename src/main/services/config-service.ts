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
    customHeaders?: Record<string, string>;
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
    return this.store.get('llm').customHeaders ?? {};
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
      next.customHeaders = input.customHeaders;
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
      customHeaderKeys: Object.keys(llm.customHeaders ?? {})
    };
  }

  getPublicConfig(): PublicConfig {
    return {
      llm: this.getPublicView(),
      appVersion: app.getVersion()
    };
  }
}
