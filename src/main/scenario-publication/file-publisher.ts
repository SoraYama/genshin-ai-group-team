import { createPublicKey, randomUUID, type KeyLike, type KeyObject } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { publicationIntegritySchema } from '../../shared/scenario-v2.js';
import {
  scenarioPublicationManifestSchema,
  type ScenarioPublicationDescriptor,
  type ScenarioPublicationManifest
} from './contracts.js';
import { ScenarioPublicationError } from './errors.js';
import { durableDirectorySync } from './durable-directory-sync.js';
import { verifyScenarioPublication, type ScenarioPublicKeyRing } from './publication.js';
import {
  createScenarioPublicationBundle,
  scenarioPublicationPaths,
  type ScenarioPublicationCandidate
} from './publisher.js';

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

type WritableFileHandle = Pick<FileHandle, 'writeFile' | 'sync' | 'close'>;

export interface PublisherFileSystem {
  lstat(filePath: string): Promise<Stats>;
  realpath(filePath: string): Promise<string>;
  mkdir(directoryPath: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  readdir(directoryPath: string): Promise<string[]>;
  open(filePath: string, flags: 'wx', mode: number): Promise<WritableFileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  syncDirectory(directoryPath: string): Promise<void>;
}

const nodeFileSystem: PublisherFileSystem = {
  lstat: (filePath) => fs.lstat(filePath),
  realpath: (filePath) => fs.realpath(filePath),
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  readdir: (directoryPath) => fs.readdir(directoryPath),
  open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
  link: (existingPath, newPath) => fs.link(existingPath, newPath),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  unlink: (filePath) => fs.unlink(filePath),
  syncDirectory: durableDirectorySync
};

export interface PublishScenarioInputDirectoryOptions {
  inputDirectory: string;
  outputDirectory: string;
  keyId: string;
  privateKey: KeyLike | KeyObject;
  publishedAt: string;
  trustedHistoricalPublicKeys?: ScenarioPublicKeyRing;
  fileSystem?: PublisherFileSystem;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function descriptorIdentity(descriptor: ScenarioPublicationDescriptor): string {
  return JSON.stringify([descriptor.mode, descriptor.scenarioId, descriptor.dataVersion]);
}

function descriptorFingerprint(descriptor: ScenarioPublicationDescriptor): string {
  return JSON.stringify([
    descriptor.mode,
    descriptor.schemaVersion,
    descriptor.scenarioId,
    descriptor.dataVersion,
    descriptor.payloadPath,
    descriptor.integrityPath,
    descriptor.channel
  ]);
}

async function secureRoot(
  requestedRoot: string,
  create: boolean,
  fileSystem: PublisherFileSystem
): Promise<string> {
  const resolved = path.resolve(requestedRoot);
  try {
    const stat = await fileSystem.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ScenarioPublicationError('unsafe-path');
    }
  } catch (error) {
    if (!isMissing(error) || !create) {
      if (error instanceof ScenarioPublicationError) throw error;
      throw new ScenarioPublicationError(isMissing(error) ? 'not-found' : 'unsafe-path');
    }
    await fileSystem.mkdir(resolved, { recursive: true, mode: 0o700 });
    const stat = await fileSystem.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ScenarioPublicationError('unsafe-path');
    }
  }
  return fileSystem.realpath(resolved);
}

async function assertSafeExistingPath(
  root: string,
  relativePath: string,
  fileSystem: PublisherFileSystem
): Promise<string> {
  let cursor = root;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let stat: Stats;
    try {
      stat = await fileSystem.lstat(cursor);
    } catch (error) {
      if (isMissing(error)) throw new ScenarioPublicationError('not-found');
      throw new ScenarioPublicationError('unsafe-path');
    }
    if (stat.isSymbolicLink()) throw new ScenarioPublicationError('unsafe-path');
    if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new ScenarioPublicationError('unsafe-path');
    }
  }
  return cursor;
}

async function ensureSafeDirectory(
  root: string,
  relativeDirectory: string,
  fileSystem: PublisherFileSystem
): Promise<string> {
  let cursor = root;
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fileSystem.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ScenarioPublicationError('unsafe-path');
      }
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof ScenarioPublicationError) throw error;
        throw new ScenarioPublicationError('unsafe-path');
      }
      await fileSystem.mkdir(cursor, { mode: 0o700 });
      const stat = await fileSystem.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ScenarioPublicationError('unsafe-path');
      }
      await fileSystem.syncDirectory(path.dirname(cursor));
    }
  }
  return cursor;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function cleanupOwnedTemps(
  directory: string,
  baseName: string,
  fileSystem: PublisherFileSystem
): Promise<void> {
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownedPattern = new RegExp(`^\\.${escaped}\\.scenario-publisher-[0-9a-f-]{36}\\.tmp$`);
  for (const entry of await fileSystem.readdir(directory)) {
    if (!ownedPattern.test(entry)) continue;
    const target = path.join(directory, entry);
    const stat = await fileSystem.lstat(target).catch(() => undefined);
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      await fileSystem.unlink(target).catch(() => undefined);
    }
  }
}

async function immutableWriteJson(
  outputRoot: string,
  relativePath: string,
  value: unknown,
  fileSystem: PublisherFileSystem
): Promise<void> {
  const directory = await ensureSafeDirectory(
    outputRoot,
    path.posix.dirname(relativePath),
    fileSystem
  );
  const baseName = path.posix.basename(relativePath);
  const finalPath = path.join(directory, baseName);
  const expected = jsonText(value);
  await cleanupOwnedTemps(directory, baseName, fileSystem);

  try {
    const stat = await fileSystem.lstat(finalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ScenarioPublicationError('unsafe-path');
    if ((await fileSystem.readFile(finalPath, 'utf8')) === expected) return;
    throw new ScenarioPublicationError('immutable-path-conflict');
  } catch (error) {
    if (!isMissing(error)) {
      if (error instanceof ScenarioPublicationError) throw error;
      throw new ScenarioPublicationError('storage-write-failed');
    }
  }

  const temporaryPath = path.join(directory, `.${baseName}.scenario-publisher-${randomUUID()}.tmp`);
  let handle: WritableFileHandle | undefined;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(expected, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fileSystem.link(temporaryPath, finalPath);
    await fileSystem.unlink(temporaryPath);
    await fileSystem.syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fileSystem.unlink(temporaryPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const stat = await fileSystem.lstat(finalPath).catch(() => undefined);
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        if ((await fileSystem.readFile(finalPath, 'utf8')) === expected) return;
        throw new ScenarioPublicationError('immutable-path-conflict');
      }
      throw new ScenarioPublicationError('unsafe-path');
    }
    if (error instanceof ScenarioPublicationError) throw error;
    throw new ScenarioPublicationError('storage-write-failed', { cause: error });
  }
}

async function replaceManifest(
  outputRoot: string,
  manifest: ScenarioPublicationManifest,
  fileSystem: PublisherFileSystem
): Promise<void> {
  const baseName = 'manifest.json';
  const finalPath = path.join(outputRoot, baseName);
  await cleanupOwnedTemps(outputRoot, baseName, fileSystem);
  const temporaryPath = path.join(
    outputRoot,
    `.${baseName}.scenario-publisher-${randomUUID()}.tmp`
  );
  let handle: WritableFileHandle | undefined;
  try {
    const existing = await fileSystem.lstat(finalPath).catch(() => undefined);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new ScenarioPublicationError('unsafe-path');
    }
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(jsonText(manifest), { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fileSystem.rename(temporaryPath, finalPath);
    await fileSystem.syncDirectory(outputRoot);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fileSystem.unlink(temporaryPath).catch(() => undefined);
    if (error instanceof ScenarioPublicationError) throw error;
    throw new ScenarioPublicationError('storage-write-failed', { cause: error });
  }
}

async function readJsonFile(
  root: string,
  relativePath: string,
  fileSystem: PublisherFileSystem
): Promise<unknown> {
  const filePath = await assertSafeExistingPath(root, relativePath, fileSystem);
  try {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof ScenarioPublicationError) throw error;
    if (error instanceof SyntaxError) {
      throw new ScenarioPublicationError('invalid-json', { cause: error });
    }
    throw new ScenarioPublicationError('network-unavailable', { cause: error });
  }
}

function mergeManifest(
  existing: ScenarioPublicationManifest | undefined,
  next: ScenarioPublicationManifest
): ScenarioPublicationManifest {
  if (!existing) return next;
  const merged = structuredClone(existing);
  merged.publishedAt = next.publishedAt;
  for (const mode of Object.keys(next.modes) as Array<keyof typeof next.modes>) {
    const oldIndex = merged.modes[mode];
    const nextIndex = next.modes[mode];
    const identities = new Map(
      oldIndex.history.map((descriptor) => [descriptorIdentity(descriptor), descriptor])
    );
    for (const descriptor of nextIndex.history) {
      const prior = identities.get(descriptorIdentity(descriptor));
      if (prior && descriptorFingerprint(prior) !== descriptorFingerprint(descriptor)) {
        throw new ScenarioPublicationError('identity-mismatch');
      }
      if (!prior) oldIndex.history.push(descriptor);
    }
    if (nextIndex.current) oldIndex.current = nextIndex.current;
  }
  const result = scenarioPublicationManifestSchema.safeParse(merged);
  if (!result.success) {
    throw new ScenarioPublicationError('manifest-invalid', { cause: result.error });
  }
  return result.data;
}

async function validateRetainedPublications(
  outputRoot: string,
  manifest: ScenarioPublicationManifest,
  publicKeys: ScenarioPublicKeyRing,
  fileSystem: PublisherFileSystem
): Promise<void> {
  const descriptors = Object.values(manifest.modes).flatMap(({ history }) => history);
  if (descriptors.some(({ channel }) => channel !== 'production')) {
    throw new ScenarioPublicationError('channel-mismatch');
  }

  for (const descriptor of descriptors) {
    const [payloadInput, integrityInput] = await Promise.all([
      readJsonFile(outputRoot, descriptor.payloadPath, fileSystem),
      readJsonFile(outputRoot, descriptor.integrityPath, fileSystem)
    ]);
    const integrityResult = publicationIntegritySchema.safeParse(integrityInput);
    if (!integrityResult.success) {
      throw new ScenarioPublicationError('schema-invalid', { cause: integrityResult.error });
    }
    const payload = verifyScenarioPublication(payloadInput, integrityResult.data, publicKeys);
    const expectedPaths = scenarioPublicationPaths(payload, integrityResult.data);
    if (
      descriptor.mode !== payload.mode ||
      descriptor.schemaVersion !== payload.meta.schemaVersion ||
      descriptor.scenarioId !== payload.id ||
      descriptor.dataVersion !== payload.meta.dataVersion ||
      descriptor.payloadPath !== expectedPaths.payloadPath ||
      descriptor.integrityPath !== expectedPaths.integrityPath
    ) {
      throw new ScenarioPublicationError('identity-mismatch');
    }
  }
}

export async function publishScenarioInputDirectory(
  options: PublishScenarioInputDirectoryOptions
): Promise<ScenarioPublicationManifest> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const inputRoot = await secureRoot(options.inputDirectory, false, fileSystem);
  const indexResult = inputIndexSchema.safeParse(
    await readJsonFile(inputRoot, 'index.json', fileSystem)
  );
  if (!indexResult.success) {
    throw new ScenarioPublicationError('manifest-invalid', { cause: indexResult.error });
  }

  const candidates: ScenarioPublicationCandidate[] = await Promise.all(
    indexResult.data.candidates.map(async ({ inputFile, current, channel }) => ({
      payload: await readJsonFile(inputRoot, inputFile, fileSystem),
      current,
      channel
    }))
  );
  const bundle = createScenarioPublicationBundle(candidates, options);
  const outputRoot = await secureRoot(options.outputDirectory, true, fileSystem);
  let existingManifest: ScenarioPublicationManifest | undefined;
  try {
    const raw = await readJsonFile(outputRoot, 'manifest.json', fileSystem);
    const result = scenarioPublicationManifestSchema.safeParse(raw);
    if (!result.success) throw new ScenarioPublicationError('manifest-invalid');
    existingManifest = result.data;
  } catch (error) {
    if (!(error instanceof ScenarioPublicationError) || error.code !== 'not-found') throw error;
  }
  if (existingManifest) {
    let currentPublicKey: KeyObject;
    try {
      currentPublicKey = createPublicKey(options.privateKey);
    } catch (error) {
      throw new ScenarioPublicationError('invalid-signing-key', { cause: error });
    }
    await validateRetainedPublications(
      outputRoot,
      existingManifest,
      {
        ...options.trustedHistoricalPublicKeys,
        [options.keyId]: currentPublicKey
      },
      fileSystem
    );
  }
  const manifest = mergeManifest(existingManifest, bundle.manifest);

  // The manifest is the commit point. Every immutable referenced document and
  // its parent directory are durable before the manifest rename is attempted.
  for (const [publicationPath, document] of Object.entries(bundle.documents)) {
    await immutableWriteJson(outputRoot, publicationPath, document, fileSystem);
  }
  await replaceManifest(outputRoot, manifest, fileSystem);
  return manifest;
}
