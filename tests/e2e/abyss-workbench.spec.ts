import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test';

import { buildLocalAbyssPlan } from '../../src/main/services/abyss-local-optimizer.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario
} from '../unit/services/abyss-test-fixtures.js';

let electronApp: ElectronApplication | undefined;
let page: Page;
let userDataDir: string;
let rendererErrors: string[];

function smartServiceResult() {
  const result = buildLocalAbyssPlan({
    input: abyssInput({ locale: 'en-US' }),
    scenario: abyssScenario(),
    characters: ABYSS_CHARACTERS
  });
  if (result.status !== 'planned') throw new Error('Expected a planned Abyss E2E fixture');
  return {
    ...result,
    source: 'smart-service' as const,
    memberEvidence: [
      {
        characterId: result.plan.firstHalfTeam.characterIds[0]!,
        half: 'first' as const,
        fitReasons: ['当前角色适合这支队伍的机制需求。'],
        currentBuild: ['当前配装可用。'],
        riskUnknowns: ['暂无。'],
        optionalAdjustments: ['无需强制调整。'],
        sources: []
      }
    ]
  };
}

async function writeActiveProfile(): Promise<void> {
  const fetchedAt = '2026-07-23T00:00:00.000Z';
  await writeFile(
    path.join(userDataDir, 'profiles.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeUid: '123456789',
      profilesByUid: {
        '123456789': {
          schemaVersion: 2,
          uid: '123456789',
          nickname: '深渊行为测试',
          source: 'merged',
          fetchedAt,
          characters: ABYSS_CHARACTERS,
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
}

async function launchAbyssWorkspace(): Promise<void> {
  rendererErrors = [];
  electronApp = undefined;
  electronApp = await electron.launch({
    args: [path.resolve('.')],
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GTA_DISABLE_BACKGROUND_REFRESH: '1',
      GTA_ENABLE_DEVELOPMENT_SCENARIOS: '1',
      GTA_E2E_USER_DATA_DIR: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  page = await electronApp.firstWindow();
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.getByRole('button', { name: '挑战配队' }).click();
  await expect(page.getByRole('heading', { name: '深境螺旋战线' })).toBeVisible({
    timeout: 10_000
  });
}

function getElectronApp(): ElectronApplication {
  if (!electronApp) throw new Error('Electron app is not running');
  return electronApp;
}

async function switchToEnglish(): Promise<void> {
  await page.getByRole('button', { name: '账号与设置' }).click();
  await page.getByRole('menuitem', { name: '切换语言，当前：中文' }).click();
}

async function switchToChinese(): Promise<void> {
  await page.getByRole('button', { name: 'Account and settings' }).click();
  await page.getByRole('menuitem', { name: 'Switch language, current: English' }).click();
}

async function setMainWindowZoom(factor: number): Promise<void> {
  const actual = await getElectronApp().evaluate(({ BrowserWindow }, nextFactor) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('Missing main window');
    window.webContents.setZoomFactor(nextFactor);
    return window.webContents.getZoomFactor();
  }, factor);
  expect(actual).toBeCloseTo(factor, 2);
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'gta-abyss-workbench-e2e-'));
});

test.beforeEach(async () => {
  await writeActiveProfile();
  await launchAbyssWorkspace();
});

test.afterEach(async () => {
  expect(rendererErrors).toEqual([]);
  const app = electronApp;
  electronApp = undefined;
  if (app) {
    await app.close();
  }
});

test.afterAll(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

test('keeps all workbench panels reachable at 150% and 200% Electron zoom', async () => {
  for (const factor of [1.5, 2]) {
    await setMainWindowZoom(factor);
    const metrics = await page.evaluate<{
      clientHeight: number;
      scrollHeight: number;
      workbenchOverflow: string;
    }>(`(() => {
      const workbench = document.querySelector('.abyss-workbench');
      const scrollContainer = document.querySelector('.app-shell');
      if (!workbench || !scrollContainer) throw new Error('Missing workbench scroll surface');
      return {
        clientHeight: scrollContainer.clientHeight,
        scrollHeight: scrollContainer.scrollHeight,
        workbenchOverflow: getComputedStyle(workbench).overflow
      };
    })()`);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.workbenchOverflow).not.toBe('hidden');
    for (const testId of ['abyss-constraints', 'abyss-scenario', 'abyss-results']) {
      await page.getByTestId(testId).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(testId)).toBeInViewport();
    }
  }
});

test('announces clipboard success and rejection without a renderer error', async () => {
  const trace = {
    status: 'completed',
    correlationId: 'e2e-smart-trace',
    startedAt: '2026-07-23T00:00:00.000Z',
    finishedAt: '2026-07-23T00:00:01.000Z',
    model: 'e2e-smart-model',
    finalSource: 'smart-service',
    knowledge: { trusted: 1, ephemeral: 0, unknown: 0, searched: false },
    usage: { inputTokens: 4, outputTokens: 2 },
    stages: [
      {
        stage: 'compose',
        status: 'completed',
        inputSummary: 'team request',
        rawOutput: '{"teams":"validated"}',
        tools: [{ name: 'mcp__genshin__read_profile_cache', status: 'completed' }],
        citationIds: [],
        usage: { inputTokens: 4, outputTokens: 2 },
        durationMs: 1000
      }
    ]
  };
  await getElectronApp().evaluate(({ ipcMain }, nextTrace) => {
    ipcMain.removeHandler('advisor-v2:abyss-latest-trace');
    ipcMain.handle('advisor-v2:abyss-latest-trace', () => ({ ok: true, data: nextTrace }));
  }, trace);
  await page.getByRole('button', { name: '模型运行记录' }).click();
  const dialog = page.getByRole('dialog', { name: '模型运行记录' });
  await expect(dialog).toContainText('队伍构成');
  await expect(dialog).toContainText('读取角色资料');
  const copyRaw = dialog.getByRole('button', { name: '复制模型原文' });

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined }
    });
  });
  await copyRaw.click();
  await expect(dialog.getByRole('status')).toHaveText('模型原文已复制。');

  const errorCount = rendererErrors.length;
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('clipboard denied');
        }
      }
    });
  });
  await copyRaw.click();
  await expect(dialog.getByRole('status')).toHaveText('复制失败，请检查系统剪贴板权限。');
  expect(rendererErrors).toHaveLength(errorCount);
});

test('localizes smart evidence and ignores a late result after cancellation', async () => {
  const smartResult = smartServiceResult();
  await getElectronApp().evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('advisor-v2:abyss-plan');
    ipcMain.handle('advisor-v2:abyss-plan', () => ({ ok: true, data: result }));
  }, smartResult);
  await page.getByRole('button', { name: '生成上下半方案' }).click();
  await expect(page.getByText('AI 已验证', { exact: true })).toBeVisible();
  await switchToEnglish();
  await page.getByRole('tab', { name: 'Evidence' }).click();
  const evidence = page.getByRole('tabpanel', { name: 'Evidence' });
  await expect(evidence).toContainText('Character');
  await expect(evidence).toContainText('Verified fit evidence is available for this member.');
  await expect(evidence).not.toContainText(/测试角色|当前角色适合/u);
  await switchToChinese();

  const { plan: _plan, ...blockedBase } = smartResult;
  void _plan;
  const lateBlockedResult = {
    ...blockedBase,
    status: 'blocked',
    source: 'local-rules',
    issues: [{ code: 'SCENARIO_MISMATCH', path: [], message: '内部场景错误' }]
  };
  await getElectronApp().evaluate(({ ipcMain }, lateResult) => {
    const scope = globalThis as typeof globalThis & {
      __gtaResolveLateAbyss?: () => void;
      __gtaAbyssCancelCalls?: number;
    };
    scope.__gtaAbyssCancelCalls = 0;
    ipcMain.removeHandler('advisor-v2:abyss-plan');
    ipcMain.handle(
      'advisor-v2:abyss-plan',
      () =>
        new Promise((resolve) => {
          scope.__gtaResolveLateAbyss = () => resolve({ ok: true, data: lateResult });
        })
    );
    ipcMain.removeHandler('advisor-v2:abyss-cancel');
    ipcMain.handle('advisor-v2:abyss-cancel', () => {
      scope.__gtaAbyssCancelCalls = (scope.__gtaAbyssCancelCalls ?? 0) + 1;
      return { ok: true, data: { ok: true } };
    });
  }, lateBlockedResult);
  await page.getByRole('button', { name: '保持当前配装' }).click();
  await page.getByRole('button', { name: '完整重算' }).click();
  await page.getByRole('button', { name: '取消生成' }).click();
  await expect(page.locator('.gta-abyss-progress')).toHaveAttribute('data-state', 'cancelled');
  await expect(page.getByRole('heading', { name: '生成已取消' })).toBeVisible();

  await getElectronApp().evaluate(() => {
    const scope = globalThis as typeof globalThis & { __gtaResolveLateAbyss?: () => void };
    scope.__gtaResolveLateAbyss?.();
  });
  await page.evaluate(
    `new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)))`
  );
  await expect(page.getByText('挑战资料已变化')).toHaveCount(0);
  expect(
    await getElectronApp().evaluate(() => {
      const scope = globalThis as typeof globalThis & { __gtaAbyssCancelCalls?: number };
      return scope.__gtaAbyssCancelCalls ?? 0;
    })
  ).toBe(1);
});
