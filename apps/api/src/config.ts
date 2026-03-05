import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

export interface AppConfig {
  port: number;
  requestTimeoutMs: number;
  genshinDbUrl: string;
  enemyDataUrl: string;
  miyousheRoleUrl: string;
  enkaApiUrl: string;
  enkaCharactersMetaUrl: string;
  enkaLocMetaUrl: string;
  profileCacheFile: string;
  recommendationCacheFile: string;
  llmProvider: 'zhipu' | 'custom';
  llmHealthUrl?: string;
  llmChatUrl?: string;
  llmModel: string;
  llmApiKey?: string;
}

let envLoaded = false;

function bootstrapEnv(): void {
  if (envLoaded) {
    return;
  }

  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'apps/api/.env'),
    path.resolve(currentFileDir, '../.env'),
    path.resolve(currentFileDir, '../../.env')
  ];

  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath, override: false });
    }
  }

  envLoaded = true;
}

export function readConfig(): AppConfig {
  bootstrapEnv();

  const port = Number(process.env.PORT ?? '3001');
  const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? '5000');
  const zhipuHealthDefault = 'https://open.bigmodel.cn/api/coding/paas/v4/models';
  const zhipuChatDefault = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
  const llmApiKey = process.env.ZHIPU_API_KEY ?? process.env.ZAI_API_KEY;
  const llmHealthUrl =
    process.env.ZHIPU_HEALTH_URL ??
    process.env.ZAI_HEALTH_URL ??
    (llmApiKey ? zhipuHealthDefault : undefined);
  const llmChatUrl =
    process.env.ZHIPU_CHAT_URL ??
    process.env.ZAI_CHAT_URL ??
    (llmApiKey ? zhipuChatDefault : undefined);

  return {
    port,
    requestTimeoutMs,
    genshinDbUrl:
      process.env.GENSHIN_DB_URL ??
      'https://genshin.jmp.blue/characters',
    enemyDataUrl:
      process.env.ENEMY_DATA_URL ??
      'https://genshin.jmp.blue/enemies',
    miyousheRoleUrl:
      process.env.MIYOUSHE_ROLE_URL ??
      'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hk4e_cn',
    enkaApiUrl: process.env.ENKA_API_URL ?? 'https://enka.network/api/uid',
    enkaCharactersMetaUrl:
      process.env.ENKA_CHARACTERS_META_URL ??
      'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json',
    enkaLocMetaUrl:
      process.env.ENKA_LOC_META_URL ??
      'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/loc.json',
    profileCacheFile:
      process.env.PROFILE_CACHE_FILE ?? path.resolve(process.cwd(), 'apps/api/.cache/profile-cache.json'),
    recommendationCacheFile:
      process.env.RECOMMENDATION_CACHE_FILE ??
      path.resolve(process.cwd(), 'apps/api/.cache/recommendation-cache.json'),
    llmProvider: process.env.LLM_PROVIDER === 'custom' ? 'custom' : 'zhipu',
    llmHealthUrl,
    llmChatUrl,
    llmModel: process.env.LLM_MODEL ?? 'glm-4.5-air',
    llmApiKey
  };
}
