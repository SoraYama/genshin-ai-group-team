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
import type { CharacterProfile, PersistedProfile } from '../../src/shared/domain';

let electronApp: ElectronApplication | undefined;
let page: Page | undefined;
let userDataDir: string | undefined;
let rendererErrors: string[] = [];
let rendererExternalRequests: string[] = [];

async function prepareUserData(): Promise<string> {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'genshin-team-advisor-roster-lifecycle-'));
  return userDataDir;
}

async function launchApp(): Promise<Page> {
  const launchUserDataDir = userDataDir ?? (await prepareUserData());
  electronApp = await electron.launch({
    args: [path.resolve('.')],
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GTA_DISABLE_BACKGROUND_REFRESH: '1',
      GTA_E2E_USER_DATA_DIR: launchUserDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  page = await electronApp.firstWindow();
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  page.on('request', (request) => {
    if (/^(?:https?|wss?):/iu.test(request.url())) {
      rendererExternalRequests.push(request.url());
    }
  });
  return page;
}

test.beforeEach(() => {
  electronApp = undefined;
  page = undefined;
  userDataDir = undefined;
  rendererErrors = [];
  rendererExternalRequests = [];
});

test.afterEach(async () => {
  try {
    expect(rendererErrors).toEqual([]);
    expect(rendererExternalRequests).toEqual([]);
  } finally {
    try {
      await electronApp?.close();
    } finally {
      if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
    }
  }
});

function makeCharacter(
  id: number,
  name: string,
  fetchedAt: string,
  overrides: Partial<CharacterProfile> = {}
): CharacterProfile {
  return {
    id,
    name,
    element: 'Pyro',
    rarity: 5,
    imageUrl: '',
    level: 90,
    completeness: 'basic',
    missingFields: ['stats', 'weapon', 'artifacts', 'talents'],
    provenance: {
      ownership: { source: 'miyoushe-list', fetchedAt }
    },
    ...overrides
  };
}

function makeProfile(
  uid: string,
  nickname: string,
  characterName: string,
  fetchedAt: string
): PersistedProfile {
  return {
    schemaVersion: 2,
    uid,
    nickname,
    level: 60,
    source: 'enka',
    fetchedAt,
    characters: [
      makeCharacter(uid === '100000001' ? 101 : 202, characterName, fetchedAt, {
        element: uid === '100000001' ? 'Pyro' : 'Hydro'
      })
    ],
    coverage: {
      expectedOwnedCount: 1,
      ownedCount: 1,
      detailedCount: 0,
      buildCount: 0,
      statsCount: 0,
      enkaShowcaseCount: 1,
      missingDetailCount: 1,
      partial: true
    }
  };
}

async function persistProfiles(
  profiles: readonly PersistedProfile[],
  activeUid: string
): Promise<void> {
  const lifecycleUserData = userDataDir ?? (await prepareUserData());
  await writeFile(
    path.join(lifecycleUserData, 'profiles.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeUid,
      profilesByUid: Object.fromEntries(profiles.map((profile) => [profile.uid, profile]))
    })
  );
}

test('keeps the current account usable when activation or state reload fails', async () => {
  const uidA = '100000001';
  const uidB = '100000002';
  const profileA = makeProfile(uidA, '账号 A', 'A 保留角色', '2026-07-25T00:00:00.000Z');
  const profileB = makeProfile(uidB, '账号 B', 'B 切换角色', '2026-07-25T00:01:00.000Z');
  await persistProfiles([profileA, profileB], uidA);
  const rosterPage = await launchApp();
  await expect(rosterPage.getByText('A 保留角色', { exact: true })).toBeVisible();

  await electronApp?.evaluate(
    ({ ipcMain }, input) => {
      const scope = globalThis as typeof globalThis & {
        __gtaActivationFailure?: {
          activeUid: string;
          failNextState: boolean;
          setActivePayloads: string[];
        };
      };
      scope.__gtaActivationFailure = {
        activeUid: input.uidA,
        failNextState: false,
        setActivePayloads: []
      };
      ipcMain.removeHandler('profile:set-active');
      ipcMain.handle('profile:set-active', (_event, payload: { uid: string }) => {
        const harness = scope.__gtaActivationFailure;
        if (!harness) throw new Error('Missing activation failure harness');
        harness.setActivePayloads.push(payload.uid);
        if (payload.uid === input.uidB && harness.setActivePayloads.length === 1) {
          return {
            ok: false,
            error: {
              code: 'IPC_UPSTREAM_UNAVAILABLE',
              message: 'simulated set-active failure'
            }
          };
        }
        harness.activeUid = payload.uid;
        if (payload.uid === input.uidB && harness.setActivePayloads.length === 2) {
          harness.failNextState = true;
        }
        return { ok: true, data: { ok: true } };
      });
      ipcMain.removeHandler('profile:state');
      ipcMain.handle('profile:state', () => {
        const harness = scope.__gtaActivationFailure;
        if (!harness) throw new Error('Missing activation failure harness');
        if (harness.failNextState) {
          harness.failNextState = false;
          return {
            ok: false,
            error: {
              code: 'IPC_UPSTREAM_UNAVAILABLE',
              message: 'simulated state reload failure'
            }
          };
        }
        return {
          ok: true,
          data: {
            activeUid: harness.activeUid,
            profiles: input.profiles.map((profile) => ({
              uid: profile.uid,
              nickname: profile.nickname,
              level: profile.level,
              source: profile.source,
              fetchedAt: profile.fetchedAt,
              characterCount: profile.characters.length,
              coverage: profile.coverage
            }))
          }
        };
      });
    },
    { profiles: [profileA, profileB], uidA, uidB }
  );

  const tabA = rosterPage.getByRole('tab', { name: /账号 A/ });
  const tabB = rosterPage.getByRole('tab', { name: /账号 B/ });
  const localizedError = rosterPage.getByRole('alert');

  await tabB.click();
  await expect(localizedError).toHaveText('外部服务暂时不可用，请稍后重试。');
  await expect(tabA).toHaveAttribute('aria-selected', 'true');
  await expect(rosterPage.getByText('A 保留角色', { exact: true })).toBeVisible();

  await tabB.click();
  await expect(localizedError).toHaveText('外部服务暂时不可用，请稍后重试。');
  await expect(tabA).toHaveAttribute('aria-selected', 'true');
  await expect(rosterPage.getByText('A 保留角色', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      electronApp?.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __gtaActivationFailure?: { activeUid: string };
        };
        return scope.__gtaActivationFailure?.activeUid;
      })
    )
    .toBe(uidA);

  await tabB.click();
  await expect(tabB).toHaveAttribute('aria-selected', 'true');
  await expect(rosterPage.getByText('B 切换角色', { exact: true })).toBeVisible();
});

test('keeps deleted UIDs absent when pending refresh and import responses settle', async () => {
  const uidA = '100000001';
  const uidB = '100000002';
  const profileA = makeProfile(uidA, '账号 A', 'A 待刷新角色', '2026-07-25T00:10:00.000Z');
  const profileB = makeProfile(uidB, '账号 B', 'B 待导入角色', '2026-07-25T00:11:00.000Z');
  await persistProfiles([profileA, profileB], uidA);
  const rosterPage = await launchApp();
  await expect(rosterPage.getByText('A 待刷新角色', { exact: true })).toBeVisible();

  await electronApp?.evaluate(
    ({ ipcMain }, input) => {
      type PendingMutation = {
        uid: string;
        revision: number;
        resolve: (value: unknown) => void;
      };
      const scope = globalThis as typeof globalThis & {
        __gtaMutationLifecycle?: {
          activeUid?: string;
          pendingImport?: PendingMutation;
          pendingRefresh?: PendingMutation;
          profiles: Record<string, (typeof input.profiles)[number]>;
          revisions: Record<string, number>;
        };
      };
      const profiles = Object.fromEntries(
        input.profiles.map((profile) => [profile.uid, profile])
      ) as Record<string, (typeof input.profiles)[number]>;
      scope.__gtaMutationLifecycle = {
        activeUid: input.uidA,
        profiles,
        revisions: { [input.uidA]: 0, [input.uidB]: 0 }
      };
      const state = () => {
        const harness = scope.__gtaMutationLifecycle;
        if (!harness) throw new Error('Missing mutation lifecycle harness');
        return {
          activeUid: harness.activeUid,
          profiles: Object.values(harness.profiles).map((profile) => ({
            uid: profile.uid,
            nickname: profile.nickname,
            level: profile.level,
            source: profile.source,
            fetchedAt: profile.fetchedAt,
            characterCount: profile.characters.length,
            coverage: profile.coverage
          }))
        };
      };
      ipcMain.removeHandler('profile:state');
      ipcMain.handle('profile:state', () => ({ ok: true, data: state() }));
      ipcMain.removeHandler('profile:get');
      ipcMain.handle('profile:get', (_event, payload: { uid: string }) => ({
        ok: true,
        data: scope.__gtaMutationLifecycle?.profiles[payload.uid] ?? null
      }));
      ipcMain.removeHandler('profile:refresh');
      ipcMain.handle('profile:refresh', (_event, payload: { uid: string }) => {
        const harness = scope.__gtaMutationLifecycle;
        if (!harness) throw new Error('Missing mutation lifecycle harness');
        return new Promise((resolve) => {
          harness.pendingRefresh = {
            uid: payload.uid,
            revision: harness.revisions[payload.uid] ?? 0,
            resolve
          };
        });
      });
      ipcMain.removeHandler('profile:import-from-session');
      ipcMain.handle('profile:import-from-session', (_event, payload: { uid?: string }) => {
        const harness = scope.__gtaMutationLifecycle;
        if (!harness || !payload.uid) throw new Error('Missing import target');
        return new Promise((resolve) => {
          harness.pendingImport = {
            uid: payload.uid as string,
            revision: harness.revisions[payload.uid as string] ?? 0,
            resolve
          };
        });
      });
      ipcMain.removeHandler('profile:delete');
      ipcMain.handle('profile:delete', (_event, payload: { uid: string }) => {
        const harness = scope.__gtaMutationLifecycle;
        if (!harness) throw new Error('Missing mutation lifecycle harness');
        harness.revisions[payload.uid] = (harness.revisions[payload.uid] ?? 0) + 1;
        delete harness.profiles[payload.uid];
        if (harness.activeUid === payload.uid) {
          harness.activeUid = Object.keys(harness.profiles)[0];
        }
        return { ok: true, data: { ok: true } };
      });
    },
    { profiles: [profileA, profileB], uidA, uidB }
  );

  const pendingMutation = (kind: 'pendingRefresh' | 'pendingImport') =>
    electronApp?.evaluate((_electron, pendingKind) => {
      const scope = globalThis as typeof globalThis & {
        __gtaMutationLifecycle?: {
          pendingImport?: { uid: string };
          pendingRefresh?: { uid: string };
        };
      };
      return scope.__gtaMutationLifecycle?.[pendingKind]?.uid;
    }, kind);
  const resolveMutation = (kind: 'pendingRefresh' | 'pendingImport', profile: PersistedProfile) =>
    electronApp?.evaluate(
      (_electron, input) => {
        type PendingMutation = {
          uid: string;
          revision: number;
          resolve: (value: unknown) => void;
        };
        const scope = globalThis as typeof globalThis & {
          __gtaMutationLifecycle?: {
            activeUid?: string;
            pendingImport?: PendingMutation;
            pendingRefresh?: PendingMutation;
            profiles: Record<string, typeof input.profile>;
            revisions: Record<string, number>;
          };
        };
        const harness = scope.__gtaMutationLifecycle;
        const pending = harness?.[input.kind];
        if (!harness || !pending) throw new Error(`Missing ${input.kind}`);
        harness[input.kind] = undefined;
        if ((harness.revisions[pending.uid] ?? 0) !== pending.revision) {
          pending.resolve({
            ok: false,
            error: {
              code: 'IPC_SELECTION_CHANGED',
              message: 'stale profile mutation'
            }
          });
          return;
        }
        harness.revisions[pending.uid] = pending.revision + 1;
        harness.profiles[pending.uid] = input.profile;
        if (input.kind === 'pendingImport') harness.activeUid = pending.uid;
        pending.resolve(
          input.kind === 'pendingRefresh'
            ? {
                ok: true,
                data: {
                  profile: input.profile,
                  summary: {
                    enka: 'ok',
                    enkaCharacterCount: input.profile.characters.length,
                    miyoushe: 'no-cookie',
                    miyousheCharacterCount: 0,
                    totalCharacterCount: input.profile.characters.length
                  }
                }
              }
            : { ok: true, data: input.profile }
        );
      },
      { kind, profile }
    );

  await rosterPage.getByRole('button', { name: '更新角色资料' }).click();
  await expect.poll(() => pendingMutation('pendingRefresh')).toBe(uidA);
  await rosterPage.getByRole('button', { name: '账号维护' }).click();
  await expect(rosterPage.getByRole('menuitem', { name: '删除本机角色资料' })).toBeDisabled();
  await rosterPage.evaluate((uid) => {
    const renderer = globalThis as unknown as {
      api: { profile: { delete: (input: { uid: string }) => Promise<unknown> } };
    };
    return renderer.api.profile.delete({ uid });
  }, uidA);
  await resolveMutation(
    'pendingRefresh',
    makeProfile(uidA, '账号 A', 'A 迟到刷新角色', '2026-07-25T00:12:00.000Z')
  );
  await expect(rosterPage.getByRole('alert')).toHaveText(
    '本地数据在请求期间发生变化，本次结果未提交。请刷新后重试。'
  );
  await expect
    .poll(() => rosterPage.evaluate('window.api.profile.state()'))
    .toMatchObject({ activeUid: uidB, profiles: [{ uid: uidB }] });

  const importPromise = rosterPage.evaluate(async (uid) => {
    const renderer = globalThis as unknown as {
      api: {
        profile: {
          importFromSession: (input: { sessionId: string; uid: string }) => Promise<unknown>;
        };
      };
    };
    try {
      await renderer.api.profile.importFromSession({ sessionId: 'pending-session', uid });
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        code:
          typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      };
    }
  }, uidB);
  await expect.poll(() => pendingMutation('pendingImport')).toBe(uidB);
  await rosterPage.evaluate((uid) => {
    const renderer = globalThis as unknown as {
      api: { profile: { delete: (input: { uid: string }) => Promise<unknown> } };
    };
    return renderer.api.profile.delete({ uid });
  }, uidB);
  await resolveMutation(
    'pendingImport',
    makeProfile(uidB, '账号 B', 'B 迟到导入角色', '2026-07-25T00:13:00.000Z')
  );
  await expect(importPromise).resolves.toEqual({
    ok: false,
    code: 'IPC_SELECTION_CHANGED'
  });
  await expect
    .poll(() => rosterPage.evaluate('window.api.profile.state()'))
    .toEqual({ activeUid: undefined, profiles: [] });
});

test('keeps roster content and delete target aligned with the latest active profile request', async () => {
  const rosterPage = await launchApp();
  const uidA = '100000001';
  const uidB = '100000002';
  const initialA = makeProfile(uidA, '账号 A', 'A 初始角色', '2026-07-25T01:00:00.000Z');

  await electronApp?.evaluate(
    ({ ipcMain }, input) => {
      type PendingProfileGet = {
        id: number;
        uid: string;
        resolve: (value: unknown) => void;
      };
      const scope = globalThis as typeof globalThis & {
        __gtaRosterRace?: {
          activeUid: string;
          deletePayloads: string[];
          nextId: number;
          pending: PendingProfileGet[];
          pendingImport?: {
            uid: string;
            resolve: (value: unknown) => void;
          };
          setActivePayloads: string[];
        };
      };
      scope.__gtaRosterRace = {
        activeUid: input.uidA,
        deletePayloads: [],
        nextId: 1,
        pending: [],
        setActivePayloads: []
      };
      ipcMain.removeHandler('profile:state');
      ipcMain.handle('profile:state', () => ({
        ok: true,
        data: {
          activeUid: scope.__gtaRosterRace?.activeUid,
          profiles: [
            {
              uid: input.uidA,
              nickname: '账号 A',
              characterCount: 1,
              fetchedAt: input.initialFetchedAt
            },
            {
              uid: input.uidB,
              nickname: '账号 B',
              characterCount: 1,
              fetchedAt: input.initialFetchedAt
            }
          ]
        }
      }));
      ipcMain.removeHandler('profile:set-active');
      ipcMain.handle('profile:set-active', (_event, payload: { uid: string }) => {
        if (scope.__gtaRosterRace) {
          scope.__gtaRosterRace.activeUid = payload.uid;
          scope.__gtaRosterRace.setActivePayloads.push(payload.uid);
        }
        return { ok: true, data: { ok: true } };
      });
      ipcMain.removeHandler('profile:get');
      ipcMain.handle('profile:get', (_event, payload: { uid: string }) => {
        const race = scope.__gtaRosterRace;
        if (!race) throw new Error('Missing roster race harness');
        return new Promise((resolve) => {
          race.pending.push({ id: race.nextId, uid: payload.uid, resolve });
          race.nextId += 1;
        });
      });
      ipcMain.removeHandler('miyoushe:login-via-browser');
      ipcMain.handle('miyoushe:login-via-browser', () => ({
        ok: true,
        data: {
          ok: true,
          bind: {
            ok: true,
            roles: [{ gameUid: input.uidA, region: 'cn_gf01', nickname: '账号 A' }]
          },
          sessionId: 'race-session'
        }
      }));
      ipcMain.removeHandler('profile:import-from-session');
      ipcMain.handle(
        'profile:import-from-session',
        (_event, payload: { sessionId: string; uid?: string }) => {
          const race = scope.__gtaRosterRace;
          if (!race || !payload.uid) throw new Error('Missing roster import race harness');
          return new Promise((resolve) => {
            race.pendingImport = { uid: payload.uid as string, resolve };
          });
        }
      );
      ipcMain.removeHandler('profile:delete');
      ipcMain.handle('profile:delete', (_event, payload: { uid: string }) => {
        scope.__gtaRosterRace?.deletePayloads.push(payload.uid);
        return { ok: true, data: { ok: true } };
      });
    },
    { initialFetchedAt: initialA.fetchedAt, uidA, uidB }
  );

  const pendingRequests = () =>
    electronApp?.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __gtaRosterRace?: {
          pending: Array<{ id: number; uid: string }>;
        };
      };
      return (scope.__gtaRosterRace?.pending ?? []).map(({ id, uid }) => ({ id, uid }));
    });
  const resolveProfileGet = (id: number, profile: PersistedProfile) =>
    electronApp?.evaluate(
      (_electron, input) => {
        const scope = globalThis as typeof globalThis & {
          __gtaRosterRace?: {
            pending: Array<{
              id: number;
              resolve: (value: unknown) => void;
            }>;
          };
        };
        const pending = scope.__gtaRosterRace?.pending;
        const index = pending?.findIndex((request) => request.id === input.id) ?? -1;
        if (!pending || index < 0) throw new Error(`Missing profile request ${input.id}`);
        const [request] = pending.splice(index, 1);
        request?.resolve({ ok: true, data: input.profile });
      },
      { id, profile }
    );
  const pendingImportUid = () =>
    electronApp?.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __gtaRosterRace?: { pendingImport?: { uid: string } };
      };
      return scope.__gtaRosterRace?.pendingImport?.uid;
    });
  const resolveProfileImport = (profile: PersistedProfile) =>
    electronApp?.evaluate((_electron, importedProfile) => {
      const scope = globalThis as typeof globalThis & {
        __gtaRosterRace?: {
          activeUid: string;
          pendingImport?: { resolve: (value: unknown) => void };
        };
      };
      const race = scope.__gtaRosterRace;
      if (!race?.pendingImport) throw new Error('Missing pending profile import');
      const { resolve } = race.pendingImport;
      race.pendingImport = undefined;
      race.activeUid = importedProfile.uid;
      resolve({ ok: true, data: importedProfile });
    }, profile);
  const observedMutations = () =>
    electronApp?.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __gtaRosterRace?: {
          activeUid: string;
          deletePayloads: string[];
          setActivePayloads: string[];
        };
      };
      const race = scope.__gtaRosterRace;
      return {
        activeUid: race?.activeUid,
        deletePayloads: race?.deletePayloads ?? [],
        setActivePayloads: race?.setActivePayloads ?? []
      };
    });

  await rosterPage.reload();
  await expect.poll(pendingRequests).toEqual([{ id: 1, uid: uidA }]);
  await resolveProfileGet(1, initialA);
  await expect(rosterPage.getByText('A 初始角色', { exact: true })).toBeVisible();

  const tabA = rosterPage.getByRole('tab', { name: /账号 A/ });
  const tabB = rosterPage.getByRole('tab', { name: /账号 B/ });
  await tabA.click();
  await expect(rosterPage.getByText('A 初始角色', { exact: true })).toBeVisible();
  await expect.poll(pendingRequests).toEqual([]);

  await tabB.click();
  await expect(tabB).toHaveAttribute('aria-selected', 'true');
  await expect(rosterPage.getByText('A 初始角色', { exact: true })).toBeHidden();
  await expect.poll(pendingRequests).toEqual([{ id: 2, uid: uidB }]);

  await tabA.click();
  await expect(tabA).toHaveAttribute('aria-selected', 'true');
  await expect.poll(pendingRequests).toEqual([
    { id: 2, uid: uidB },
    { id: 3, uid: uidA }
  ]);
  const latestA = makeProfile(uidA, '账号 A', 'A 最新角色', '2026-07-25T01:02:00.000Z');
  await resolveProfileGet(3, latestA);
  await expect(rosterPage.getByText('A 最新角色', { exact: true })).toBeVisible();
  await resolveProfileGet(2, makeProfile(uidB, '账号 B', 'B 迟到角色', '2026-07-25T01:01:00.000Z'));
  await expect(rosterPage.getByText('B 迟到角色', { exact: true })).toBeHidden();
  await expect(rosterPage.getByText('A 最新角色', { exact: true })).toBeVisible();

  await rosterPage.getByRole('button', { name: '账号与设置' }).click();
  await rosterPage.getByRole('menuitem', { name: '切换语言，当前：中文' }).click();
  await rosterPage.getByRole('button', { name: 'Account and settings' }).click();
  await rosterPage.getByRole('menuitem', { name: 'Switch language, current: English' }).click();
  await expect.poll(pendingRequests).toEqual([
    { id: 4, uid: uidA },
    { id: 5, uid: uidA }
  ]);
  const localizedA = makeProfile(uidA, '账号 A', 'A 当前语言角色', '2026-07-25T01:04:00.000Z');
  await resolveProfileGet(5, localizedA);
  await expect(rosterPage.getByText('A 当前语言角色', { exact: true })).toBeVisible();
  await resolveProfileGet(
    4,
    makeProfile(uidB, '账号 B', '错误 UID 迟到角色', '2026-07-25T01:03:00.000Z')
  );
  await expect(rosterPage.getByText('错误 UID 迟到角色', { exact: true })).toBeHidden();
  await expect(rosterPage.getByText('A 当前语言角色', { exact: true })).toBeVisible();

  await rosterPage.getByRole('button', { name: '账号维护' }).click();
  await rosterPage.getByRole('menuitem', { name: '删除本机角色资料' }).click();
  const deleteDialog = rosterPage.getByRole('dialog', {
    name: '删除账号 A的本机角色资料？'
  });
  await expect(deleteDialog).toContainText(`目标：UID ${uidA}`);
  await deleteDialog.getByRole('button', { name: '保留并返回' }).click();

  await rosterPage.getByRole('button', { name: '账号维护' }).click();
  await rosterPage.getByRole('menuitem', { name: '更换登录账号' }).click();
  await expect.poll(pendingImportUid).toBe(uidA);

  await tabB.click();
  await expect.poll(pendingRequests).toEqual([{ id: 6, uid: uidB }]);
  const currentB = makeProfile(uidB, '账号 B', 'B 当前角色', '2026-07-25T01:05:00.000Z');
  await resolveProfileGet(6, currentB);
  await expect(tabB).toHaveAttribute('aria-selected', 'true');
  await expect(rosterPage.getByText('B 当前角色', { exact: true })).toBeVisible();

  await resolveProfileImport(
    makeProfile(uidA, '账号 A', 'A 登录迟到角色', '2026-07-25T01:06:00.000Z')
  );
  await expect.poll(async () => (await observedMutations())?.activeUid).toBe(uidB);
  await expect(tabB).toHaveAttribute('aria-selected', 'true');
  await expect(rosterPage.getByText('B 当前角色', { exact: true })).toBeVisible();
  await expect(rosterPage.getByText('A 登录迟到角色', { exact: true })).toBeHidden();
  await expect
    .poll(() =>
      rosterPage.evaluate<string>('window.api.profile.state().then((state) => state.activeUid)')
    )
    .toBe(uidB);

  await rosterPage.getByRole('button', { name: '账号维护' }).click();
  await rosterPage.getByRole('menuitem', { name: '删除本机角色资料' }).click();
  await rosterPage
    .getByRole('dialog', { name: '删除账号 B的本机角色资料？' })
    .getByRole('button', { name: '删除账号 B的本机角色资料' })
    .click();
  await expect.poll(async () => (await observedMutations())?.deletePayloads).toEqual([uidB]);
});

test('reconciles a passively removed drawer and retries portraits on a new profile revision', async () => {
  const lifecycleUserData = await prepareUserData();
  const fetchedAt = '2026-07-25T02:00:00.000Z';
  const removable = makeCharacter(301, '可移除角色', fetchedAt);
  const retrying = makeCharacter(302, '重试角色', fetchedAt, {
    element: 'Hydro',
    imageUrl: 'gtai-img://avatar/UI_AvatarIcon_E2ERetry.png'
  });
  const initialProfile: PersistedProfile = {
    schemaVersion: 2,
    uid: '100000001',
    nickname: '生命周期账号',
    source: 'enka',
    fetchedAt,
    characters: [removable, retrying],
    coverage: {
      expectedOwnedCount: 2,
      ownedCount: 2,
      detailedCount: 0,
      buildCount: 0,
      statsCount: 0,
      enkaShowcaseCount: 2,
      missingDetailCount: 2,
      partial: true
    }
  };
  await writeFile(
    path.join(lifecycleUserData, 'profiles.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeUid: initialProfile.uid,
      profilesByUid: { [initialProfile.uid]: initialProfile }
    })
  );
  const rosterPage = await launchApp();
  const removableTile = rosterPage.getByTestId('character-tile').filter({
    hasText: removable.name
  });
  const retryPortraitTile = rosterPage.getByTestId('character-tile').filter({
    hasText: retrying.name
  });
  await expect(retryPortraitTile.locator('.character-tile__portrait.has-image img')).toHaveCount(0);

  const iconCacheDirectory = path.join(lifecycleUserData, 'cache', 'icons');
  await mkdir(iconCacheDirectory, { recursive: true });
  await writeFile(
    path.join(iconCacheDirectory, 'UI_AvatarIcon_E2ERetry.png'),
    await readFile(path.resolve('resources/official/genshin-elements/hydro.png'))
  );
  const removedProfile: PersistedProfile = {
    ...initialProfile,
    fetchedAt: '2026-07-25T02:01:00.000Z',
    characters: [retrying],
    coverage: {
      ...initialProfile.coverage,
      ownedCount: 1,
      enkaShowcaseCount: 1,
      missingDetailCount: 1
    }
  };
  const reappearedProfile: PersistedProfile = {
    ...initialProfile,
    fetchedAt: '2026-07-25T02:02:00.000Z'
  };
  await electronApp?.evaluate(
    ({ ipcMain }, profiles) => {
      const scope = globalThis as typeof globalThis & {
        __gtaRosterRefreshQueue?: typeof profiles;
      };
      scope.__gtaRosterRefreshQueue = profiles;
      ipcMain.removeHandler('profile:refresh');
      ipcMain.handle('profile:refresh', () => {
        const profile = scope.__gtaRosterRefreshQueue?.shift();
        if (!profile) throw new Error('Missing queued roster refresh response');
        return {
          ok: true,
          data: {
            profile,
            summary: {
              enka: 'ok',
              enkaCharacterCount: profile.characters.length,
              miyoushe: 'no-cookie',
              miyousheCharacterCount: 0,
              totalCharacterCount: profile.characters.length
            }
          }
        };
      });
    },
    [removedProfile, reappearedProfile]
  );

  await removableTile.click();
  const removableDrawer = rosterPage.getByRole('dialog', {
    name: `${removable.name}资料`
  });
  await expect(removableDrawer).toBeVisible();
  await rosterPage
    .getByRole('button', { name: '更新角色资料' })
    .evaluate((button: { click: () => void }) => button.click());

  await expect(removableDrawer).toBeHidden();
  await expect(rosterPage.getByRole('searchbox', { name: '搜索角色' })).toBeFocused();
  expect(
    await rosterPage.evaluate<{ grid: string; shell: string }>(`({
      grid: getComputedStyle(document.querySelector('.roster-grid')).overflowY,
      shell: getComputedStyle(document.querySelector('.app-shell')).overflowY
    })`)
  ).toEqual({ grid: 'auto', shell: 'auto' });
  await expect(retryPortraitTile.locator('.character-tile__portrait.has-image img')).toBeVisible();

  await rosterPage.getByRole('button', { name: '更新角色资料' }).click();
  await expect(removableTile).toBeVisible();
  await expect(removableDrawer).toBeHidden();
});
