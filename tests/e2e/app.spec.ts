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
const FORBIDDEN_PLAYER_TERMS =
  /LLM|Enka|API Key|Base URL|\bpartial\b|\bfallback\b|team-composer|下一阶段接入|开发中/iu;
const REQUIRED_VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 }
] as const;

async function expectNoForbiddenPlayerTerms(): Promise<void> {
  const content = (await page.locator('main').textContent()) ?? '';
  expect(content).not.toMatch(FORBIDDEN_PLAYER_TERMS);
}

async function expectPageFitsEveryViewport(label: string): Promise<void> {
  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const measurements = await page.evaluate<{
      overflowX: string;
      scrollWidth: number;
      clientWidth: number;
      viewportWidth: number;
      escapedControls: Array<{ name: string; left: number; right: number }>;
    }>(`(() => {
      const shell = document.querySelector('.app-shell');
      if (!shell) throw new Error('Missing app shell');
      const controls = Array.from(document.querySelectorAll('header button, header select, main button, main input, main textarea, main select, main summary'));
      const escapedControls = controls.flatMap((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return [];
        return rect.left < -0.5 || rect.right > window.innerWidth + 0.5
          ? [{ name: element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName, left: rect.left, right: rect.right }]
          : [];
      });
      return {
        overflowX: getComputedStyle(shell).overflowX,
        scrollWidth: shell.scrollWidth,
        clientWidth: shell.clientWidth,
        viewportWidth: window.innerWidth,
        escapedControls
      };
    })()`);
    expect(
      measurements.overflowX,
      `${label} ${viewport.width}px must not hide content overflow`
    ).not.toBe('hidden');
    expect(
      measurements.scrollWidth,
      `${label} ${viewport.width}px shell width`
    ).toBeLessThanOrEqual(measurements.clientWidth);
    expect(measurements.clientWidth).toBeLessThanOrEqual(measurements.viewportWidth);
    expect(measurements.escapedControls, `${label} ${viewport.width}px control bounds`).toEqual([]);
  }
}

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

  const primaryNavigation = page.getByRole('navigation', { name: '主导航' });
  await expect(primaryNavigation.getByRole('button')).toHaveText([
    '角色一览',
    '挑战配队',
    '历史记录'
  ]);
  await expect(primaryNavigation.getByRole('button', { name: '绑定' })).toHaveCount(0);
  await expect(primaryNavigation.getByRole('button', { name: '设置' })).toHaveCount(0);

  const accountButton = page.getByRole('button', { name: '账号与设置' });
  await accountButton.click();
  const accountMenu = page.getByRole('menu', { name: '账号与设置' });
  await expect(accountMenu).toBeVisible();
  await expect(accountMenu.getByRole('menuitem', { name: '资料绑定' })).toBeVisible();
  await expect(accountMenu.getByRole('menuitem', { name: '设置' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(accountMenu).toBeHidden();
  await expect(accountButton).toBeFocused();

  await accountButton.click();
  await accountMenu.getByRole('menuitem', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: /智能服务设置/ })).toBeVisible();
  await expect(page.getByText('未配置', { exact: true })).toBeVisible();
  await expectNoForbiddenPlayerTerms();

  await page.getByLabel('服务密钥').fill('e2e-api-secret');
  await page.getByLabel('本次保存时替换自定义请求头').check();
  await page.getByLabel('自定义请求头', { exact: true }).fill('X-E2E-Key: e2e-header-secret');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('配置已保存。')).toBeVisible();
  await expect(page.getByText(/已加密保存：X-E2E-Key/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('e2e-header-secret');
  const persistedConfig = await readFile(path.join(userDataDir, 'config.json'), 'utf8');
  expect(persistedConfig).not.toContain('e2e-api-secret');
  expect(persistedConfig).not.toContain('e2e-header-secret');

  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '切换语言，当前：中文' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Smart service settings/ })).toBeVisible();
  await expect(page.getByText('Configured (encrypted)', { exact: true })).toBeVisible();
  await expectNoForbiddenPlayerTerms();
  await page.getByRole('button', { name: 'Clear service key' }).click();
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Account and settings' }).click();
  await page.getByRole('menuitem', { name: 'Switch language, current: English' }).click();

  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '资料绑定' }).click();
  await expect(page.getByRole('heading', { name: /绑定米游社账号/ })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test('supports the complete keyboard model for the account menu', async () => {
  const accountButton = page.getByRole('button', { name: '账号与设置' });
  const accountMenu = page.getByRole('menu', { name: '账号与设置' });
  const profileItem = accountMenu.getByRole('menuitem', { name: '资料绑定' });
  const historyNav = page.getByRole('navigation', { name: '主导航' }).getByRole('button', {
    name: '历史记录'
  });

  await accountButton.focus();
  await page.keyboard.press('ArrowDown');
  await expect(accountMenu).toBeVisible();
  await expect(profileItem).toBeFocused();

  await page.keyboard.press('ArrowUp');
  await expect(accountMenu.getByRole('menuitem', { name: '关于' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(profileItem).toBeFocused();
  await page.keyboard.press('End');
  await expect(accountMenu.getByRole('menuitem', { name: '关于' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(profileItem).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(accountMenu).toBeHidden();
  await expect(page.getByRole('button', { name: '用内置浏览器登录米游社' })).toBeFocused();

  await accountButton.focus();
  await page.keyboard.press('Enter');
  await expect(accountMenu).toBeVisible();
  await expect(profileItem).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(accountMenu).toBeHidden();
  await expect(historyNav).toBeFocused();

  await accountButton.focus();
  await page.keyboard.press('Space');
  await expect(accountMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(accountMenu).toBeHidden();
  await expect(accountButton).toBeFocused();
});

test('does not conceal horizontal content overflow', async () => {
  await expectPageFitsEveryViewport('Onboarding');
});

test('keeps focus on the account trigger after every menu command', async () => {
  let accountButton = page.getByRole('button', { name: '账号与设置' });

  await accountButton.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /绑定米游社账号/ })).toBeVisible();
  await expect(accountButton).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(accountButton).toBeFocused();
  await expect(page.getByRole('heading', { name: /智能服务设置/ })).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  accountButton = page.getByRole('button', { name: 'Account and settings' });
  await expect(accountButton).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  accountButton = page.getByRole('button', { name: '账号与设置' });
  await expect(accountButton).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '关于原神配队助手' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(accountButton).toBeFocused();
});

test('traps modal focus and restores it to the connected opener', async () => {
  const accountButton = page.getByRole('button', { name: '账号与设置' });
  await accountButton.click();
  await page.getByRole('menuitem', { name: '关于' }).click();

  const dialog = page.getByRole('dialog', { name: '关于原神配队助手' });
  const closeButton = dialog.getByRole('button', { name: '关闭对话框' });
  await expect(dialog).toBeVisible();
  const titleId = await dialog.getAttribute('aria-labelledby');
  expect(titleId).toBeTruthy();
  expect(titleId).not.toBe('gta-dialog-title');
  await expect(dialog.locator(`[id="${titleId}"]`)).toHaveText('关于原神配队助手');
  await expect(closeButton).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(closeButton).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(accountButton).toBeFocused();
});

test('renders profile coverage and known build fields without fake zero values', async () => {
  test.setTimeout(60_000);
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

  await expect(page.getByTestId('profile-coverage-summary')).toContainText('资料不完整');
  await expect(page.getByText('米游社 + 展示柜资料融合', { exact: true })).toBeVisible();
  await expect(page.getByText('测试武器 · Lv 90 · 精2')).toBeVisible();
  await expect(page.getByText('6 / 9 / 10')).toBeVisible();
  await expect(page.getByText(/测试套装×1/)).toBeVisible();
  await expect(page.getByText('未知', { exact: true }).first()).toBeVisible();
  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('Roster');

  await page.getByRole('button', { name: '挑战配队' }).click();
  await expect(page.getByRole('heading', { name: '选择挑战' })).toBeVisible();
  await expect(page.getByRole('button', { name: /深境螺旋/ })).toContainText('上下半两队');
  await expect(page.getByRole('button', { name: /幻想真境剧诗/ })).toContainText('演员池与活力');
  await expect(page.getByRole('button', { name: /幽境危战/ })).toContainText('三阶段首领');
  const abyssEntry = page.getByRole('button', { name: /深境螺旋/ });
  const theaterEntry = page.getByRole('button', { name: /幻想真境剧诗/ });
  await expect(abyssEntry).toHaveAttribute('aria-pressed', 'true');
  await theaterEntry.focus();
  await page.keyboard.press('Space');
  await expect(theaterEntry).toHaveAttribute('aria-pressed', 'true');
  await expect(abyssEntry).toHaveAttribute('aria-pressed', 'false');

  const legacyEnemyInput = page.locator('.gta-advisor-advanced textarea').first();
  await expect(legacyEnemyInput).toHaveValue('abyss-mage, ruin-guard');
  await expect(legacyEnemyInput).toBeHidden();

  const globalBackground = await page.evaluate<string>(
    "getComputedStyle(document.querySelector('.app-bg')).backgroundImage"
  );
  expect(globalBackground).toContain('app-global');
  const modeBackgrounds = await page.evaluate<string[]>(
    "Array.from(document.querySelectorAll('[data-testid=challenge-mode-entry]'), (element) => getComputedStyle(element).backgroundImage)"
  );
  expect(modeBackgrounds).toHaveLength(3);
  expect(modeBackgrounds.join(' ')).toContain('spiral-abyss');
  expect(modeBackgrounds.join(' ')).toContain('imaginarium-theater');
  expect(modeBackgrounds.join(' ')).toContain('stygian-onslaught');

  await page.locator('.gta-advisor-advanced > summary').click();
  const drillModeGroup = page.getByRole('group', { name: '自定义演练模式' });
  const singleModeButton = drillModeGroup.getByRole('button', { name: '单环境' });
  const compareModeButton = drillModeGroup.getByRole('button', { name: '双环境对比' });
  await expect(singleModeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(compareModeButton).toHaveAttribute('aria-pressed', 'false');
  await compareModeButton.click();
  await expect(compareModeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(singleModeButton).toHaveAttribute('aria-pressed', 'false');
  await singleModeButton.click();
  await expect(singleModeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(legacyEnemyInput).toBeVisible();

  await page.getByRole('button', { name: '生成建议' }).click();
  await expect(page.locator('.gta-tag.is-fallback')).toContainText('本地规则', {
    timeout: 10_000
  });
  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('Advisor details');

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(550);
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m2-challenge-1024x768.png') });

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m2-challenge-1600x1000.png') });

  await page.getByRole('button', { name: '历史记录' }).click();
  await expect(page.getByRole('heading', { name: '推荐历史' })).toBeVisible();
  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('History');

  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: /智能服务设置/ })).toBeVisible();
  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('Settings');
  expect(rendererErrors).toEqual([]);
});
