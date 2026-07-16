import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const releaseDir = path.resolve(process.argv[2] ?? process.env.GTA_RELEASE_DIR ?? 'release');
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const latestPath = path.join(releaseDir, 'latest-mac.yml');
const latest = await readFile(latestPath, 'utf8');

assertField(latest, 'version', packageJson.version);
const declaredSha512 = field(latest, 'sha512');
const declaredUrl = field(latest, 'url');
if (!declaredUrl.endsWith('.zip')) {
  throw new Error(`latest-mac.yml must point to a ZIP artifact, got ${declaredUrl}`);
}

const zipName = (await readdir(releaseDir)).find((name) => name.endsWith('.zip'));
if (!zipName) throw new Error(`No macOS ZIP found in ${releaseDir}`);
if (declaredUrl !== zipName) {
  throw new Error(`latest-mac.yml points to ${declaredUrl}, but artifact is ${zipName}`);
}
const zip = await readFile(path.join(releaseDir, zipName));
const actualSha512 = createHash('sha512').update(zip).digest('base64');
if (declaredSha512 !== actualSha512) {
  throw new Error('latest-mac.yml SHA-512 does not match the ZIP artifact');
}

const appUpdatePath = await findFile(releaseDir, 'app-update.yml');
if (!appUpdatePath) throw new Error('Packaged app is missing Resources/app-update.yml');
const appUpdate = await readFile(appUpdatePath, 'utf8');
assertField(appUpdate, 'provider', 'github');
assertField(appUpdate, 'owner', 'SoraYama');
assertField(appUpdate, 'repo', 'genshin-ai-group-team');

const combined = `${latest}\n${appUpdate}`;
if (/\b(?:api[-_]?key|authorization|password|secret|token)\b\s*:/iu.test(combined)) {
  throw new Error('Update metadata appears to contain a secret-bearing field');
}

process.stdout.write(
  `update metadata ok: ${packageJson.version}, ${zip.length} bytes, ${path.relative(releaseDir, appUpdatePath)}\n`
);

function field(contents, name) {
  const match = contents.match(
    new RegExp(`^\\s*(?:-\\s*)?${name}:\\s*['"]?([^'"\\n]+)`, 'mu')
  );
  if (!match) throw new Error(`Missing ${name} in update metadata`);
  return match[1].trim();
}

function assertField(contents, name, expected) {
  const actual = field(contents, name);
  if (actual !== expected) throw new Error(`Expected ${name}=${expected}, got ${actual}`);
}

async function findFile(directory, wantedName) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === wantedName) return child;
    if (entry.isDirectory()) {
      const found = await findFile(child, wantedName);
      if (found) return found;
    }
  }
  return undefined;
}
