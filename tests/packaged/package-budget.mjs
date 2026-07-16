import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const MIB = 1024 * 1024;
const rendererDir = path.resolve('dist/renderer');
const releaseDir = process.env.GTA_RELEASE_DIR ?? 'release';
const appCandidates = [
  'mac-universal/Genshin Team Advisor.app',
  'mac-arm64/Genshin Team Advisor.app',
  'mac/Genshin Team Advisor.app',
  'win-unpacked',
  'win-arm64-unpacked'
].map((value) => path.resolve(releaseDir, value));
const appDir = appCandidates.find(existsSync);

if (!appDir) throw new Error('No unpacked application found');

const renderer = await directoryMetrics(rendererDir);
const app = await directoryMetrics(appDir);
const result = {
  rendererMiB: Number((renderer.bytes / MIB).toFixed(1)),
  rendererFiles: renderer.files,
  unpackedAppMiB: Number((app.bytes / MIB).toFixed(1)),
  unpackedAppFiles: app.files,
  appKind: appDir.includes('mac-universal') ? 'mac-universal' : 'single-arch'
};

if (renderer.bytes > 20 * MIB) throw new Error(`Renderer exceeds 20 MiB: ${result.rendererMiB}`);
if (renderer.files > 30) throw new Error(`Renderer exceeds 30 files: ${renderer.files}`);
const maxAppMiB = result.appKind === 'mac-universal' ? 1150 : 650;
if (app.bytes > maxAppMiB * MIB) {
  throw new Error(`${result.appKind} app exceeds ${maxAppMiB} MiB: ${result.unpackedAppMiB}`);
}

if (result.appKind === 'mac-universal') {
  const zipName = (await readdir(path.resolve(releaseDir))).find((name) => name.endsWith('.zip'));
  if (!zipName) throw new Error('Universal macOS build is missing its ZIP update artifact');
  const zipMiB = (await stat(path.resolve(releaseDir, zipName))).size / MIB;
  if (zipMiB > 450) throw new Error(`Universal macOS ZIP exceeds 450 MiB: ${zipMiB.toFixed(1)}`);
  result.universalZipMiB = Number(zipMiB.toFixed(1));
}

console.log(JSON.stringify({ gate: 'package-budget', status: 'passed', ...result }));

async function directoryMetrics(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await directoryMetrics(absolute);
      bytes += child.bytes;
      files += child.files;
    } else if (entry.isFile()) {
      bytes += (await stat(absolute)).size;
      files += 1;
    }
  }
  return { bytes, files };
}
