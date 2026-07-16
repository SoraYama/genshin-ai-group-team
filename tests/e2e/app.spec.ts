import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;
let userDataDir: string;
let launchDurationMs = 0;
const rendererErrors: string[] = [];

async function launchApp(): Promise<void> {
  const startedAt = Date.now();
  electronApp = await electron.launch({
    args: [path.resolve('.')],
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GTA_DISABLE_BACKGROUND_REFRESH: '1',
      GTA_E2E_USER_DATA_DIR: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  page = await electronApp.firstWindow();
  launchDurationMs = Date.now() - startedAt;
  page.on('pageerror', (error) => {
    rendererErrors.push(error.message);
  });
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'genshin-team-advisor-e2e-'));
  await launchApp();
});

test.afterAll(async () => {
  await electronApp?.close();
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('boots with isolated data and navigates through preload-backed pages', async () => {
  await expect(page).toHaveTitle('Genshin Team Advisor');
  expect(launchDurationMs).toBeLessThan(15_000);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /绑定米游社账号/ })).toBeVisible();

  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: /LLM 配置/ })).toBeVisible();
  await expect(page.getByText('未配置', { exact: true })).toBeVisible();

  await page.getByLabel('API Key').fill('e2e-api-secret');
  await page.getByLabel('本次保存时替换自定义请求头').check();
  await page.getByLabel('自定义请求头', { exact: true }).fill('X-E2E-Key: e2e-header-secret');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('配置已保存。')).toBeVisible();
  await expect(page.getByText(/已加密保存：X-E2E-Key/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('e2e-header-secret');
  const persistedConfig = await readFile(path.join(userDataDir, 'config.json'), 'utf8');
  expect(persistedConfig).not.toContain('e2e-api-secret');
  expect(persistedConfig).not.toContain('e2e-header-secret');

  await page.getByRole('combobox', { name: '语言' }).selectOption('en-US');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /LLM Configuration/ })).toBeVisible();
  await expect(page.getByText('Configured (encrypted)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear key' }).click();
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');

  await page.getByRole('button', { name: '绑定' }).click();
  await expect(page.getByRole('heading', { name: /绑定米游社账号/ })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test('renders profile coverage and known build fields without fake zero values', async () => {
  await electronApp.close();
  const fetchedAt = '2026-07-16T00:00:00.000Z';
  await writeFile(
    path.join(userDataDir, 'profiles.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeUid: '100000001',
      profilesByUid: {
        '100000001': {
          schemaVersion: 2,
          uid: '100000001',
          nickname: '脱敏测试账号',
          source: 'merged',
          fetchedAt,
          characters: [
            {
              id: 10000046,
              name: '测试角色',
              element: 'Pyro',
              rarity: 5,
              imageUrl: '',
              level: 90,
              build: {
                stats: { atk: 1800, critRate: 61.2 },
                weapon: {
                  id: 1,
                  name: '测试武器',
                  iconUrl: '',
                  level: 90,
                  refinement: 2,
                  rarity: 5
                },
                artifacts: [
                  {
                    slot: 'sands',
                    setId: 1,
                    setName: '测试套装',
                    level: 20,
                    rarity: 5,
                    mainStat: { key: 'atkPct', value: 46.6 },
                    subStats: []
                  }
                ],
                talents: { normalAttack: 6, elementalSkill: 9, elementalBurst: 10 }
              },
              constellation: 1,
              completeness: 'detailed',
              missingFields: [],
              provenance: {
                ownership: { source: 'miyoushe-list', fetchedAt },
                build: { source: 'miyoushe-detail', fetchedAt },
                stats: { source: 'enka', fetchedAt }
              }
            }
          ],
          coverage: {
            expectedOwnedCount: 2,
            ownedCount: 1,
            detailedCount: 1,
            buildCount: 1,
            statsCount: 1,
            enkaShowcaseCount: 1,
            missingDetailCount: 1,
            partial: true
          }
        }
      }
    })
  );
  await launchApp();

  await expect(page.getByTestId('profile-coverage-summary')).toContainText('部分数据');
  await expect(page.getByText('测试武器 · Lv 90 · 精2')).toBeVisible();
  await expect(page.getByText('6 / 9 / 10')).toBeVisible();
  await expect(page.getByText(/测试套装×1/)).toBeVisible();
  await expect(page.getByText('未知', { exact: true }).first()).toBeVisible();
  expect(rendererErrors).toEqual([]);
});
