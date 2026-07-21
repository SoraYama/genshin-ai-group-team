# 米游社设备指纹恢复设计

## 背景

Battle Chronicle 的国服接口在当前真实账号环境下稳定返回 `HTTP 200 + retcode 5003`。同一登录态可以正常访问养成计算器，因此这不是普通的 Cookie 过期。社区项目对一类 5003 的处理是通过 `https://public-data-api.mihoyo.com/device-fp/api/getFp` 获取合法设备指纹，并让后续游戏战绩请求携带稳定、匹配的 `x-rpc-device_id` 与 `x-rpc-device_fp`。

当前实现仅从持久化登录 Cookie 中读取 `_MHYUUID` 和 `DEVICEFP`。它没有主动补齐缺失指纹、没有刷新生命周期，也没有在 5003 后进行一次受控恢复。该设计补齐这条链路，但不承诺绕过服务端账号或设备信任期。

## 目标

- 为国服米游社登录建立稳定、可持久化的设备档案。
- 通过官方 `getFp` 接口补齐或刷新 `DEVICEFP`。
- Battle Chronicle 首次返回 5003 时最多刷新一次指纹，并通过 Chromium 重放原请求一次。
- 恢复仍失败时进入 72 小时冷却，避免每次启动或每次刷新重复改变设备状态。
- Cookie、设备指纹和 seed 始终留在 Electron 主进程及 Chromium 加密 Cookie 分区中。

## 非目标

- 不把 5003 改写成 1034。
- 不伪造、自动破解或绕过 GeeTest。
- 不在每次请求、每次启动或每次失败时随机生成新设备。
- 不改变国际服请求链路。
- 不承诺解除账号级、IP 级或设备信任期导致的 5003。
- 不把设备指纹、Cookie 或 seed 暴露给 Renderer、日志或测试快照。

## 方案比较

### 方案 A：仅用当前 Cookie 调用一次 `getFp`

改动最少，但无法处理 seed 缺失、跨启动冷却和当前请求的安全重放。它适合作为诊断脚本，不满足生产恢复要求。

### 方案 B：稳定设备档案与单次恢复（采用）

复用当前持久化分区中的 `_MHYUUID`、`DEVICEFP_SEED_ID`、`DEVICEFP_SEED_TIME` 和 `DEVICEFP`。缺失的稳定字段只生成一次并写回同一分区。5003 只触发一次 `getFp` 和一次 Chromium 重放；失败后按设备哈希进入冷却。

### 方案 C：全部请求交给官方 H5

官方 H5 能提供最接近米游社的浏览器环境，但当前 5003 在官方页面中是静态风险页，不进入验证流程。它可以保留为传输层，却不能承担确定性恢复。

## 组件边界

### `MiyousheDeviceFpService`

新增主进程服务，承担以下职责：

- 从主进程传入的完整 Cookie 中只提取设备字段白名单；认证字段既不进入设备档案，也不被记录。
- 复用已有 `_MHYUUID`、seed 和指纹；只为缺失字段生成稳定值。
- 构造 `getFp` 请求并校验 `{ retcode: 0, data: { code: 200, device_fp } }`。
- 将新的设备字段写回 `persist:miyoushe-login` 的 Chromium Cookie 分区。
- 返回包含新设备字段的内存 Cookie 字符串，供当前请求立即重放。
- 在主进程内按设备哈希缓存本次进程最新的 `DEVICEFP`，使仍持有旧 Cookie 副本的后续 list/detail 批次自动使用新指纹；应用退出即清空。
- 查询并更新设备恢复冷却状态。

同一设备的并发刷新使用 single-flight：第一个请求实际调用 `getFp`，其余请求等待同一 Promise，不得并发改变同一设备档案。若登录补齐刚在 5 分钟内取得新指纹，紧随其后的首个 5003 直接复用该新指纹进行 Chromium 重放，不再次调用 `getFp`。

该服务通过依赖注入接收 HTTP transport、时间函数、随机值生成器、Cookie 写入器与冷却存储，因此单元测试不访问真实网络或真实用户目录。

应用启动时由 composition root 创建单例，并分别注入登录恢复链路与 `MiyousheGameRecordClient`。二者共享同一持久化分区和冷却存储，避免登录补齐与 5003 恢复各自生成一套设备身份。

### `MiyousheLoginWindow`

扩展持久化登录服务，仅增加白名单设备 Cookie 的写回能力。允许写入的名字限定为：

- `_MHYUUID`
- `DEVICEFP`
- `DEVICEFP_SEED_ID`
- `DEVICEFP_SEED_TIME`

写入目标限定为米游社/米哈游 HTTPS 域名，继续由 Chromium OSCrypt 加密。该接口不允许写入认证 Cookie。

### `MiyousheGameRecordClient`

通过可选依赖接收设备恢复器。仅国服响应 `retcode 5003` 时启动恢复；自然 `1034` 保持现有官方验证行为。

恢复后的重放同时满足：

- 使用 `getFp` 返回的新 `DEVICEFP`；
- 重新生成 DS；
- 通过持久化 Chromium transport 发送；
- 针对同一个业务请求只执行一次；
- 重放仍返回 5003 时直接返回错误，不进入第二轮恢复或 Node/Chromium 循环。
- 重放成功后清除失败冷却；重放仍为 5003 时由客户端通知设备服务写入冷却。单独取得 `getFp` 成功响应不等于 Battle Chronicle 恢复成功。

### 冷却状态

冷却存储只保存：

- `sha256(_MHYUUID)` 的截断哈希；
- 上次失败恢复的时间戳；
- 上次恢复结果类别，不包含上游消息正文。

它不保存明文设备 ID、设备指纹、seed 或 Cookie。冷却固定为 72 小时。成功恢复后清除该设备的失败冷却记录；`getFp` 本身失败或重放仍为 5003 时写入冷却。

## 设备档案规则

1. 已存在 `_MHYUUID` 时永不替换。
2. 已存在 `DEVICEFP_SEED_ID` 与 `DEVICEFP_SEED_TIME` 时永不替换。
3. 缺失 seed 时，为当前 `_MHYUUID` 生成一次，并在发起 `getFp` 前持久化。
4. 缺失 `_MHYUUID` 时生成一个 UUID，并与 seed 一起持久化；该路径只服务手动 Cookie 导入或损坏分区。
5. `DEVICEFP` 存在时作为 `getFp` 的旧指纹输入；不存在时使用由稳定设备 ID 派生的 13 位占位值，仅用于获取正式指纹。
6. `ext_fields` 在同一设备档案生命周期内保持稳定。字段以社区已验证的米游社 Android 请求形状为基线，其中需要变化的值由 `_MHYUUID` 确定性派生；不读取真实硬件传感器，也不在每次请求时随机变化。
7. 新指纹仅覆盖 `DEVICEFP`，不改变设备 ID 和 seed。

## 请求数据流

### 登录后补齐

登录完成或启动恢复持久化登录时，若设备字段不完整：

```text
持久化 Cookie
  → ensureStableProfile
  → 写回缺失的 ID/seed
  → getFp
  → 写回 DEVICEFP
  → 刷新内存 roster session
```

如果 `getFp` 失败，登录本身仍成功；应用记录同一份 72 小时失败冷却并继续使用养成计算器降级，不阻塞用户进入应用。后续 Battle Chronicle 请求命中该冷却时不会再次调用 `getFp`。

### 5003 恢复

```text
Battle Chronicle 初始请求
  → retcode 5003
  → 检查本请求是否已恢复过
  → 检查设备 72 小时冷却
  → refreshFingerprint
  → 写回加密 Cookie 分区
  → 使用新 Cookie、新 DS、Chromium transport 重放一次
  → retcode 0：返回业务数据并清除失败冷却
  → 仍为 5003 或 getFp 失败：记录冷却并返回原始分类错误
```

`1034` 不进入该流程。其他 retcode、HTTP 5xx 与网络错误继续使用各自现有策略。

## 错误处理

设备恢复内部使用明确错误分类：

- `profile-invalid`：稳定设备字段无法构造或持久化；
- `cooldown`：该设备仍在 72 小时冷却中；
- `network`：`getFp` 网络失败；
- `upstream`：`getFp` 返回非零 retcode 或 `data.code !== 200`；
- `schema-drift`：成功响应缺少合法 `device_fp`；
- `persist`：指纹取得成功但写回加密 Cookie 分区失败。

Battle Chronicle 对外仍返回现有 `MiyousheFetchError`，不把内部设备字段或上游响应正文带到 Renderer。

## 日志与隐私

允许记录：

- 设备 ID 的 12 位 SHA-256 截断哈希；
- `getFp` 是否尝试、是否成功；
- 错误类别和数字 retcode；
- 是否命中冷却、是否执行重放。

禁止记录：

- Cookie 字符串；
- `_MHYUUID`、`DEVICEFP`、seed 明文；
- `getFp` 完整请求体或完整响应体；
- 认证头和 DS 明文。

## 测试策略

### 单元测试

- 复用完整设备档案，不改变 ID/seed。
- 缺失字段时只生成一次并持久化。
- `getFp` 请求体使用稳定字段，且响应映射正确。
- 非法响应分别映射为 `upstream` 与 `schema-drift`。
- 写回接口拒绝非白名单 Cookie 名字。
- 5003 触发一次恢复和一次 Chromium 重放。
- 重放仍为 5003 时不再递归。
- 72 小时冷却阻止再次调用 `getFp`。
- 1034、国际服与非风险错误不触发恢复。
- 日志测试确认不包含设备、seed 或 Cookie 明文。

### 本地回归

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run test:e2e:run`

### 真实账号 Gate

真实 Gate 默认不运行，并只输出脱敏结果：

- 设备字段是否完整；
- `getFp` 是否成功；
- 初始 Battle Chronicle retcode；
- 是否执行一次恢复重放；
- 最终 retcode 与角色数量，不输出任何角色明细或凭据。

Gate 不对同一设备执行第二轮恢复；命中冷却时明确报告 skipped。无论成功或失败，养成计算器的 112 角色降级路径保持可用。

## 验收标准

- 生产代码能够为持久化米游社登录补齐并保存合法 `DEVICEFP`。
- 国服 Battle Chronicle 的 5003 最多触发一次 `getFp` 和一次 Chromium 重放。
- 跨启动冷却阻止失败设备在 72 小时内再次刷新。
- 1034、国际服和其他错误不触发 `getFp`。
- 设备和认证信息不进入 Renderer、日志、测试输出或普通配置明文。
- 全部本地 Gate 与 E2E 通过。
- 真实账号 Gate 给出可审计的脱敏结果；若最终仍是 5003，产品继续使用养成计算器降级并明确处于设备信任冷却，而不是宣称已解除风控。
