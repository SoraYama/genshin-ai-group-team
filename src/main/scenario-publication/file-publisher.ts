import { randomUUID, type KeyLike, type KeyObject } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ScenarioPublicationManifest } from './contracts.js';
import { ScenarioPublicationError } from './errors.js';
import { createScenarioPublicationBundle, type ScenarioPublicationCandidate } from './publisher.js';

const safeInputFileSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]+\.json$/)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((segment) => segment === '..' || segment.length === 0),
    'Input files must remain inside the input directory'
  );

const inputIndexSchema = z
  .object({
    notice: z.string().trim().min(1).optional(),
    candidates: z
      .array(
        z
          .object({
            inputFile: safeInputFileSchema,
            current: z.boolean(),
            channel: z.enum(['production', 'development-sample'])
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export interface PublishScenarioInputDirectoryOptions {
  inputDirectory: string;
  outputDirectory: string;
  keyId: string;
  privateKey: KeyLike | KeyObject;
  publishedAt: string;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ScenarioPublicationError('invalid-json', { cause: error });
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ScenarioPublicationError('not-found');
    }
    throw new ScenarioPublicationError('network-unavailable', { cause: error });
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw new ScenarioPublicationError('storage-write-failed', { cause: error });
  }
}

export async function publishScenarioInputDirectory(
  options: PublishScenarioInputDirectoryOptions
): Promise<ScenarioPublicationManifest> {
  const inputRoot = path.resolve(options.inputDirectory);
  const indexResult = inputIndexSchema.safeParse(
    await readJsonFile(path.join(inputRoot, 'index.json'))
  );
  if (!indexResult.success) {
    throw new ScenarioPublicationError('manifest-invalid', { cause: indexResult.error });
  }

  const candidates: ScenarioPublicationCandidate[] = await Promise.all(
    indexResult.data.candidates.map(async ({ inputFile, current, channel }) => ({
      payload: await readJsonFile(path.join(inputRoot, inputFile)),
      current,
      channel
    }))
  );
  const bundle = createScenarioPublicationBundle(candidates, options);
  const outputRoot = path.resolve(options.outputDirectory);

  // The manifest is the commit point: readers cannot observe new entries before
  // every referenced payload and integrity document has been atomically written.
  for (const [publicationPath, document] of Object.entries(bundle.documents)) {
    await atomicWriteJson(path.join(outputRoot, publicationPath), document);
  }
  await atomicWriteJson(path.join(outputRoot, 'manifest.json'), bundle.manifest);
  return bundle.manifest;
}
