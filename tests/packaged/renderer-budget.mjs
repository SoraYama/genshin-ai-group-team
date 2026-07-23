import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const KIB = 1024;
const MIB = KIB * KIB;
const rendererDir = path.resolve('dist/renderer');
const files = await allFiles(rendererDir);
const metrics = await Promise.all(
  files.map(async (file) => ({
    file,
    relative: path.relative(rendererDir, file),
    bytes: (await stat(file)).size
  }))
);

const unexpectedMaps = metrics.filter(({ relative }) => relative.endsWith('.map'));
if (unexpectedMaps.length > 0) {
  throw new Error(
    `Production renderer contains source maps: ${unexpectedMaps.map(({ relative }) => relative).join(', ')}`
  );
}

const javascript = metrics.filter(({ relative }) => relative.endsWith('.js'));
const styles = metrics.filter(({ relative }) => relative.endsWith('.css'));
const assets = metrics.filter(({ relative }) => !/\.(?:html|js|css)$/u.test(relative));
const javascriptBytes = total(javascript);
const styleBytes = total(styles);
const assetBytes = total(assets);
const rendererBytes = total(metrics);
const largest = metrics.slice().sort((left, right) => right.bytes - left.bytes)[0];

if (javascriptBytes > 1024 * KIB) {
  throw new Error(`Renderer JavaScript exceeds 1 MiB: ${formatMiB(javascriptBytes)}`);
}
if (styleBytes > 256 * KIB) {
  throw new Error(`Renderer CSS exceeds 256 KiB: ${Math.ceil(styleBytes / KIB)} KiB`);
}
if (assetBytes > 15 * MIB) {
  throw new Error(`Renderer assets exceed 15 MiB: ${formatMiB(assetBytes)}`);
}
if (rendererBytes > 16 * MIB) {
  throw new Error(`Renderer total exceeds 16 MiB: ${formatMiB(rendererBytes)}`);
}
if (largest && largest.bytes > 2 * MIB) {
  throw new Error(
    `Single renderer asset exceeds 2 MiB: ${largest.relative} (${formatMiB(largest.bytes)})`
  );
}
if (metrics.length > 30) {
  throw new Error(`Renderer exceeds 30 files: ${metrics.length}`);
}

const remoteReferences = [];
for (const entry of [
  ...javascript,
  ...styles,
  ...metrics.filter(({ relative }) => relative.endsWith('.html'))
]) {
  const source = await readFile(entry.file, 'utf8');
  const executableRemoteReferences = entry.relative.endsWith('.html')
    ? (source.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/giu) ?? [])
    : entry.relative.endsWith('.css')
      ? (source.match(/url\(\s*["']?https?:\/\/[^)"']+/giu) ?? [])
      : (source.match(/import\(\s*["']https?:\/\/[^"']+/giu) ?? []);
  remoteReferences.push(
    ...executableRemoteReferences.map((reference) => `${entry.relative}:${reference}`)
  );
}
if (remoteReferences.length > 0) {
  throw new Error(`Renderer bundle contains remote URL references: ${remoteReferences.join(', ')}`);
}

console.log(
  JSON.stringify({
    gate: 'renderer-budget',
    status: 'passed',
    rendererMiB: Number((rendererBytes / MIB).toFixed(2)),
    javascriptKiB: Math.ceil(javascriptBytes / KIB),
    cssKiB: Math.ceil(styleBytes / KIB),
    assetsMiB: Number((assetBytes / MIB).toFixed(2)),
    files: metrics.length,
    largest: largest ? { file: largest.relative, kib: Math.ceil(largest.bytes / KIB) } : undefined
  })
);

function total(entries) {
  return entries.reduce((sum, { bytes }) => sum + bytes, 0);
}

function formatMiB(bytes) {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

async function allFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? allFiles(absolute) : [absolute];
    })
  );
  return results.flat();
}
