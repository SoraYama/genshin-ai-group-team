# 米游社设备指纹恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为国服 Battle Chronicle 增加稳定设备档案、官方 `getFp` 刷新、5003 单次 Chromium 重放及跨启动 72 小时失败冷却，同时保留养成计算器降级。

**Architecture:** 新增纯函数设备档案模块、只存脱敏状态的冷却存储和单例 `MiyousheDeviceFpService`。登录完成/启动恢复时以有界超时、非致命方式补齐指纹；`MiyousheGameRecordClient` 只在国服 5003 时强制刷新一次，并用新 Cookie、新 DS 通过 Chromium 重放。服务在主进程内缓存最新指纹并合并并发刷新，防止旧 Cookie 副本和并行批次重复触发。

**Tech Stack:** Electron 43 session cookies、TypeScript 5.8、undici、electron-store、Vitest、tsup。

---

## 文件结构

- Create: `src/main/services/miyoushe/device-profile.ts` — 设备 Cookie 白名单解析、稳定档案补齐、Cookie 合并及 Android `ext_fields` 构造。
- Create: `src/main/services/miyoushe/device-fp-recovery-store.ts` — 仅持久化设备 ID 哈希、失败时间和失败类别的 72 小时冷却。
- Create: `src/main/services/miyoushe/device-fp.ts` — `getFp` 调用、响应校验、single-flight、内存最新指纹覆盖和脱敏事件。
- Modify: `src/main/services/miyoushe-login-window.ts` — 向持久化分区写入四种白名单设备 Cookie。
- Modify: `src/main/services/miyoushe-game-record.ts` — 区分 1034 与 5003；5003 接入设备恢复并只重放一次。
- Modify: `src/main/ipc/profile.ipc.ts` — 浏览器登录成功后非阻塞式补齐设备档案，并让内存 session 使用更新后的 Cookie。
- Modify: `src/main/index.ts` — 创建一个共享的设备指纹服务，注入登录、启动恢复和 Battle Chronicle 客户端。
- Modify: `src/main/gates/miyoushe-detail-gate.ts` — 真实账号 Gate 使用同一恢复链路并只输出脱敏诊断。
- Modify: `docs/data-acquisition.md` — 说明自动恢复、72 小时冷却和计算器降级。
- Create: `tests/unit/services/miyoushe-device-profile.spec.ts`
- Create: `tests/unit/services/miyoushe-device-fp-recovery-store.spec.ts`
- Create: `tests/unit/services/miyoushe-device-fp.spec.ts`
- Modify: `tests/unit/services/miyoushe-login-window.spec.ts`
- Modify: `tests/unit/services/miyoushe-game-record.spec.ts`
- Modify: `tests/unit/ipc/profile.ipc.spec.ts`

### Task 1: 稳定设备档案纯函数

**Files:**

- Create: `src/main/services/miyoushe/device-profile.ts`
- Create: `tests/unit/services/miyoushe-device-profile.spec.ts`

- [ ] **Step 1: 写失败测试，锁定“复用已有字段、只补缺失字段”**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildDeviceFpPayload,
  ensureStableDeviceProfile,
  mergeDeviceCookies
} from '../../../src/main/services/miyoushe/device-profile.js';

describe('ensureStableDeviceProfile', () => {
  it('keeps an existing device identity unchanged', () => {
    const result = ensureStableDeviceProfile(
      'ltoken_v2=secret; _MHYUUID=device-a; DEVICEFP=fp-a; ' +
        'DEVICEFP_SEED_ID=seed-a; DEVICEFP_SEED_TIME=1700000000000',
      { now: () => 1800000000000, randomUuid: () => 'unused', randomHex: () => 'unused' }
    );
    expect(result.updates).toEqual({});
    expect(result.profile).toEqual({
      deviceId: 'device-a',
      deviceFp: 'fp-a',
      seedId: 'seed-a',
      seedTime: '1700000000000'
    });
  });

  it('fills missing stable values exactly once without losing auth cookies', () => {
    const first = ensureStableDeviceProfile('ltoken_v2=secret', {
      now: () => 1800000000000,
      randomUuid: () => 'generated-device',
      randomHex: () => '0123456789abcdef'
    });
    const cookie = mergeDeviceCookies('ltoken_v2=secret', first.updates);
    const second = ensureStableDeviceProfile(cookie, {
      now: () => 1900000000000,
      randomUuid: () => 'must-not-be-used',
      randomHex: () => 'must-not-be-used'
    });
    expect(cookie).toContain('ltoken_v2=secret');
    expect(second.updates).toEqual({});
    expect(second.profile).toEqual(first.profile);
  });

  it('builds the documented getFp envelope with deterministic ext_fields', () => {
    const profile = {
      deviceId: 'device-a',
      seedId: 'seed-a',
      seedTime: '1700000000000',
      deviceFp: 'fp-a'
    };
    const first = buildDeviceFpPayload(profile);
    const second = buildDeviceFpPayload(profile);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      device_id: 'device-a',
      seed_id: 'seed-a',
      seed_time: '1700000000000',
      platform: '2',
      device_fp: 'fp-a',
      app_name: 'bbs_cn'
    });
    expect(JSON.parse(first.ext_fields)).toMatchObject({
      cpuType: 'arm64-v8a',
      manufacturer: 'Xiaomi',
      sdkVersion: '33',
      board: 'kalama'
    });
  });
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `npx vitest run tests/unit/services/miyoushe-device-profile.spec.ts`

Expected: FAIL，提示无法解析 `miyoushe/device-profile.js`。

- [ ] **Step 3: 实现白名单类型、档案补齐、Cookie 合并和请求体构造**

```ts
export const DEVICE_COOKIE_NAMES = [
  '_MHYUUID',
  'DEVICEFP',
  'DEVICEFP_SEED_ID',
  'DEVICEFP_SEED_TIME'
] as const;
export type MiyousheDeviceCookieName = (typeof DEVICE_COOKIE_NAMES)[number];
export type DeviceCookieUpdates = Partial<Record<MiyousheDeviceCookieName, string>>;

export interface StableDeviceProfile {
  deviceId: string;
  deviceFp: string;
  seedId: string;
  seedTime: string;
}

export function ensureStableDeviceProfile(
  cookie: string,
  deps = productionDeps
): {
  profile: StableDeviceProfile;
  updates: DeviceCookieUpdates;
} {
  const values = parseCookie(cookie);
  const deviceId = values.get('_MHYUUID') ?? deps.randomUuid();
  const seedId = values.get('DEVICEFP_SEED_ID') ?? deps.randomHex();
  const seedTime = values.get('DEVICEFP_SEED_TIME') ?? String(deps.now());
  const deviceFp = values.get('DEVICEFP') ?? sha256(deviceId).slice(0, 13);
  const updates: DeviceCookieUpdates = {};
  if (!values.get('_MHYUUID')) updates._MHYUUID = deviceId;
  if (!values.get('DEVICEFP_SEED_ID')) updates.DEVICEFP_SEED_ID = seedId;
  if (!values.get('DEVICEFP_SEED_TIME')) updates.DEVICEFP_SEED_TIME = seedTime;
  return { profile: { deviceId, deviceFp, seedId, seedTime }, updates };
}

export function mergeDeviceCookies(cookie: string, updates: DeviceCookieUpdates): string {
  const values = parseCookie(cookie);
  for (const [name, value] of Object.entries(updates)) values.set(name, value);
  return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
}
```

`buildDeviceFpPayload()` 必须输出 UIGF 所列 `platform: '2'` 必填字段；`aaid`、`oaid`、`vaid`、model/productName 由 `sha256(deviceId)` 确定性派生，其余 Android 基线字段使用固定常量。不得读取真实硬件信息，不得包含 Cookie。参考：[UIGF getFp 字段定义](https://uigf.org/zh/mihoyo-api-collection/hoyolab/login/password_hoyolab.html) 和 [社区现行请求实现](https://greasyfork.org/en/scripts/544867-zzz-seelie-%E6%95%B0%E6%8D%AE%E5%90%8C%E6%AD%A5/code)。

- [ ] **Step 4: 运行测试并确认通过**

Run: `npx vitest run tests/unit/services/miyoushe-device-profile.spec.ts`

Expected: PASS（3 tests）。

- [ ] **Step 5: 提交纯函数模块**

```bash
git add src/main/services/miyoushe/device-profile.ts tests/unit/services/miyoushe-device-profile.spec.ts
git commit -m "feat: add stable miyoushe device profile"
```

### Task 2: 脱敏失败冷却存储

**Files:**

- Create: `src/main/services/miyoushe/device-fp-recovery-store.ts`
- Create: `tests/unit/services/miyoushe-device-fp-recovery-store.spec.ts`

- [ ] **Step 1: 写失败测试，锁定 72 小时边界和明文禁入**

```ts
it('persists only a device hash and expires after 72 hours', () => {
  const backend = new MemoryBackend();
  let now = 1_800_000_000_000;
  const store = new MiyousheDeviceFpRecoveryStore({ backend, now: () => now });
  store.recordFailure('plain-device-id', 'upstream');
  expect(store.inspect('plain-device-id')).toMatchObject({ active: true, reason: 'upstream' });
  expect(JSON.stringify(backend.value)).not.toContain('plain-device-id');
  now += 72 * 60 * 60 * 1000;
  expect(store.inspect('plain-device-id')).toEqual({ active: false });
});

it('clears a failure after successful recovery', () => {
  const store = new MiyousheDeviceFpRecoveryStore({ backend: new MemoryBackend() });
  store.recordFailure('device-a', 'network');
  store.clearFailure('device-a');
  expect(store.inspect('device-a')).toEqual({ active: false });
});
```

- [ ] **Step 2: 运行测试并确认因类不存在而失败**

Run: `npx vitest run tests/unit/services/miyoushe-device-fp-recovery-store.spec.ts`

Expected: FAIL，提示导出不存在。

- [ ] **Step 3: 实现可注入 backend 的冷却类和 electron-store backend**

```ts
export type DeviceFpFailureKind =
  | 'profile-invalid'
  | 'network'
  | 'upstream'
  | 'schema-drift'
  | 'persist';
export interface DeviceFpRecoveryState {
  schemaVersion: 1;
  failuresByDevice: Record<string, { failedAt: number; reason: DeviceFpFailureKind }>;
}
export interface DeviceFpRecoveryBackend {
  read(): DeviceFpRecoveryState;
  write(state: DeviceFpRecoveryState): void;
}

export class MiyousheDeviceFpRecoveryStore {
  inspect(
    deviceId: string
  ): { active: false } | { active: true; retryAt: number; reason: DeviceFpFailureKind };
  recordFailure(deviceId: string, reason: DeviceFpFailureKind): void;
  clearFailure(deviceId: string): void;
}
```

生产 backend 使用 `new Store({ name: 'miyoushe-device-recovery', defaults })`。键必须为 `sha256(deviceId).slice(0, 12)`；清理过期项时写回，文件内不得出现设备 ID、指纹、seed、Cookie 或上游 message。

- [ ] **Step 4: 运行冷却测试并确认通过**

Run: `npx vitest run tests/unit/services/miyoushe-device-fp-recovery-store.spec.ts`

Expected: PASS（2 tests）。

- [ ] **Step 5: 提交冷却存储**

```bash
git add src/main/services/miyoushe/device-fp-recovery-store.ts tests/unit/services/miyoushe-device-fp-recovery-store.spec.ts
git commit -m "feat: persist miyoushe fp recovery cooldown"
```

### Task 3: 持久化分区的设备 Cookie 白名单写入器

**Files:**

- Modify: `src/main/services/miyoushe-login-window.ts`
- Modify: `tests/unit/services/miyoushe-login-window.spec.ts`

- [ ] **Step 1: 扩展 Electron mock 并写失败测试**

```ts
const setCookie = vi.fn();
// session.fromPartition().cookies 同时暴露 get 和 set

it('writes only allowlisted device cookies to both trusted domains', async () => {
  await new MiyousheLoginWindow('persist:test').writeDeviceCookies({
    _MHYUUID: 'device-a',
    DEVICEFP: 'fp-a'
  });
  expect(setCookie).toHaveBeenCalledTimes(4);
  expect(setCookie.mock.calls.map(([value]) => value.url)).toEqual([
    'https://www.miyoushe.com/',
    'https://api-takumi.mihoyo.com/',
    'https://www.miyoushe.com/',
    'https://api-takumi.mihoyo.com/'
  ]);
});

it('rejects a runtime attempt to write an auth cookie', async () => {
  await expect(
    new MiyousheLoginWindow('persist:test').writeDeviceCookies({ ltoken_v2: 'secret' })
  ).rejects.toThrow('device cookie whitelist');
  expect(setCookie).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行登录窗口测试并确认方法不存在**

Run: `npx vitest run tests/unit/services/miyoushe-login-window.spec.ts`

Expected: FAIL，提示 `writeDeviceCookies` 不存在。

- [ ] **Step 3: 实现运行时白名单与双域写入**

```ts
async writeDeviceCookies(values: Readonly<Record<string, string>>): Promise<void> {
  const entries = Object.entries(values);
  for (const [name, value] of entries) {
    if (!DEVICE_COOKIE_NAMES.includes(name as MiyousheDeviceCookieName) || !value) {
      throw new Error('device cookie whitelist rejected input');
    }
  }
  const cookies = session.fromPartition(this.partition).cookies;
  for (const [name, value] of entries) {
    for (const url of ['https://www.miyoushe.com/', 'https://api-takumi.mihoyo.com/']) {
      await cookies.set({ url, name, value, secure: true, sameSite: 'no_restriction' });
    }
  }
}
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `npx vitest run tests/unit/services/miyoushe-login-window.spec.ts`

Expected: PASS，既有持久化读取测试继续通过。

- [ ] **Step 5: 提交 Cookie 写入器**

```bash
git add src/main/services/miyoushe-login-window.ts tests/unit/services/miyoushe-login-window.spec.ts
git commit -m "feat: persist allowlisted miyoushe device cookies"
```

### Task 4: `getFp` 服务、single-flight 与内存覆盖

**Files:**

- Create: `src/main/services/miyoushe/device-fp.ts`
- Create: `tests/unit/services/miyoushe-device-fp.spec.ts`

- [ ] **Step 1: 写失败测试覆盖成功、失败、冷却、single-flight 和旧 Cookie 覆盖**

```ts
it('persists a legal fp and preserves auth material in the returned cookie', async () => {
  transport.mockResolvedValue({
    statusCode: 200,
    bodyText: JSON.stringify({ retcode: 0, data: { code: 200, device_fp: 'server-fp' } })
  });
  const result = await service.ensureForSession('ltoken_v2=secret');
  expect(result).toMatchObject({ ok: true, refreshed: true });
  expect(result.cookie).toContain('ltoken_v2=secret');
  expect(result.cookie).toContain('DEVICEFP=server-fp');
  expect(writer.writeDeviceCookies).toHaveBeenCalledWith(
    expect.objectContaining({ DEVICEFP: 'server-fp' })
  );
});

it('coalesces concurrent forced refreshes and overlays the new fp on stale cookies', async () => {
  const cookie = '_MHYUUID=device-a; DEVICEFP=old-fp; DEVICEFP_SEED_ID=seed; DEVICEFP_SEED_TIME=1';
  const [first, second] = await Promise.all([
    service.recoverFrom5003(cookie),
    service.recoverFrom5003(cookie)
  ]);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(first.ok && second.ok).toBe(true);
  expect(service.applyKnownFingerprint(cookie)).toContain('DEVICEFP=server-fp');
});

it('reuses an fp acquired during login when 5003 follows within five minutes', async () => {
  const ensured = await service.ensureForSession(incompleteCookie);
  expect(ensured.ok).toBe(true);
  const recovered = await service.recoverFrom5003(incompleteCookie);
  expect(recovered).toMatchObject({ ok: true, refreshed: false });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('skips network during cooldown and never exposes upstream text', async () => {
  cooldown.inspect.mockReturnValue({
    active: true,
    retryAt: 1_900_000_000_000,
    reason: 'upstream'
  });
  const result = await service.recoverFrom5003(completeCookie);
  expect(result).toMatchObject({ ok: false, reason: 'cooldown' });
  expect(transport).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('secret');
});
```

再加入以下断言：undici 抛错映射 `network`；HTTP 非 2xx、非零 retcode 或 `data.code !== 200` 映射 `upstream`；非 JSON、空或非法 `device_fp` 映射 `schema-drift`；Cookie 写回失败映射 `persist`；上述失败均调用 `recordFailure`。`finishReplay(cookie, 'success')` 清理失败记录，`finishReplay(cookie, '5003')` 写入失败冷却。

- [ ] **Step 2: 运行服务测试并确认因模块不存在而失败**

Run: `npx vitest run tests/unit/services/miyoushe-device-fp.spec.ts`

Expected: FAIL，提示无法解析 `miyoushe/device-fp.js`。

- [ ] **Step 3: 实现公开契约与 getFp 调用**

```ts
export type DeviceFpResult =
  | { ok: true; cookie: string; deviceHash: string; refreshed: boolean }
  | {
      ok: false;
      cookie: string;
      deviceHash?: string;
      reason: DeviceFpFailureKind | 'cooldown';
      retryAt?: number;
    };

export interface DeviceFpTransport {
  (payload: DeviceFpPayload): Promise<{ statusCode: number; bodyText: string }>;
}

export class MiyousheDeviceFpService {
  private readonly latestFpByDevice = new Map<string, { fp: string; refreshedAt: number }>();
  private readonly inFlightByDevice = new Map<string, Promise<DeviceFpResult>>();

  applyKnownFingerprint(cookie: string): string;
  ensureForSession(cookie: string): Promise<DeviceFpResult>;
  recoverFrom5003(cookie: string): Promise<DeviceFpResult>;
  finishReplay(cookie: string, outcome: 'success' | '5003' | 'other-error'): void;
}
```

默认 transport 使用 8 秒有界超时的 `undici.request(GET_FP_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body, bodyTimeout, headersTimeout })`，只解析文本为 `{ retcode, data: { code, device_fp } }`。`ensureForSession` 在四个字段完整时直接返回 `refreshed: false`；`recoverFrom5003` 在冷却命中时停止，在 5 分钟内刚取得新指纹时复用，否则请求刷新。只有 `finishReplay(..., 'success')` 清除冷却，`finishReplay(..., '5003')` 写入冷却。任何日志/事件只允许 `{ deviceHash, phase, reason, retryAt }`。

- [ ] **Step 4: 运行服务测试并确认通过**

Run: `npx vitest run tests/unit/services/miyoushe-device-fp.spec.ts`

Expected: PASS，transport 调用次数与失败分类全部符合断言。

- [ ] **Step 5: 提交 getFp 服务**

```bash
git add src/main/services/miyoushe/device-fp.ts tests/unit/services/miyoushe-device-fp.spec.ts
git commit -m "feat: add controlled miyoushe getFp recovery"
```

### Task 5: 5003 单次恢复与 Chromium 重放

**Files:**

- Modify: `src/main/services/miyoushe-game-record.ts`
- Modify: `tests/unit/services/miyoushe-game-record.spec.ts`

- [ ] **Step 1: 用失败测试替换旧的“5003 直接 Chromium”假设**

```ts
it('refreshes fp once before replaying a CN 5003 through Chromium', async () => {
  requestMock.mockResolvedValueOnce(mockJson(200, { retcode: 5003, message: 'risk' }));
  const deviceFp = {
    applyKnownFingerprint: vi.fn((cookie: string) => cookie),
    recoverFrom5003: vi.fn().mockResolvedValue({
      ok: true,
      cookie: '_MHYUUID=device-a; DEVICEFP=new-fp',
      deviceHash: 'hash-a',
      refreshed: true
    }),
    finishReplay: vi.fn()
  };
  const browserTransport = vi.fn().mockResolvedValue({
    statusCode: 200,
    headers: {},
    bodyText: JSON.stringify({ retcode: 0, data: { stats: { avatar_number: 112 } } })
  });
  const client = new MiyousheGameRecordClient({ browserTransport, deviceFp });
  await expect(client.ping('100000001', 'cookie=auth')).resolves.toMatchObject({ ok: true });
  expect(deviceFp.recoverFrom5003).toHaveBeenCalledTimes(1);
  expect(deviceFp.finishReplay).toHaveBeenCalledWith(
    expect.stringContaining('DEVICEFP=new-fp'),
    'success'
  );
  expect(browserTransport).toHaveBeenCalledTimes(1);
  expect(browserTransport.mock.calls[0][1].headers['x-rpc-device_fp']).toBe('new-fp');
  expect(browserTransport.mock.calls[0][1].headers.DS).not.toBe(
    requestMock.mock.calls[0][1].headers.DS
  );
});
```

补充三个测试：重放仍 5003 时 `recoverFrom5003` 仍只调用一次；1034 只走原 Chromium 验证、不调 getFp；全球服 UID 的 5003 不调 getFp。再验证一次恢复后的下一次 list/detail 调用即使传入旧 Cookie，也会先经过 `applyKnownFingerprint`。

- [ ] **Step 2: 运行 Game Record 测试并确认新行为失败**

Run: `npx vitest run tests/unit/services/miyoushe-game-record.spec.ts`

Expected: FAIL，当前 5003 尚未调用 `deviceFp`。

- [ ] **Step 3: 注入最小恢复接口并拆分 1034/5003 分支**

```ts
export interface MiyousheDeviceFpRecovery {
  applyKnownFingerprint(cookie: string): string;
  recoverFrom5003(cookie: string): Promise<DeviceFpResult>;
  finishReplay(cookie: string, outcome: 'success' | '5003' | 'other-error'): void;
}

// doSignedRequest 参数增加 deviceRecoveryAttempted?: boolean
const effectiveCookie = this.deviceFp?.applyKnownFingerprint(cookie) ?? cookie;
const headers = this.buildHeaders(method, region, effectiveCookie, token.header);

if (retcode === 5003 && !region.isGlobal && this.deviceFp && !deviceRecoveryAttempted) {
  const recovered = await this.deviceFp.recoverFrom5003(effectiveCookie);
  if (!recovered.ok) return { ok: false, error: classified };
  const replay = await this.doSignedRequest<T>({
    ...args,
    cookie: recovered.cookie,
    useBrowserTransport: true,
    deviceRecoveryAttempted: true
  });
  this.deviceFp.finishReplay(
    recovered.cookie,
    replay.ok
      ? 'success'
      : 'retcode' in replay.error && replay.error.retcode === 5003
        ? '5003'
        : 'other-error'
  );
  return replay;
}

if (retcode === 1034 && this.browserTransport && !useBrowserTransport) {
  return this.doSignedRequest<T>({ ...args, useBrowserTransport: true });
}
```

`classifyError` 对外可继续把 5003/1034 映射成 `captcha-required` 以保持 IPC 契约，但内部必须基于原始 `retcode` 分流。没有注入 `deviceFp` 时，5003 直接返回分类错误；生产 composition root 必须注入服务。把既有“5003 直接 Chromium”测试改为 1034，防止旧行为再次回归。

- [ ] **Step 4: 运行 Game Record 与 IPC 回归测试**

Run: `npx vitest run tests/unit/services/miyoushe-game-record.spec.ts tests/unit/ipc/profile.ipc.spec.ts`

Expected: PASS，旧计算器降级测试不变。

- [ ] **Step 5: 提交请求恢复集成**

```bash
git add src/main/services/miyoushe-game-record.ts tests/unit/services/miyoushe-game-record.spec.ts
git commit -m "fix: recover CN battle record 5003 with getFp"
```

### Task 6: 登录、启动恢复与 composition root

**Files:**

- Modify: `src/main/ipc/profile.ipc.ts`
- Modify: `tests/unit/ipc/profile.ipc.spec.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 写失败 IPC 测试，验证登录后使用更新 Cookie**

```ts
it('uses the completed device cookie for roles and in-memory sessions', async () => {
  loginWindow.runOnce.mockResolvedValue({ ok: true, cookie: 'ltoken_v2=auth' });
  deviceFp.ensureForSession.mockResolvedValue({
    ok: true,
    cookie: 'ltoken_v2=auth; _MHYUUID=device-a; DEVICEFP=fp-a',
    deviceHash: 'hash-a',
    refreshed: true
  });
  await invokeRegistered('miyoushe:login-via-browser');
  expect(miyoushe.fetchRoles).toHaveBeenCalledWith(expect.stringContaining('DEVICEFP=fp-a'));
  expect(rosterSessions.put).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining('DEVICEFP=fp-a')
  );
});

it('does not block login when getFp is cooling down', async () => {
  deviceFp.ensureForSession.mockResolvedValue({
    ok: false,
    cookie: 'ltoken_v2=auth',
    reason: 'cooldown',
    retryAt: 1_900_000_000_000
  });
  const result = await invokeRegistered('miyoushe:login-via-browser');
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: 运行 IPC 测试并确认依赖/调用缺失**

Run: `npx vitest run tests/unit/ipc/profile.ipc.spec.ts`

Expected: FAIL，`ProfileIpcDeps` 尚无 `deviceFp`。

- [ ] **Step 3: 接入登录与启动链路**

`ProfileIpcDeps` 增加 `deviceFp: Pick<MiyousheDeviceFpService, 'ensureForSession'>`。登录 handler 使用：

```ts
const deviceResult = await deviceFp.ensureForSession(outcome.cookie);
const cookie = deviceResult.cookie;
const bind = await miyoushe.fetchRoles(cookie);
// loginSessions / rosterSessions 均写 cookie
```

`index.ts` 创建且只创建一次：

```ts
const loginWindow = new MiyousheLoginWindow();
const deviceFpStore = new MiyousheDeviceFpRecoveryStore();
const deviceFp = new MiyousheDeviceFpService({
  cookieWriter: loginWindow,
  cooldown: deviceFpStore
});
const miyousheGameRecord = new MiyousheGameRecordClient({ browserTransport, deviceFp });
```

`seedRosterSessionsFromPersistedCookie` 增加 `deviceFp` 依赖，在 `fetchRoles` 前调用 `ensureForSession`，无论成功或失败都使用返回的 `cookie`。日志只写结果类别，不能打印 error 对象，因为第三方 error 可能含响应内容。

- [ ] **Step 4: 运行 IPC 测试、typecheck 和 main build**

Run: `npx vitest run tests/unit/ipc/profile.ipc.spec.ts && npm run typecheck && npm run build:main`

Expected: 全部退出码 0；tsup 生成 `dist/main/index.mjs`。

- [ ] **Step 5: 提交 composition root**

```bash
git add src/main/ipc/profile.ipc.ts src/main/index.ts tests/unit/ipc/profile.ipc.spec.ts
git commit -m "feat: initialize miyoushe device recovery lifecycle"
```

### Task 7: 脱敏真实账号 Gate 与用户文档

**Files:**

- Modify: `src/main/gates/miyoushe-detail-gate.ts`
- Modify: `docs/data-acquisition.md`

- [ ] **Step 1: 给 Game Record 客户端增加脱敏恢复事件并在现有单测断言**

```ts
export type MiyousheDeviceRecoveryEvent =
  | { phase: 'detected'; retcode: 5003 }
  | { phase: 'skipped'; reason: DeviceFpFailureKind | 'cooldown'; retryAt?: number }
  | { phase: 'replayed'; final: 'success' | '5003' | 'other-error' };

// MiyousheGameRecordClientOptions
onDeviceRecoveryEvent?: (event: MiyousheDeviceRecoveryEvent) => void;
```

测试事件数组只能包含 phase、retcode、reason、retryAt、final；不得包含 cookie、device ID、fp、seed、URL query 或响应 message。

- [ ] **Step 2: 更新 Gate 使用真实 session transport、共享服务和事件收集**

Gate 必须实例化 `session.fromPartition(MIYOUSHE_LOGIN_PARTITION)`、`createMiyousheBrowserTransport`、`MiyousheDeviceFpRecoveryStore`、`MiyousheDeviceFpService`。JSON 报告新增：

```ts
deviceFp: {
  profileComplete: boolean;
  ensure: 'unchanged' | 'refreshed' | 'cooldown' | 'failed';
  recoveryEvents: MiyousheDeviceRecoveryEvent[];
}
```

Gate 仍只输出 UID 后三位、retcode、计数和字段覆盖；不得输出角色明细、昵称、完整 UID、请求/响应正文或设备字段。命中冷却是可审计的 `skipped`，不能尝试第二轮 `getFp`。

- [ ] **Step 3: 更新数据获取文档**

在米游社登录章节说明：应用会在主进程调用官方 `getFp`；5003 只恢复一次；失败后同一设备等待 72 小时；期间完整角色列表继续由养成计算器提供，详细面板可能保持部分完整。

- [ ] **Step 4: 运行格式、单测和 Gate 构建检查**

Run: `npx prettier --check src/main/gates/miyoushe-detail-gate.ts docs/data-acquisition.md && npx vitest run tests/unit/services/miyoushe-game-record.spec.ts && npm run build:main`

Expected: 全部退出码 0；Gate bundle 构建成功。此步骤不访问真实账号。

- [ ] **Step 5: 提交 Gate 与文档**

```bash
git add src/main/services/miyoushe-game-record.ts tests/unit/services/miyoushe-game-record.spec.ts src/main/gates/miyoushe-detail-gate.ts docs/data-acquisition.md
git commit -m "test: report sanitized device fp recovery gate"
```

### Task 8: 全量验证与一次受控真实账号验证

**Files:**

- Verify only; failures must be fixed in the owning task files.

- [ ] **Step 1: 运行新增测试集合**

Run: `npx vitest run tests/unit/services/miyoushe-device-profile.spec.ts tests/unit/services/miyoushe-device-fp-recovery-store.spec.ts tests/unit/services/miyoushe-device-fp.spec.ts tests/unit/services/miyoushe-login-window.spec.ts tests/unit/services/miyoushe-game-record.spec.ts tests/unit/ipc/profile.ipc.spec.ts`

Expected: PASS，退出码 0。

- [ ] **Step 2: 运行本地发布 Gate**

Run: `npm run gate:local`

Expected: lint、typecheck、全部 Vitest、renderer build、main build 均退出码 0。

- [ ] **Step 3: 运行 E2E**

Run: `npm run test:e2e:run`

Expected: 全部 Playwright tests PASS。

- [ ] **Step 4: 在用户已授权的本机登录态上执行一次真实 Gate**

Run: `npm run gate:miyoushe-detail`

Expected: 输出不含认证或设备明文；`getFp` 最多一次。最终可能是 Battle Chronicle 成功，也可能仍为 5003 并进入 72 小时冷却；两者都必须保留 calculator 的完整角色降级结果。若 Gate 已命中冷却，不清除存储、不更换设备 ID、不强制重试。

- [ ] **Step 5: 检查工作树与提交历史**

Run: `git status --short && git log --oneline -8`

Expected: 工作树干净；每个任务有独立提交，未包含用户无关文件。
