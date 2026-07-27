import path from 'node:path';
import { app, safeStorage } from 'electron';

import { ConfigService } from '../services/config-service.js';
import {
  ZhipuWebSearchClient,
  supportsZhipuWebSearch
} from '../services/zhipu-web-search-client.js';

app.setName(process.env.GTA_SAFE_STORAGE_APP_NAME ?? 'genshin-team-advisor');
if (!app.isPackaged && !process.env.GTA_E2E_USER_DATA_DIR) {
  app.setPath('userData', path.join(app.getPath('appData'), 'genshin-team-advisor'));
}

async function run(): Promise<number> {
  await app.whenReady();
  const config = new ConfigService();
  const apiKey = config.getApiKey();
  if (!apiKey) {
    const hasEncryptedKey = config.getPublicView().hasApiKey;
    console.log(
      JSON.stringify({
        gate: 'zhipu-search-saved',
        status: 'skipped',
        reason: hasEncryptedKey
          ? safeStorage.isEncryptionAvailable()
            ? 'saved-key-decrypt-failed'
            : 'safe-storage-unavailable'
          : 'missing-saved-api-key'
      })
    );
    return 0;
  }
  if (!supportsZhipuWebSearch(config.getBaseUrl())) {
    console.log(
      JSON.stringify({
        gate: 'zhipu-search-saved',
        status: 'skipped',
        reason: 'provider-is-not-zhipu'
      })
    );
    return 0;
  }
  const query = '原神 千织 配队 攻略';
  const results = await new ZhipuWebSearchClient({
    apiKey,
    domain: 'www.hoyolab.com'
  }).search(query);
  console.log(
    JSON.stringify({
      gate: 'zhipu-search-saved',
      status: 'passed',
      query,
      count: results.length,
      results: results.map(({ title, url, publishedAt }) => ({
        title,
        url,
        ...(publishedAt ? { publishedAt } : {})
      }))
    })
  );
  return 0;
}

void run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        gate: 'zhipu-search-saved',
        status: 'failed',
        error: error instanceof Error ? error.message : 'Search failed.'
      })
    );
    process.exitCode = 1;
  })
  .finally(() => app.quit());
