import { _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const releaseDir = process.env.GTA_RELEASE_DIR ?? 'release';
const candidates = [
  'mac-universal/Genshin Team Advisor.app/Contents/MacOS/Genshin Team Advisor',
  'mac-arm64/Genshin Team Advisor.app/Contents/MacOS/Genshin Team Advisor',
  'mac/Genshin Team Advisor.app/Contents/MacOS/Genshin Team Advisor',
  'win-unpacked/Genshin Team Advisor.exe',
  'win-arm64-unpacked/Genshin Team Advisor.exe'
].map((entry) => path.resolve(releaseDir, entry));
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error('Packaged application not found; run npm run pack:dir first');

const userDataDir = await mkdtemp(path.join(tmpdir(), 'gta-packaged-app-smoke-'));
const errors = [];
const observedPages = new WeakSet();
function observePage(page) {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console:${message.text()}`);
  });
}
let application;
try {
  application = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      GTA_E2E_USER_DATA_DIR: userDataDir,
      GTA_DISABLE_BACKGROUND_REFRESH: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  application.on('window', observePage);
  const page = await application.firstWindow({ timeout: 15_000 });
  observePage(page);
  await page.locator('main h2').first().waitFor({ state: 'visible', timeout: 15_000 });
  const title = await page.title();
  const heading = (await page.locator('main h2').first().textContent())?.trim();
  if (title !== 'Genshin Team Advisor') throw new Error(`Unexpected packaged title: ${title}`);
  if (!heading) throw new Error('Packaged app did not render a first-screen heading');
  if (errors.length > 0) throw new Error(`Packaged renderer errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ gate: 'packaged-app', status: 'passed', title, heading }));
} finally {
  await application?.close();
  await rm(userDataDir, { recursive: true, force: true });
}
