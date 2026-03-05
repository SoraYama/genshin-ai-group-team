import { expect, test } from '@playwright/test';

test('Phase7 web smoke: import, recommend, compare, history, detail, export zip', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();

    if (url.endsWith('/api/mys/validate-cookie') && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, roleCount: 1 })
      });
      return;
    }

    if (url.endsWith('/api/mys/import') && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            uid: '123456789',
            source: 'miyoushe+enka',
            updatedAt: new Date().toISOString(),
            profiles: [
              { id: 1001, name: '胡桃', element: 'Fire', rarity: 5, imageUrl: 'https://enka.network/ui/UI_AvatarIcon_Hutao.png', stats: { level: 90, hp: 35000, atk: 2200, def: 800, critRate: 75, critDmg: 230, energyRecharge: 120, elementalMastery: 120 } },
              { id: 1002, name: '夜兰', element: 'Water', rarity: 5, imageUrl: 'https://enka.network/ui/UI_AvatarIcon_Yelan.png', stats: { level: 90, hp: 41000, atk: 1500, def: 780, critRate: 70, critDmg: 210, energyRecharge: 180, elementalMastery: 80 } },
              { id: 1003, name: '钟离', element: 'Rock', rarity: 5, imageUrl: 'https://enka.network/ui/UI_AvatarIcon_Zhongli.png', stats: { level: 90, hp: 50000, atk: 1300, def: 1000, critRate: 55, critDmg: 150, energyRecharge: 130, elementalMastery: 40 } },
              { id: 1004, name: '行秋', element: 'Water', rarity: 4, imageUrl: 'https://enka.network/ui/UI_AvatarIcon_Xingqiu.png', stats: { level: 90, hp: 22000, atk: 1650, def: 760, critRate: 55, critDmg: 150, energyRecharge: 220, elementalMastery: 60 } }
            ]
          }
        })
      });
      return;
    }

    if (url.endsWith('/api/ai/recommend') && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            source: 'llm',
            summary: '推荐蒸发队。',
            teams: [
              {
                name: '蒸发稳定队',
                characters: [
                  { id: 1001, name: '胡桃', element: 'Fire' },
                  { id: 1002, name: '夜兰', element: 'Water' },
                  { id: 1004, name: '行秋', element: 'Water' },
                  { id: 1003, name: '钟离', element: 'Rock' }
                ],
                reasoning: '稳定输出。',
                rotationTip: '先挂水再输出。'
              }
            ]
          }
        })
      });
      return;
    }

    if (url.endsWith('/api/recommend/compare') && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            diffSummary: 'A 环境更偏好对群，B 环境更偏好单体。',
            left: {
              source: 'llm',
              summary: '环境A推荐',
              teams: [{ name: 'A队', characters: [{ id: 1001, name: '胡桃', element: 'Fire' }], reasoning: 'A', rotationTip: 'A' }]
            },
            right: {
              source: 'llm',
              summary: '环境B推荐',
              teams: [{ name: 'B队', characters: [{ id: 1002, name: '夜兰', element: 'Water' }], reasoning: 'B', rotationTip: 'B' }]
            }
          }
        })
      });
      return;
    }

    if (url.includes('/api/recommend/history') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            items: [
              {
                id: 'rec-1',
                createdAt: new Date().toISOString(),
                uid: '123456789',
                enemyNames: ['abyss-mage'],
                source: 'llm',
                summary: '推荐蒸发队',
                teams: []
              }
            ],
            total: 1,
            offset: 0,
            limit: 20,
            hasMore: false
          }
        })
      });
      return;
    }

    if (url.includes('/api/recommend/history') && method === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, removed: 1 })
      });
      return;
    }

    if (url.endsWith('/api/enemy/current') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { enemies: ['abyss-mage', 'ruin-guard'] } })
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });

  await page.goto('/');

  const cookieInput = page.locator('#cookie-input');
  await cookieInput.fill('ltoken=foo; ltuid=bar;');
  await page.getByRole('button', { name: '校验 Cookie' }).click();
  await expect(page.getByText('Cookie 校验通过')).toBeVisible();

  await page.getByRole('button', { name: '导入角色' }).click();
  await expect(page.getByText('导入完成：UID')).toBeVisible();

  await page.getByRole('button', { name: '生成 AI 配队推荐' }).click();
  await expect(page.getByText('推荐结果（LLM）')).toBeVisible();

  await page.getByRole('button', { name: '查看详情页' }).first().click();
  await expect(page.getByRole('heading', { name: '推荐结果详情页' })).toBeVisible();
  await page.getByRole('button', { name: '关闭详情页' }).click();

  await page.getByRole('button', { name: '生成对比推荐' }).click();
  await expect(page.getByText('对比结论')).toBeVisible();

  await page.getByRole('button', { name: '读取推荐历史' }).click();
  await expect(page.getByRole('heading', { name: '推荐历史' })).toBeVisible();

  const csvDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toContain('.csv');

  const zipDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 ZIP' }).click();
  const zipDownload = await zipDownloadPromise;
  expect(zipDownload.suggestedFilename()).toContain('.zip');
});
