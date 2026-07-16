import path from 'node:path';
import { app, safeStorage } from 'electron';
import { AdvisorAgent } from '../services/advisor-agent.js';
import { ConfigService } from '../services/config-service.js';
import { HistoryStore } from '../services/history-store.js';
import { ProfileStore } from '../services/profile-store.js';

// Match package.json `name`, which is the stable safeStorage identity used by
// both dev and packaged builds. The user-facing productName remains separate.
app.setName(process.env.GTA_SAFE_STORAGE_APP_NAME ?? 'genshin-team-advisor');
if (!app.isPackaged && !process.env.GTA_E2E_USER_DATA_DIR) {
  app.setPath('userData', path.join(app.getPath('appData'), 'genshin-team-advisor'));
}

async function run(): Promise<number> {
  await app.whenReady();
  const config = new ConfigService();
  if (!config.getApiKey()) {
    const hasEncryptedKey = config.getPublicView().hasApiKey;
    console.log(
      JSON.stringify({
        gate: 'provider-saved',
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

  const advisor = new AdvisorAgent(config, new ProfileStore(), new HistoryStore());
  const report = await advisor.testConnection();
  console.log(
    JSON.stringify({
      gate: 'provider-saved',
      status: report.ok ? 'passed' : 'failed',
      httpStatus: report.httpStatus,
      latencyMs: report.latencyMs
    })
  );
  return report.ok ? 0 : 1;
}

void run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        gate: 'provider-saved',
        status: 'failed',
        error: error instanceof Error ? error.name : 'Error'
      })
    );
    process.exitCode = 1;
  })
  .finally(() => app.quit());
