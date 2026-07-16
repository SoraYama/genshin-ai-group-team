import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') {
  throw new Error('The macOS universal SDK preparation gate must run on macOS');
}

const packagePath = 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const metadata = lock.packages?.[packagePath];
if (!metadata?.resolved || !metadata?.integrity?.startsWith('sha512-')) {
  throw new Error(`Missing locked tarball metadata for ${packagePath}`);
}

const response = await fetch(metadata.resolved, { signal: AbortSignal.timeout(180_000) });
if (!response.ok) throw new Error(`Intel SDK download failed with HTTP ${response.status}`);
const tarball = Buffer.from(await response.arrayBuffer());
const actualIntegrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
if (actualIntegrity !== metadata.integrity) {
  throw new Error('Intel SDK tarball integrity does not match package-lock.json');
}

const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'gta-sdk-x64-'));
const archivePath = path.join(temporaryDir, 'sdk.tgz');
const targetPath = path.resolve(packagePath);
try {
  await writeFile(archivePath, tarball);
  await rm(targetPath, { recursive: true, force: true });
  await mkdir(targetPath, { recursive: true });
  await promisify(execFile)('tar', [
    '-xzf',
    archivePath,
    '-C',
    targetPath,
    '--strip-components=1'
  ]);
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}

process.stdout.write(
  `installed locked macOS Intel SDK ${metadata.version} (${tarball.length} bytes)\n`
);
