import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const rendererExternalRequests: string[] = [];
const observedPages = new WeakSet<Page>();
const FORBIDDEN_PLAYER_TERMS =
  /LLM|Enka|API Key|Base URL|\bpartial\b|\bfallback\b|\bstage\b|team-composer|abyss-mage|ruin-guard|development\.|下一阶段接入|开发中/iu;
const REQUIRED_VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1600, height: 1000 }
] as const;
const VISUAL_SIGNATURES_PATH = path.resolve('tests/e2e/visual-signatures.json');
let visualSignaturesPromise:
  | Promise<Record<string, { hash: string; maxDistance: number }>>
  | undefined;

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
    const shouldCapture = process.env.GTA_E2E_CAPTURE_VIEWPORTS === '1';
    const shouldVerify = process.env.GTA_E2E_VERIFY_VISUALS === '1';
    const shouldPrint = process.env.GTA_E2E_PRINT_VISUAL_SIGNATURES === '1';
    if (shouldCapture || shouldVerify || shouldPrint) {
      const artifactDirectory = path.resolve('test-results/visual-matrix');
      const safeLabel = label.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-');
      const signatureKey = `${safeLabel}-${viewport.width}x${viewport.height}`;
      if (shouldCapture) await mkdir(artifactDirectory, { recursive: true });
      const screenshot = await page.screenshot({
        path: shouldCapture ? path.join(artifactDirectory, `${signatureKey}.png`) : undefined,
        fullPage: false
      });
      const actualHash = await perceptualHash(screenshot);
      if (shouldPrint) {
        console.log(`VISUAL_SIGNATURE ${signatureKey} ${actualHash}`);
      }
      if (shouldVerify) {
        const signatures = await loadVisualSignatures();
        const baseline = signatures[signatureKey];
        if (!baseline) throw new Error(`Missing visual signature for ${signatureKey}`);
        expect(
          hammingDistance(actualHash, baseline.hash),
          `${signatureKey} perceptual change`
        ).toBeLessThanOrEqual(baseline.maxDistance);
      }
    }
  }
}

async function loadVisualSignatures(): Promise<
  Record<string, { hash: string; maxDistance: number }>
> {
  visualSignaturesPromise ??= readFile(VISUAL_SIGNATURES_PATH, 'utf8').then((source) =>
    JSON.parse(source)
  );
  return visualSignaturesPromise;
}

async function perceptualHash(png: Buffer): Promise<string> {
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  return page.evaluate<string>(`new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener('error', () => reject(new Error('Unable to decode visual sample')));
        image.addEventListener('load', () => {
          const width = 17;
          const height = 16;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) {
            reject(new Error('Unable to create visual sampling context'));
            return;
          }
          context.drawImage(image, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height).data;
          let bits = '';
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width - 1; x += 1) {
              const left = (y * width + x) * 4;
              const right = left + 4;
              const leftLuminance =
                pixels[left] * 0.299 + pixels[left + 1] * 0.587 + pixels[left + 2] * 0.114;
              const rightLuminance =
                pixels[right] * 0.299 +
                pixels[right + 1] * 0.587 +
                pixels[right + 2] * 0.114;
              bits += leftLuminance > rightLuminance ? '1' : '0';
            }
          }
          resolve(
            (bits.match(/.{4}/gu) || [])
              .map((nibble) => Number.parseInt(nibble, 2).toString(16))
              .join('')
          );
        });
        image.src = ${JSON.stringify(dataUrl)};
      })`);
}

function hammingDistance(left: string, right: string): number {
  expect(left.length).toBe(right.length);
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let difference =
      Number.parseInt(left.charAt(index), 16) ^ Number.parseInt(right.charAt(index), 16);
    while (difference > 0) {
      distance += difference & 1;
      difference >>>= 1;
    }
  }
  return distance;
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
      GTA_ENABLE_DEVELOPMENT_SCENARIOS: '1',
      GTA_E2E_THEATER_PLANNING_DELAY_MS: '500',
      GTA_E2E_USER_DATA_DIR: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  page = await electronApp.firstWindow();
  launchDurationMs = Date.now() - startedAt;
  observeRenderer(page);
  electronApp.on('window', observeRenderer);
}

function observeRenderer(rendererPage: Page): void {
  if (observedPages.has(rendererPage)) return;
  observedPages.add(rendererPage);
  rendererPage.on('pageerror', (error) => {
    rendererErrors.push(error.message);
  });
  rendererPage.on('request', (request) => {
    if (/^(?:https?|wss?):/iu.test(request.url())) rendererExternalRequests.push(request.url());
  });
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'genshin-team-advisor-e2e-'));
  await launchApp();
});

test.afterAll(async () => {
  expect(rendererErrors).toEqual([]);
  expect(rendererExternalRequests).toEqual([]);
  await electronApp?.close();
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test.afterEach(() => {
  expect(rendererErrors).toEqual([]);
  expect(rendererExternalRequests).toEqual([]);
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
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByText('未配置', { exact: true }).first()).toBeVisible();
  await expectNoForbiddenPlayerTerms();

  await page.getByLabel('新的服务密钥').fill('e2e-api-secret');
  const advancedSettings = page.getByRole('button', {
    name: '高级设置 服务地址、模型编辑、连接诊断、用量与应用更新'
  });
  await advancedSettings.click();
  await expect(advancedSettings).toHaveAttribute('aria-expanded', 'true');
  await page.getByLabel('本次保存时替换附加请求信息').check();
  await page.getByRole('textbox', { name: /附加请求信息/ }).fill('X-E2E-Key: e2e-header-secret');
  await page.getByRole('button', { name: '保存服务设置' }).click();
  await expect(page.getByText('服务设置已保存。')).toBeVisible();
  await expect(page.getByText('已安全保存', { exact: true }).first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('e2e-header-secret');
  const persistedConfig = await readFile(path.join(userDataDir, 'config.json'), 'utf8');
  expect(persistedConfig).not.toContain('e2e-api-secret');
  expect(persistedConfig).not.toContain('e2e-header-secret');

  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '切换语言，当前：中文' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByText('Saved securely', { exact: true }).first()).toBeVisible();
  await expectNoForbiddenPlayerTerms();
  await page.getByRole('button', { name: 'Clear service key', exact: true }).click();
  const clearKeyDialog = page.getByRole('dialog', { name: 'Clear the saved service key?' });
  await expect(clearKeyDialog.getByRole('button', { name: 'Keep and go back' })).toBeFocused();
  await clearKeyDialog.getByRole('button', { name: 'Clear the saved service key' }).click();
  await expect(page.getByText('Not configured', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Account and settings' }).click();
  await page.getByRole('menuitem', { name: 'Switch language, current: English' }).click();

  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '资料绑定' }).click();
  await expect(page.getByRole('heading', { name: /添加角色资料/ })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test('keeps the renderer sandboxed and denies external windows and network', async () => {
  const runtime = await page.evaluate(() => {
    const browser = globalThis as unknown as {
      require?: unknown;
      process?: unknown;
      Buffer?: unknown;
      open: (url: string, target: string) => unknown;
    };
    return {
      requireType: typeof browser.require,
      processType: typeof browser.process,
      bufferType: typeof browser.Buffer,
      openedWindow: browser.open('https://example.invalid', '_blank') !== null
    };
  });
  expect(runtime).toEqual({
    requireType: 'undefined',
    processType: 'undefined',
    bufferType: 'undefined',
    openedWindow: false
  });
  expect(rendererExternalRequests).toEqual([]);
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
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();

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

test('keeps the core keyboard surface named and removes motion when requested', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const accountButton = page.getByRole('button', { name: '账号与设置' });
  await accountButton.click();
  await page.getByRole('menuitem', { name: '资料绑定' }).click();
  const backButton = page.getByRole('button', { name: '返回选择方式' });
  if (await backButton.isVisible().catch(() => false)) await backButton.click();

  const uidMethod = page.getByRole('button', { name: /只用 UID 展示柜/ });
  await uidMethod.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('游戏 UID')).toBeVisible();
  await expect(page.getByRole('heading', { name: '输入游戏 UID' })).toBeVisible();

  const unnamedControls = await page
    .locator('main input, main select, main textarea')
    .evaluateAll((controls) =>
      controls
        .filter((control) => {
          const rect = control.getBoundingClientRect();
          const style = control.ownerDocument.defaultView?.getComputedStyle(control);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
        })
        .filter((control) => {
          const id = control.getAttribute('id');
          const labelled = id ? control.ownerDocument.querySelector(`label[for="${id}"]`) : null;
          const wrappingLabel = control.closest('label');
          return !(
            control.getAttribute('aria-label') ||
            control.getAttribute('aria-labelledby') ||
            labelled ||
            wrappingLabel
          );
        })
        .map((control) => control.outerHTML)
    );
  expect(unnamedControls).toEqual([]);

  const motion = await page
    .locator('main button, main section, main article')
    .evaluateAll((elements) => {
      const durations = (value: string) =>
        value
          .split(',')
          .map((part) => part.trim())
          .map((part) =>
            part.endsWith('ms') ? Number(part.slice(0, -2)) : Number(part.slice(0, -1)) * 1000
          );
      return elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .flatMap((element) => {
          const style = element.ownerDocument.defaultView?.getComputedStyle(element);
          if (!style) return [];
          return [
            ...durations(style.animationDuration),
            ...durations(style.transitionDuration)
          ].filter((duration) => Number.isFinite(duration) && duration > 1.1);
        });
    });
  expect(motion).toEqual([]);
  await page.getByRole('button', { name: '返回选择方式' }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('routes UID-only onboarding through the preload profile refresh contract', async () => {
  const uid = '123456789';
  await electronApp.evaluate(({ ipcMain }, testUid) => {
    const scope = globalThis as typeof globalThis & {
      __gtaM3UidCalls?: Array<{ channel: string; payload: unknown }>;
      __gtaM3UidActivated?: boolean;
    };
    scope.__gtaM3UidCalls = [];
    scope.__gtaM3UidActivated = false;
    const profile = {
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
    };
    ipcMain.removeHandler('profile:refresh');
    ipcMain.handle('profile:refresh', (_event, payload) => {
      scope.__gtaM3UidCalls?.push({ channel: 'profile:refresh', payload });
      return {
        ok: true,
        data: {
          profile,
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
      scope.__gtaM3UidActivated = true;
      return { ok: true, data: { ok: true } };
    });
    ipcMain.removeHandler('profile:state');
    ipcMain.handle('profile:state', () => ({
      ok: true,
      data: scope.__gtaM3UidActivated
        ? {
            activeUid: testUid,
            profiles: [
              {
                uid: testUid,
                nickname: 'UID 测试账号',
                characterCount: 0,
                fetchedAt: profile.fetchedAt
              }
            ]
          }
        : { profiles: [] }
    }));
    ipcMain.removeHandler('profile:get');
    ipcMain.handle('profile:get', () => ({ ok: true, data: profile }));
  }, uid);

  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '资料绑定' }).click();
  await page.getByRole('button', { name: /只用 UID 展示柜/ }).click();
  await page.getByLabel('游戏 UID').fill(uid);
  await page.getByRole('button', { name: '同步展示角色' }).click();
  await expect(page.getByRole('heading', { name: '我的角色' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /UID 测试账号/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByText(/当前没有角色面板数据/)).toBeVisible();

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
        },
        '100000002': {
          schemaVersion: 2,
          uid: '100000002',
          nickname: '备用测试账号',
          source: 'enka',
          fetchedAt,
          characters: [],
          coverage: {
            expectedOwnedCount: 0,
            ownedCount: 0,
            detailedCount: 0,
            buildCount: 0,
            statsCount: 0,
            enkaShowcaseCount: 0,
            missingDetailCount: 0,
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

  const primaryAccountTab = page.getByRole('tab', { name: /脱敏测试账号/ });
  const secondaryAccountTab = page.getByRole('tab', { name: /备用测试账号/ });
  await expect(primaryAccountTab).toHaveAttribute('tabindex', '0');
  await expect(secondaryAccountTab).toHaveAttribute('tabindex', '-1');
  await expect(primaryAccountTab).toHaveAttribute('aria-controls', 'profile-panel');
  await expect(secondaryAccountTab).toHaveAttribute('aria-controls', 'profile-panel');
  await expect(page.locator('#profile-panel')).toHaveCount(1);
  await expect(page.getByRole('tabpanel')).toHaveAttribute(
    'aria-labelledby',
    'profile-tab-100000001'
  );
  await primaryAccountTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(secondaryAccountTab).toBeFocused();
  await expect(secondaryAccountTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(primaryAccountTab).toBeFocused();
  await expect(primaryAccountTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('测试角色', { exact: true })).toBeVisible();

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

  await expect(page.locator('.gta-advisor-advanced')).toHaveCount(0);
  await expect(page.getByText(/abyss-mage|ruin-guard/i)).toHaveCount(0);

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

  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('Advisor details');

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(550);
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m2-challenge-1024x768.png') });

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m2-challenge-1600x1000.png') });

  await page.getByRole('button', { name: '历史记录' }).click();
  await expect(page.getByRole('heading', { name: '推荐记录' })).toBeVisible();
  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('History');

  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('Settings');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m7-settings-1024x768.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m7-settings-1600x1000.png') });

  await page.getByRole('button', { name: '角色一览' }).click();
  await page.getByRole('button', { name: '账号维护' }).click();
  await page.getByRole('menuitem', { name: '删除本机角色资料' }).click();
  await page
    .getByRole('dialog', { name: '删除脱敏测试账号的本机角色资料？' })
    .getByRole('button', { name: '删除脱敏测试账号的本机角色资料' })
    .click();
  await expect(page.getByRole('tab', { name: /备用测试账号/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByText(/当前没有角色面板数据/)).toBeVisible();
  expect(await page.evaluate<string>("document.activeElement?.tagName ?? ''")).not.toBe('BODY');
  expect(rendererErrors).toEqual([]);
});

test('runs the abyss-specific development-sample flow with accessible interventions and fixed twin teams', async () => {
  test.setTimeout(60_000);
  await electronApp.close();
  const fetchedAt = '2026-07-23T00:00:00.000Z';
  const characters = Array.from({ length: 10 }, (_, index) => ({
    id: 1001 + index,
    name: `演练角色${index + 1}`,
    element: [
      'Pyro',
      'Hydro',
      'Anemo',
      'Geo',
      'Cryo',
      'Electro',
      'Dendro',
      'Hydro',
      'Pyro',
      'Cryo'
    ][index],
    rarity: index < 4 ? 5 : 4,
    imageUrl: '',
    level: 90 - index,
    build: {
      stats: {
        hp: 20000 + index * 1000,
        atk: 1200 + index * 100,
        def: 700 + index * 20,
        critRate: 50 + index,
        critDmg: 100 + index * 5,
        energyRecharge: 110 + index * 10,
        elementalMastery: index * 20
      }
    },
    completeness: index < 6 ? 'detailed' : 'build',
    missingFields: index < 6 ? [] : ['weapon', 'artifacts', 'talents'],
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt },
      stats: { source: 'enka', fetchedAt }
    }
  }));
  await writeFile(
    path.join(userDataDir, 'profiles.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeUid: '123456789',
      profilesByUid: {
        '123456789': {
          schemaVersion: 2,
          uid: '123456789',
          nickname: '深渊演练账号',
          source: 'merged',
          fetchedAt,
          characters,
          coverage: {
            expectedOwnedCount: 10,
            ownedCount: 10,
            detailedCount: 6,
            buildCount: 10,
            statsCount: 10,
            enkaShowcaseCount: 10,
            missingDetailCount: 4,
            partial: true
          }
        }
      }
    })
  );
  await launchApp();
  await page.getByRole('button', { name: '挑战配队' }).click();
  await page.getByRole('button', { name: /深境螺旋/ }).click();

  await expect(page.getByText('演练资料，不代表本期')).toBeVisible();
  await expect(page.getByText('演练增益', { exact: true })).toBeVisible();
  await expect(page.getByText('本期祝福', { exact: true })).toHaveCount(0);
  await expect(page.getByText('训练灵体')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(
    /Training Sprite|development\.training|development-sample/
  );
  await expect(page.getByText('原创开发演示效果，不代表任何正式服祝福')).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('heading', { name: '深境螺旋战线' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m4-abyss-input-1024x768.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('heading', { name: '深境螺旋战线' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m4-abyss-input-1600x1000.png') });

  for (const preference of ['操作简单', '生存优先', '低练度', '不换装备']) {
    const chip = page.getByRole('button', { name: preference });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  }
  expect(
    await page
      .getByRole('button', { name: '操作简单' })
      .evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).boxShadow)
  ).not.toBe('none');

  const rosterSearch = page.getByRole('searchbox', { name: '搜索可用角色' });
  await rosterSearch.fill('演练角色1');
  await expect(page.getByText('演练角色1', { exact: true })).toBeVisible();
  await rosterSearch.fill('');
  const firstCharacter = page.getByRole('button', { name: /演练角色1，当前：未设置/ });
  await firstCharacter.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /演练角色1，当前：锁定/ })).toBeFocused();
  const secondCharacter = page.getByRole('button', { name: /演练角色2，当前：未设置/ });
  await secondCharacter.click();
  await page.getByRole('button', { name: /演练角色2，当前：锁定/ }).click();
  await expect(page.getByRole('button', { name: /演练角色2，当前：排除/ })).toBeVisible();

  await page.getByRole('button', { name: '生成上下半方案' }).click();
  await expect(page.getByText('本地规则', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '上半队伍' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '下半队伍' })).toBeVisible();
  const resultCharacters = await page
    .locator('[data-result-character-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-result-character-id')));
  expect(resultCharacters).toHaveLength(8);
  expect(new Set(resultCharacters).size).toBe(8);
  await expect(page.getByText(/循环：根据实战充能调整技能顺序/).first()).toBeVisible();
  await expect(page.getByText(/替换建议：.*重新生成完整双队/).first()).toBeVisible();
  await expect(page.locator('.gta-abyss-progress li').last()).toHaveClass(/is-done/);
  await expectNoForbiddenPlayerTerms();

  await expectPageFitsEveryViewport('Abyss input and result');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('heading', { name: '上下半零重复' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m4-abyss-result-1024x768.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('heading', { name: '上下半零重复' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m4-abyss-result-1600x1000.png') });

  await page.getByRole('button', { name: '操作简单' }).click();
  await expect(page.getByRole('heading', { name: '上下半零重复' })).toBeVisible();
  await expect(page.getByText('待更新', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '只重算上半' })).toBeVisible();
  await expect(page.getByRole('button', { name: '只重算下半' })).toBeVisible();
  await expect(page.getByRole('button', { name: '完整重算' })).toBeVisible();
  const preservedLowerBefore = await page
    .locator('.gta-abyss-result-teams > section')
    .nth(1)
    .locator('[data-result-character-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-result-character-id')));
  await page.getByRole('button', { name: '只重算上半' }).click();
  await expect(page.getByText('待更新', { exact: true })).toHaveCount(0);
  const preservedLowerAfter = await page
    .locator('.gta-abyss-result-teams > section')
    .nth(1)
    .locator('[data-result-character-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-result-character-id')));
  expect(preservedLowerAfter).toEqual(preservedLowerBefore);

  await page.getByRole('button', { name: '历史记录' }).click();
  await expect(page.getByRole('heading', { name: '推荐记录' })).toBeVisible();
  await expect(page.getByText('演练资料', { exact: true }).first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/development\.|development-sample/);
  const abyssHistory = page.getByRole('button', { name: /深境螺旋 12 层/ }).first();
  await abyssHistory.click();
  await expect(page.getByText('循环手法').first()).toBeVisible();
  await expect(page.getByText('上半打法').first()).toBeVisible();
  await expect(page.getByText('风险').first()).toBeVisible();
  await expect(page.getByText('替换建议').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '删除这份方案' })).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m7-history-1024x768.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m7-history-1600x1000.png') });
  await page.getByRole('button', { name: '基于这次方案重新计算' }).click();
  await expect(page.getByText('旧方案已准备', { exact: true })).toBeVisible();
  await expect(page.getByText(/不会自动调用智能服务/)).toBeVisible();
  await expect(page.getByRole('button', { name: '生成上下半方案' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '上下半零重复' })).toHaveCount(0);
});

test('plans three Stygian phases from the development scenario without leaking raw service keys', async () => {
  test.setTimeout(60_000);
  await electronApp.close();
  const fetchedAt = '2026-07-23T00:00:00.000Z';
  const elements = [
    'Pyro',
    'Hydro',
    'Anemo',
    'Geo',
    'Cryo',
    'Electro',
    'Dendro',
    'Hydro',
    'Pyro',
    'Cryo',
    'Electro',
    'Dendro',
    'Anemo',
    'Geo'
  ];
  const characters = elements.map((element, index) => ({
    id: 2001 + index,
    name: `危战角色${index + 1}`,
    element,
    rarity: index < 7 ? 5 : 4,
    imageUrl: '',
    level: 80 + (index % 10),
    build: {
      stats: {
        hp: 17_000 + index * 800,
        atk: 1_100 + index * 80,
        def: 650 + index * 15,
        critRate: 45 + index,
        critDmg: 90 + index * 4,
        energyRecharge: 110 + index * 6,
        elementalMastery: index * 15
      }
    },
    completeness: 'build',
    missingFields: ['weapon', 'artifacts', 'talents'],
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt },
      stats: { source: 'enka', fetchedAt }
    }
  }));
  await writeFile(
    path.join(userDataDir, 'profiles.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeUid: '987654321',
      profilesByUid: {
        '987654321': {
          schemaVersion: 2,
          uid: '987654321',
          nickname: '幽境演练账号',
          source: 'merged',
          fetchedAt,
          characters,
          coverage: {
            expectedOwnedCount: 14,
            ownedCount: 14,
            detailedCount: 0,
            buildCount: 14,
            statsCount: 14,
            enkaShowcaseCount: 14,
            missingDetailCount: 14,
            partial: true
          }
        }
      }
    })
  );
  await launchApp();
  await page.getByRole('button', { name: '挑战配队' }).click();
  await page.getByRole('button', { name: /幽境危战/ }).click();

  await expect(page.getByRole('heading', { name: '幽境危战作战台' })).toBeVisible();
  await expect(page.getByText('演练资料，不代表本期')).toBeVisible();
  await expect(page.getByRole('group', { name: '选择六档难度' }).getByRole('button')).toHaveCount(
    6
  );
  await expect(page.getByRole('group', { name: '选择奖励目标' }).getByRole('button')).toHaveText([
    '拿原石即可',
    '冲高难奖励',
    '挑战极限难度'
  ]);
  await expect(
    page.getByText(
      '应用内目标档位，不代表官方奖励解锁条件；正式场景阈值发布后将优先使用其版本化规则。'
    )
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '演示难度 1' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page.getByRole('button', { name: '冲高难奖励' }).click();
  await expect(page.getByRole('button', { name: '演示难度 5' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: '演示难度 4' })).toBeDisabled();
  await page.getByRole('button', { name: '挑战极限难度' }).click();
  await expect(page.getByRole('button', { name: '演示难度 6' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: '演示难度 5' })).toBeDisabled();
  for (const boss of ['演示首领一', '演示首领二', '演示首领三']) {
    await expect(page.getByRole('heading', { name: boss })).toBeVisible();
  }
  await expect(page.getByText('资料未标注时间、能量或额外增益。')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(
    /Demo Boss|Demo Difficulty|development\.|development-sample|dire-challenge/
  );
  await expect(page.getByRole('button', { name: '取消生成' })).toBeDisabled();

  await page.setViewportSize({ width: 1024, height: 768 });
  const narrowPhasePositions = await page
    .locator('.gta-stygian-phases > article')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(narrowPhasePositions).size).toBe(3);
  await page.getByRole('heading', { name: '幽境危战作战台' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m5-stygian-input-1024x768.png') });

  await page.setViewportSize({ width: 1600, height: 1000 });
  const widePhasePositions = await page
    .locator('.gta-stygian-phases > article')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(widePhasePositions).size).toBe(1);
  await page.getByRole('heading', { name: '幽境危战作战台' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m5-stygian-input-1600x1000.png') });

  await page.getByRole('button', { name: '冲高难奖励' }).click();
  await page.getByRole('button', { name: '生成三阶段方案' }).click();
  await expect(page.getByRole('heading', { name: '三队已按当期规则分配' })).toBeVisible();
  await page.getByRole('button', { name: '改选演示难度 5' }).click();
  await expect(page.getByRole('button', { name: '冲高难奖励' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: '演示难度 5' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('heading', { name: '三队已按当期规则分配' })).toHaveCount(0);
  await page.getByRole('button', { name: '挑战极限难度' }).click();

  for (const preference of ['操作简单', '生存优先', '低练度', '不换装备']) {
    const chip = page.getByRole('button', { name: preference });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  }
  const firstCharacter = page.getByRole('button', { name: /危战角色1，当前：未设置/ });
  await firstCharacter.click();
  await expect(page.getByRole('button', { name: /危战角色1，当前：锁定/ })).toBeVisible();
  const lastCharacter = page.getByRole('button', { name: /危战角色14，当前：未设置/ });
  await lastCharacter.click();
  await page.getByRole('button', { name: /危战角色14，当前：锁定/ }).click();
  await expect(page.getByRole('button', { name: /危战角色14，当前：排除/ })).toBeVisible();

  await page.getByRole('button', { name: '生成三阶段方案' }).click();
  await expect(page.getByRole('heading', { name: '三队已按当期规则分配' })).toBeVisible();
  const resultCharacters = await page
    .locator('[data-stygian-result-character-id]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-stygian-result-character-id'))
    );
  expect(resultCharacters).toHaveLength(12);
  expect(new Set(resultCharacters).size).toBe(12);
  await expect(page.getByText('资料或练度证据不足，建议降低奖励目标')).toBeVisible();
  await expect(page.getByText(/当前已在.*目标的.*最低档/)).toBeVisible();
  await expect(page.getByRole('button', { name: /改选.*难度/ })).toHaveCount(0);
  await expect(page.locator('.gta-stygian-progress li')).toHaveCount(5);
  await expect(page.locator('.gta-stygian-progress li').last()).toHaveClass(/is-done/);
  await expect(page.locator('main')).not.toContainText(/必过|保证通关/);
  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('Stygian input and result');

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('heading', { name: '三队已按当期规则分配' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m5-stygian-result-1024x768.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('heading', { name: '三队已按当期规则分配' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m5-stygian-result-1600x1000.png') });

  await page.getByRole('button', { name: '历史记录' }).click();
  await expect(page.getByRole('heading', { name: '推荐记录' })).toBeVisible();
  await expect(page.getByText('演练资料', { exact: true }).first()).toBeVisible();
  const stygianHistory = page.getByRole('button', { name: /幽境危战 · 演示难度 6/ }).first();
  await stygianHistory.click();
  await expect(page.getByText('第 1 阶段', { exact: true })).toBeVisible();
  await expect(page.getByText('循环手法').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '删除这份方案' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(
    /development\.|development-sample|dire-challenge/
  );
});

test('keeps Theater generation blocked when external actors do not satisfy hard eligibility', async () => {
  test.setTimeout(45_000);
  await electronApp.close();
  const fetchedAt = '2026-07-23T00:00:00.000Z';
  const characters = Array.from({ length: 8 }, (_, index) => ({
    id: 2901 + index,
    name: `资格角色${index + 1}`,
    element: index % 2 === 0 ? 'Anemo' : 'Geo',
    rarity: 4,
    imageUrl: '',
    level: index === 7 ? 60 : 80,
    build: {
      stats: {
        hp: 15_000,
        atk: 1_100,
        def: 650,
        critRate: 40,
        critDmg: 80,
        energyRecharge: 120,
        elementalMastery: 0
      }
    },
    completeness: 'build',
    missingFields: [],
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt },
      stats: { source: 'enka', fetchedAt }
    }
  }));
  await writeFile(
    path.join(userDataDir, 'profiles.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeUid: '135792468',
      profilesByUid: {
        '135792468': {
          schemaVersion: 2,
          uid: '135792468',
          nickname: '资格不足账号',
          source: 'merged',
          fetchedAt,
          characters,
          coverage: {
            expectedOwnedCount: 8,
            ownedCount: 8,
            detailedCount: 0,
            buildCount: 8,
            statsCount: 8,
            enkaShowcaseCount: 8,
            missingDetailCount: 0,
            partial: false
          }
        }
      }
    })
  );
  await launchApp();
  await page.getByRole('button', { name: '挑战配队' }).click();
  await page.getByRole('button', { name: /幻想真境剧诗/ }).click();

  await expect(page.getByText('7 / 8 名可入场')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('还缺 1 名可入场角色');
  await expect(page.getByRole('alert')).toContainText('优先提升 资格角色8 至 70 级可补位');
  await expect(page.getByRole('button', { name: '角色不足，暂不能生成' })).toBeDisabled();
  await page.getByRole('button', { name: /演示试用角色/ }).click();
  await expect(page.getByText('7 / 8 名可入场')).toBeVisible();
  await expect(page.getByRole('button', { name: /演示试用角色/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: '角色不足，暂不能生成' })).toBeDisabled();
  await expect(page.locator('.gta-theater-progress')).toHaveCount(0);
  await expectNoForbiddenPlayerTerms();
});

test('checks Theater eligibility and renders a cast-vigor route instead of team cards', async () => {
  test.setTimeout(60_000);
  await electronApp.close();
  const fetchedAt = '2026-07-23T00:00:00.000Z';
  const elements = [
    'Anemo',
    'Geo',
    'Anemo',
    'Geo',
    'Anemo',
    'Geo',
    'Anemo',
    'Geo',
    'Pyro',
    'Hydro',
    'Geo',
    'Pyro'
  ];
  const characters = elements.map((element, index) => ({
    id: 3001 + index,
    name: `剧诗角色${index + 1}`,
    element,
    rarity: index < 6 ? 5 : 4,
    imageUrl: '',
    level: index === 10 ? 60 : 90 - (index % 4),
    build: {
      stats: {
        hp: 18_000 + index * 500,
        atk: 1_200 + index * 70,
        def: 680 + index * 12,
        critRate: 45 + index,
        critDmg: 90 + index * 4,
        energyRecharge: 115 + index * 4,
        elementalMastery: index * 12
      }
    },
    completeness: index < 8 ? 'detailed' : 'build',
    missingFields: index < 8 ? [] : ['weapon', 'artifacts', 'talents'],
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt },
      stats: { source: 'enka', fetchedAt }
    }
  }));
  await writeFile(
    path.join(userDataDir, 'profiles.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeUid: '246813579',
      profilesByUid: {
        '246813579': {
          schemaVersion: 2,
          uid: '246813579',
          nickname: '剧诗演练账号',
          source: 'merged',
          fetchedAt,
          characters,
          coverage: {
            expectedOwnedCount: 12,
            ownedCount: 12,
            detailedCount: 8,
            buildCount: 12,
            statsCount: 12,
            enkaShowcaseCount: 8,
            missingDetailCount: 4,
            partial: true
          }
        }
      }
    })
  );
  await launchApp();
  await page.getByRole('button', { name: '挑战配队' }).click();
  await page.getByRole('button', { name: /幻想真境剧诗/ }).click();

  await expect(page.getByRole('heading', { name: '幻想真境剧诗手册' })).toBeVisible();
  expect(
    await page
      .getByRole('button', { name: '返回挑战入口' })
      .evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).color)
  ).toBe('rgb(247, 245, 236)');
  await expect(page.getByText('演练资料，不代表本期')).toBeVisible();
  await expect(page.getByText('8 / 8 名可入场')).toBeVisible();
  await expect(page.getByText('当期元素：风、岩')).toBeVisible();
  await expect(page.getByText('演示开幕角色')).toBeVisible();
  await expect(page.getByText('演示试用角色')).toBeVisible();
  await expect(page.getByText('演示特邀角色')).toBeVisible();
  await expect(page.getByText('演示助演角色')).toBeVisible();
  await expect(page.getByText(/开幕、试用与支援演员暂不计入硬资格/)).toBeVisible();
  await page.getByRole('button', { name: /演示特邀角色/ }).click();
  await expect(page.getByText('9 / 8 名可入场')).toBeVisible();
  await expect(
    page.getByText(/自有特邀演员只绕过元素限制，仍需满足最低等级；本次已计入/)
  ).toBeVisible();
  await page.getByRole('button', { name: /演示特邀角色/ }).click();
  await expect(page.getByText('8 / 8 名可入场')).toBeVisible();
  await page.getByText(/查看不符合的自有角色/).click();
  await expect(page.getByText('元素不符合', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('等级不足', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消生成' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '生成剧诗路线' })).toBeEnabled();
  await expect(page.locator('main')).not.toContainText(
    /development\.|development-sample|trial\.1|support\.1|imaginarium-theater/
  );

  await page.setViewportSize({ width: 1024, height: 768 });
  await expectPageFitsEveryViewport('Theater eligibility');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('heading', { name: '幻想真境剧诗手册' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m6-theater-input-1024x768.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('heading', { name: '幻想真境剧诗手册' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m6-theater-input-1600x1000.png') });

  for (const preference of ['操作简单', '生存优先', '低练度']) {
    await page.getByRole('button', { name: preference }).click();
    await expect(page.getByRole('button', { name: preference })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  }
  await page.getByRole('button', { name: /演示试用角色/ }).click();
  await page.getByRole('button', { name: '生成剧诗路线' }).click();
  await expect(page.getByRole('button', { name: /演示试用角色/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /剧诗角色1.*优先纳入/ })).toBeDisabled();
  await expect(page.getByRole('heading', { name: '演员池与活力已排成幕次路线' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '入场演员池' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '逐幕活力预算' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '保留与分支优先级' })).toBeVisible();
  await expect(page.locator('.gta-theater-act-encounters')).toContainText('第 1 波');
  await expect(page.locator('.gta-theater-act-encounters')).toContainText('纸页幻影');
  await expect(page.locator('.gta-theater-act-encounters')).toContainText('100 级');
  await expect(page.getByText('为什么这样安排')).toBeVisible();
  await expect(page.getByText('演示聚敌秘法')).toBeVisible();
  await expect(page.getByText('触发条件：出现分散群怪')).toBeVisible();
  await expect(page.getByText('选择依据：缺少聚怪时优先')).toBeVisible();
  await expect(page.getByText('节点资源消耗：1')).toBeVisible();
  await expect(page.locator('[data-theater-actor-id]')).toHaveCount(9);
  await expect(page.locator('.gta-theater-result-cast')).toContainText('演示试用角色');
  await expect(page.locator('.gta-theater-result-cast')).toContainText('试用演员');
  await expect(page.locator('.gta-theater-progress li')).toHaveCount(5);
  await expect(page.locator('.gta-theater-progress li').last()).toHaveClass(/is-done/);
  await expect(page.locator('main')).not.toContainText(
    /上半队伍|下半队伍|三队已按当期规则分配|team card/i
  );
  await expectNoForbiddenPlayerTerms();
  await expectPageFitsEveryViewport('Theater route');

  await page.setViewportSize({ width: 1024, height: 768 });
  expect(
    await page
      .locator('.gta-theater-route')
      .evaluate(
        (element) => element.ownerDocument.defaultView?.getComputedStyle(element).gridAutoFlow
      )
  ).toBe('row');
  await page.getByRole('heading', { name: '演员池与活力已排成幕次路线' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m6-theater-result-1024x768.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  expect(
    await page
      .locator('.gta-theater-route')
      .evaluate(
        (element) => element.ownerDocument.defaultView?.getComputedStyle(element).gridAutoFlow
      )
  ).toBe('column');
  await page.getByRole('heading', { name: '演员池与活力已排成幕次路线' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'gta-m6-theater-result-1600x1000.png') });

  await page.getByRole('button', { name: '历史记录' }).click();
  await expect(page.getByRole('heading', { name: '推荐记录' })).toBeVisible();
  const theaterHistory = page.getByRole('button', { name: /幻想真境剧诗/ }).first();
  await theaterHistory.click();
  await expect(page.locator('.gta-history-theater-cast')).toContainText('演示试用角色');
  await expect(page.locator('.gta-history-theater-cast')).toContainText('试用演员');
  await expect(page.locator('.gta-history-theater-route')).toContainText('第 1 幕');
  await expect(page.getByText('计划活力').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '当时的路线指引' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '秘法节点预算' })).toBeVisible();
  await expect(page.getByText(/演示聚敌秘法：1/)).toBeVisible();
  await expect(page.getByRole('button', { name: '删除这份方案' })).toBeVisible();
});
