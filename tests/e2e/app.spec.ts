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
  await expect(page.getByRole('heading', { name: /添加角色资料/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /登录米游社/ })).toContainText('完整资料');
  await expect(page.getByRole('button', { name: /只用 UID 展示柜/ })).toContainText('无需登录');

  await page.getByRole('button', { name: /登录米游社/ }).click();
  await expect(page.getByRole('button', { name: '用内置浏览器登录米游社' })).toBeVisible();
  await page.getByText('高级：手动导入说明').click();
  await expect(page.getByText(/登录凭据不进入主界面脚本/)).toBeVisible();
  await expect(page.getByLabel('Cookie')).toHaveCount(0);
  await page.getByRole('button', { name: '返回选择方式' }).click();
  await page.getByRole('button', { name: /只用 UID 展示柜/ }).click();
  const uidInput = page.getByLabel('游戏 UID');
  await uidInput.fill('12345678');
  await page.getByRole('button', { name: '同步展示角色' }).click();
  await expect(page.getByText('请输入 9 位数字 UID')).toBeVisible();
  await expect(page.getByText(/Cookie/)).toBeHidden();
  await page.getByRole('button', { name: '返回选择方式' }).click();

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
  await expect(page.getByRole('heading', { name: /添加角色资料/ })).toBeVisible();
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
  await expect(page.getByRole('button', { name: /登录米游社/ })).toBeFocused();

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
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m3-onboarding-1280x800.png') });
});

test('keeps focus on the account trigger after every menu command', async () => {
  let accountButton = page.getByRole('button', { name: '账号与设置' });

  await accountButton.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /添加角色资料/ })).toBeVisible();
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

test('routes UID-only onboarding through the preload profile refresh contract', async () => {
  const uid = '123456789';
  await electronApp.evaluate(({ ipcMain }, testUid) => {
    const scope = globalThis as typeof globalThis & {
      __gtaM3UidCalls?: Array<{ channel: string; payload: unknown }>;
    };
    scope.__gtaM3UidCalls = [];
    ipcMain.removeHandler('profile:refresh');
    ipcMain.handle('profile:refresh', (_event, payload) => {
      scope.__gtaM3UidCalls?.push({ channel: 'profile:refresh', payload });
      return {
        ok: true,
        data: {
          profile: {
            schemaVersion: 2,
            uid: testUid,
            nickname: 'UID 测试账号',
            source: 'enka',
            fetchedAt: '2026-07-23T00:00:00.000Z',
            characters: [],
            coverage: {
              ownedCount: 0,
              detailedCount: 0,
              buildCount: 0,
              statsCount: 0,
              enkaShowcaseCount: 0,
              missingDetailCount: 0,
              partial: true
            }
          },
          summary: {
            enka: 'ok',
            enkaCharacterCount: 0,
            miyoushe: 'no-cookie',
            miyousheCharacterCount: 0,
            totalCharacterCount: 0
          }
        }
      };
    });
    ipcMain.removeHandler('profile:set-active');
    ipcMain.handle('profile:set-active', (_event, payload) => {
      scope.__gtaM3UidCalls?.push({ channel: 'profile:set-active', payload });
      return { ok: true, data: { ok: true } };
    });
  }, uid);

  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '资料绑定' }).click();
  await page.getByRole('button', { name: /只用 UID 展示柜/ }).click();
  await page.getByLabel('游戏 UID').fill(uid);
  await page.getByRole('button', { name: '同步展示角色' }).click();
  await expect(page.getByText('还没有绑定任何账号。')).toBeVisible();

  const calls = await electronApp.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __gtaM3UidCalls?: Array<{ channel: string; payload: unknown }>;
    };
    return scope.__gtaM3UidCalls ?? [];
  });
  expect(calls).toEqual([
    { channel: 'profile:refresh', payload: { uid } },
    { channel: 'profile:set-active', payload: { uid } }
  ]);
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
          level: 58,
          credentialSource: 'partition',
          source: 'merged',
          fetchedAt,
          characters: [
            {
              id: 10000046,
              name: '测试角色',
              element: 'Pyro',
              rarity: 5,
              imageUrl: 'gtai-img://official-looking-portrait-should-never-render',
              level: 90,
              build: {
                stats: {
                  hp: 18800,
                  atk: 1800,
                  def: 780,
                  critRate: 61.2,
                  energyRecharge: 119.9
                },
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
                  },
                  {
                    slot: 'circlet',
                    setId: 1,
                    setName: '测试套装',
                    level: 20,
                    rarity: 5,
                    mainStat: { key: 'new_stat\n<script>', value: 7.7 },
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
            },
            {
              id: 10000999,
              name: '未知角色',
              element: 'Void',
              rarity: 0,
              imageUrl: '',
              completeness: 'basic',
              missingFields: ['stats', 'weapon', 'artifacts', 'talents'],
              provenance: {
                ownership: { source: 'miyoushe-list', fetchedAt }
              }
            }
          ],
          coverage: {
            expectedOwnedCount: 2,
            ownedCount: 2,
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

  await expect(page.getByRole('button', { name: '更新角色资料' })).toHaveCount(1);
  await expect(
    page.getByRole('button', {
      name: /更换米游社账号|连接诊断|退出米游社登录|绑定新 UID|删除本机角色资料/
    })
  ).toHaveCount(0);
  await expect(page.getByTestId('profile-coverage-summary')).toContainText('已读取 2 名角色');
  await expect(page.getByTestId('profile-coverage-summary')).toContainText('1 名有完整装备面板');
  await expect(page.getByText('冒险等阶 58')).toBeVisible();
  await expect(page.getByText(/世界等级/)).toHaveCount(0);
  await expect(page.getByText(/融合|Enka|缓存/)).toHaveCount(0);

  const maintenanceButton = page.getByRole('button', { name: '账号维护' });
  await maintenanceButton.focus();
  await page.keyboard.press('ArrowDown');
  const maintenanceMenu = page.getByRole('menu', { name: '账号维护' });
  await expect(maintenanceMenu).toBeVisible();
  await expect(maintenanceMenu.getByRole('menuitem')).toHaveText([
    '更换登录账号',
    '连接诊断',
    '退出米游社登录',
    '绑定新 UID',
    '删除本机角色资料'
  ]);
  await expect(maintenanceMenu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(maintenanceMenu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(maintenanceMenu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(maintenanceMenu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(maintenanceMenu).toBeHidden();
  await expect(maintenanceButton).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(maintenanceMenu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(maintenanceMenu).toBeHidden();
  await expect(page.getByRole('tab', { name: /脱敏测试账号/ })).toBeFocused();
  await maintenanceButton.focus();
  await page.keyboard.press('ArrowDown');
  await expect(maintenanceMenu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(maintenanceMenu).toBeHidden();
  await expect(page.getByRole('button', { name: '账号与设置' })).toBeFocused();

  await maintenanceButton.click();
  await maintenanceMenu.getByRole('menuitem', { name: '退出米游社登录' }).click();
  const logoutDialog = page.getByRole('dialog', { name: '退出米游社登录？' });
  await expect(logoutDialog).toContainText('清除登录状态，不删除已同步角色资料');
  await logoutDialog.getByRole('button', { name: '保留并返回' }).click();
  await expect(page.getByText('登录状态已清除')).toHaveCount(0);
  await expect(maintenanceButton).toBeFocused();

  await maintenanceButton.click();
  await maintenanceMenu.getByRole('menuitem', { name: '退出米游社登录' }).click();
  await logoutDialog.getByRole('button', { name: '清除米游社登录状态' }).click();
  await expect(page.getByText(/登录状态已清除/)).toBeVisible();
  await expect(maintenanceButton).toBeFocused();

  await maintenanceButton.click();
  await maintenanceMenu.getByRole('menuitem', { name: '删除本机角色资料' }).click();
  const deleteDialog = page.getByRole('dialog', { name: '删除脱敏测试账号的本机角色资料？' });
  await expect(deleteDialog).toContainText('UID 100000001');
  await expect(deleteDialog).toContainText('角色、装备面板和同步时间');
  await expect(deleteDialog).toContainText('不会删除游戏账号或游戏内数据');
  await expect(deleteDialog).toContainText('无法撤销');
  await deleteDialog.getByRole('button', { name: '保留并返回' }).click();
  await expect(page.getByText('测试角色', { exact: true })).toBeVisible();
  await expect(maintenanceButton).toBeFocused();

  await expect(page.locator('article').filter({ hasText: '测试角色' }).locator('img')).toHaveCount(
    0
  );
  const characterCard = page.locator('article').filter({ hasText: '测试角色' });
  await expect(characterCard).toContainText('1命');
  await expect(characterCard).toContainText('火元素');
  await expect(characterCard).toContainText('5星');
  await expect(characterCard).toContainText('测试武器 · Lv 90 · 精2');
  await expect(characterCard).toContainText('定位需结合队伍判断');
  await expect(characterCard).toContainText('可参与反应');
  await expect(characterCard).toContainText('蒸发');
  await expect(characterCard).toContainText('融化');
  await expect(characterCard).not.toContainText('主要反应');
  await expect(characterCard).toContainText('面板充能偏低');
  await expect(characterCard).toContainText('实战循环仍需结合队伍产球验证');
  await expect(characterCard.getByTitle('命座')).toBeVisible();
  await expect(characterCard.getByTitle('元素')).toBeVisible();
  await expect(characterCard.getByTitle('稀有度')).toBeVisible();

  const unknownCard = page.locator('article').filter({ hasText: '未知角色' });
  await expect(unknownCard).toContainText('元素未知');
  await expect(unknownCard).toContainText('稀有度未知');
  await expect(unknownCard).not.toContainText('火元素');
  await expect(unknownCard).not.toContainText('1星');
  await expect(unknownCard.getByText('可参与反应')).toHaveCount(0);
  await expect(unknownCard).toContainText('充能资料不足');

  await characterCard.getByRole('button', { name: '查看测试角色详细资料' }).click();
  for (const title of [
    '生命',
    '攻击',
    '防御',
    '暴击率',
    '暴击伤害',
    '元素充能',
    '元素精通',
    '武器',
    '天赋',
    '圣遗物'
  ]) {
    await expect(characterCard.getByTitle(title, { exact: true })).toBeVisible();
  }
  await expect(characterCard.getByText('测试武器 · Lv 90 · 精2')).toHaveCount(2);
  await expect(characterCard.getByText('6 / 9 / 10')).toBeVisible();
  await expect(characterCard.getByText(/测试套装×2/)).toBeVisible();
  await expect(characterCard).toContainText('时之沙');
  await expect(characterCard).toContainText('攻击力 46.6%');
  await expect(characterCard).toContainText('理之冠');
  await expect(characterCard).toContainText('new_stat script 7.7');
  await expect(characterCard).toContainText('持有与等级');
  await expect(characterCard).toContainText('米游社角色清单');
  await expect(characterCard).toContainText('装备资料');
  await expect(characterCard).toContainText('米游社养成资料');
  await expect(characterCard).toContainText('面板数值');
  await expect(characterCard).toContainText('UID 展示柜');
  await expect(characterCard).toContainText('资料更新时间');
  await expect(characterCard.getByText('—', { exact: true }).first()).toBeVisible();
  await expect(characterCard).not.toContainText(/(^|\D)0($|\D)/);

  const searchInput = page.getByRole('searchbox', { name: '搜索角色' });
  await searchInput.fill('不存在');
  await expect(page.getByText('显示 0 / 2 名角色')).toBeVisible();
  await expect(characterCard).toBeHidden();
  await searchInput.fill('测试');
  await expect(page.getByText('显示 1 / 2 名角色')).toBeVisible();
  await page.getByRole('button', { name: '水元素' }).click();
  await expect(characterCard).toBeHidden();
  await page.getByRole('button', { name: '火元素' }).click();
  await expect(characterCard).toBeVisible();
  await searchInput.fill('');
  await expect(unknownCard).toBeHidden();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await expect(unknownCard).toBeVisible();
  await expectNoForbiddenPlayerTerms();
  await characterCard.getByRole('button', { name: '查看测试角色详细资料' }).click();
  await expectPageFitsEveryViewport('Roster expanded detail');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m3-roster-1024x768.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m3-roster-1600x1000.png') });
  await maintenanceButton.click();
  await maintenanceMenu.getByRole('menuitem', { name: '删除本机角色资料' }).click();
  await expectPageFitsEveryViewport('Roster delete dialog');
  await deleteDialog.getByRole('button', { name: '保留并返回' }).click();

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

  await page.getByRole('button', { name: '角色一览' }).click();
  await page.getByRole('button', { name: '账号维护' }).click();
  await page.getByRole('menuitem', { name: '删除本机角色资料' }).click();
  await page
    .getByRole('dialog', { name: '删除脱敏测试账号的本机角色资料？' })
    .getByRole('button', { name: '删除脱敏测试账号的本机角色资料' })
    .click();
  await expect(page.getByText('还没有绑定任何账号。')).toBeVisible();
  expect(rendererErrors).toEqual([]);
});
