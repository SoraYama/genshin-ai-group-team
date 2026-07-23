import { createPublicKey } from 'node:crypto';
import { readFile as nodeReadFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { ScenarioPublicationSnapshot } from './contracts.js';
import type { ScenarioModeV2 } from './contracts.js';
import { HttpScenarioPublicationReader, type ScenarioHttpRequest } from './readers.js';
import { ScenePublicationService } from './service.js';
import { FileScenarioPublicationStorage } from './storage.js';
import type { ScenarioPublicKeyRing } from './publication.js';

const publicKeyMapSchema = z
  .record(z.string().trim().min(1), z.string().trim().min(1))
  .refine((keys) => Object.keys(keys).length > 0, 'Production keyring cannot be empty');
const packagedConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ version: z.literal(1), enabled: z.literal(false) }).strict(),
  z
    .object({
      version: z.literal(1),
      enabled: z.literal(true),
      manifestUrl: z.url(),
      publicKeys: publicKeyMapSchema
    })
    .strict()
]);

export type ProductionScenarioPublicationSource =
  | {
      status: 'configured';
      refresh: (mode: ScenarioModeV2) => Promise<ScenarioPublicationSnapshot>;
    }
  | {
      status: 'unavailable';
      reason: 'production-source-not-configured' | 'production-config-invalid';
    };

export interface ProductionScenarioPublicationSourceOptions {
  userDataDir: string;
  packagedConfigPath: string;
  env: Readonly<Record<string, string | undefined>>;
  readFile?: (filePath: string, encoding: 'utf8') => Promise<string>;
  requestJson?: ScenarioHttpRequest;
  now?: () => Date;
}

export async function createProductionScenarioPublicationSource({
  userDataDir,
  packagedConfigPath,
  env,
  readFile = nodeReadFile,
  requestJson,
  now
}: ProductionScenarioPublicationSourceOptions): Promise<ProductionScenarioPublicationSource> {
  const config = await loadConfig({ packagedConfigPath, env, readFile });
  if (config.status !== 'configured') return config;
  try {
    const publicKeys = parsePublicKeys(config.publicKeys);
    const service = new ScenePublicationService({
      reader: new HttpScenarioPublicationReader({
        manifestUrl: config.manifestUrl,
        requestJson,
        allowInsecureLoopback: env.GTA_SCENARIO_ALLOW_INSECURE_LOOPBACK === '1'
      }),
      storage: new FileScenarioPublicationStorage(
        path.join(userDataDir, 'cache', 'scenario-publications-v2')
      ),
      publicKeys,
      expectedUse: 'production',
      now
    });
    return {
      status: 'configured',
      refresh: (mode) => service.refresh(mode)
    };
  } catch {
    return { status: 'unavailable', reason: 'production-config-invalid' };
  }
}

type LoadedConfig =
  | { status: 'configured'; manifestUrl: string; publicKeys: Record<string, string> }
  | Extract<ProductionScenarioPublicationSource, { status: 'unavailable' }>;

async function loadConfig(options: {
  packagedConfigPath: string;
  env: Readonly<Record<string, string | undefined>>;
  readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
}): Promise<LoadedConfig> {
  const envUrl = options.env.GTA_SCENARIO_MANIFEST_URL?.trim();
  const envKeys = options.env.GTA_SCENARIO_PUBLIC_KEYS_JSON?.trim();
  if (envUrl || envKeys) {
    if (!envUrl || !envKeys) {
      return { status: 'unavailable', reason: 'production-config-invalid' };
    }
    try {
      return {
        status: 'configured',
        manifestUrl: z.url().parse(envUrl),
        publicKeys: publicKeyMapSchema.parse(JSON.parse(envKeys))
      };
    } catch {
      return { status: 'unavailable', reason: 'production-config-invalid' };
    }
  }

  try {
    const parsed = packagedConfigSchema.parse(
      JSON.parse(await options.readFile(options.packagedConfigPath, 'utf8'))
    );
    return parsed.enabled
      ? {
          status: 'configured',
          manifestUrl: parsed.manifestUrl,
          publicKeys: parsed.publicKeys
        }
      : { status: 'unavailable', reason: 'production-source-not-configured' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'unavailable', reason: 'production-source-not-configured' };
    }
    return { status: 'unavailable', reason: 'production-config-invalid' };
  }
}

function parsePublicKeys(input: Record<string, string>): ScenarioPublicKeyRing {
  return Object.fromEntries(
    Object.entries(input).map(([keyId, pem]) => {
      if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u.test(pem)) {
        throw new Error('Private key material is forbidden');
      }
      const key = createPublicKey(pem);
      if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
        throw new Error('Only Ed25519 public keys are supported');
      }
      return [keyId, key] as const;
    })
  );
}
