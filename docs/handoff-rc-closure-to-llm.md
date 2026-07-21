# v1.0 RC 收口交接（给新的 LLM Session）

> 更新时间：2026-07-21（Asia/Shanghai）
> 分支：`codex/v1-rc`

## 0. 最新结论

“本地只有 12 个角色”已经修复并完成真实落盘验证。

- 12 是 Enka 公开展示柜数量，只代表可取得精确面板的展示角色，不是账号完整角色池。
- Battle Chronicle 的 `/index` 与 `/character/list` 在当前账号/IP 上仍返回 5003。
- 5003 不是可直接通过 Geetest 解锁的 1034：官方 H5 对 5003 显示终止风险页；实验性将 5003 提升为 1034 后，米游社官方 create 返回 0，但官方 verify 仍稳定返回 10306。不要再让用户重复做这条验证码。
- 已改用米游社养成计算器的官方同步端点：
  `POST /event/e20200928calculate/v1/sync/avatar/list`。
- 该端点使用独立 DS1 签名与风险策略，真实请求返回 `retcode=0`、`total=112`、112 个唯一角色 ID，无重复。
- 通过生产 Electron 的 preload → `profile:refresh` IPC → ProfileStore 完成真实刷新与落盘：

```json
{
  "characterCount": 112,
  "source": "merged",
  "expectedOwnedCount": 112,
  "ownedCount": 112,
  "detailedCount": 12,
  "buildCount": 112,
  "enkaShowcaseCount": 12,
  "partial": false,
  "miyousheStatus": "ok",
  "miyousheCharacterCount": 112
}
```

因此当前数据语义是：

- 112 个米游社角色构成完整 ownership；
- 养成计算器同步数据补充角色等级、命座、好感、武器基础字段和可识别天赋等级；
- 12 个 Enka 展示角色覆盖更精确的 stats / weapon refinement / artifact main/sub stats；
- `partial=false` 表示角色池完整，不表示 112 个角色都拥有完整面板统计。

## 1. 根因与证据

### 1.1 为什么最初只有 12 个

Enka UID API 只能读取游戏内公开展示柜。它适合补强面板，不能证明完整角色 ownership。旧缓存把 Enka 展示子集当成角色池，导致配队候选被截断为 12 个。

缓存语义已经修复：

- Enka-only 档案始终标记为部分数据；
- 有权威米游社缓存时，刷新失败不会被新鲜 Enka 子集覆盖；
- 米游社完整名单决定 ownership，Enka 只按角色 ID 覆盖精确字段。

### 1.2 session 5003 的最终判断

已真实排除：

- Node 与 Chromium 传输差异；
- Cookie 缺失或被 Chromium cookie jar 静默覆盖；
- `x-trace-id` / `x-rpc-challenge_trace` 丢失；
- challenge path 误用完整 `/game_record/app/...` 路径；
- 用户未完成验证码；
- 自定义 GeeTest 页面本身无法加载。

官方 H5 bundle `v6.7.2-gr-cn` 的行为是：

- 1034 进入 `$geetest`；
- 5003 进入静态“账号存在风险，暂无数据”页面；
- 强制让 5003 走官方 `$geetest` 时，create 成功但 verify 返回 10306。

结论：不要再尝试把当前 5003 trace 当作 1034 解锁。产品恢复策略应换数据源，而不是循环验证码。

### 1.3 为什么计算器同步可用

养成计算器 `sync/avatar/list` 与 Battle Chronicle 使用不同端点、DS1 签名和风险策略。真实响应包含：

- `data.total=112`；
- `data.list.length=112`；
- 112 个唯一角色，无重复；
- 112 个武器对象；
- 112 组技能列表；
- 77 个角色存在已装备圣遗物条目。

圣遗物同步条目没有 main/sub stat 与可靠套装 ID，因此当前实现不伪造 ArtifactPiece；精确圣遗物继续由 Enka 覆盖。

## 2. 代码变更

### 完整角色池

- `src/main/services/miyoushe-calculator.ts`
  - 新增官方计算器同步客户端；
  - 使用显式 Cookie、DS1、设备上下文和 calculator Referer；
  - 映射角色等级、稀有度、元素、命座、好感、武器基础字段和天赋；
  - 输出严格 coverage，拒绝把 schema drift 当空角色池。
- `src/main/services/miyoushe/ds-token.ts`
  - 新增 `signDsV1`；
  - DS1 使用 `ce8dd6509bf20296fceb94793c8c10bd`（可由环境变量覆盖）。
- `src/main/ipc/profile.ipc.ts`
  - Battle Chronicle 失败后先请求 calculator sync；
  - 5003 不再打开已证明无效的重复验证码；
  - calculator 成功结果作为 `miyoushe-list` ownership。
- `src/main/index.ts`
  - 生产服务注册 `MiyousheCalculatorClient`。

### 数据诚实性

- `CharacterWeapon.refinement` 改为可选；calculator 没有返回精炼等级时不再伪造精1。
- Roster UI 仅在精炼等级已知时显示“精N / RN”。
- Enka-only、stale authoritative cache、merge coverage 的修复已落地。

### 5003 调查保留项

- Chromium transport 仍用于普通网络画像差异回退。
- BrowserBridge 可观察官方 H5 成功响应或自然 1034，但不再把 5003 篡改成 1034。
- Renderer 从未接触 Cookie、trace 或 Geetest 参数。

## 3. 测试与真实验收

已新增专项测试：

- DS1 固定输入签名；
- calculator roster schema 映射、去重和 coverage；
- sync 未开启时返回明确错误，不伪造空列表；
- profile IPC 在 Battle Chronicle 5003 时走 calculator，且不再打开 BrowserBridge 验证；
- refinement 未知时的类型、存储与 UI 兼容。

真实验收已经通过：

1. calculator 只读探针：HTTP 200 / retcode 0 / 112 条 / 112 unique；
2. 真实 Electron build；
3. Renderer 调用生产 `window.api.profile.refresh`；
4. ProfileStore 落盘后返回 112/112、`partial=false`、米游社状态 `ok`。

最终门禁（2026-07-21）已执行：

- `npm run gate:local`：通过；20 个测试文件、126 个测试全部通过，lint/typecheck/build 均为 exit 0；
- `npm run test:e2e:run`：2/2 通过；
- `npm run gate:miyoushe-detail`：通过；Battle Chronicle 仍为 5003，calculator 返回 112/112、`partial=false`；
- 最终生产 Electron 再次经 preload → `profile:refresh` IPC 刷新并落盘 112/112；
- `npm audit --omit=dev --registry=https://registry.npmjs.org --audit-level=high`：生产依赖 0 漏洞。

补充：默认 `npmmirror` 没有实现 audit API；切到 npm 官方 registry 后，`audit:all` 还会报告 `wait-on`/ESLint/electron-builder 工具链中的 dev-only `axios` 与 `brace-expansion`。它们不进入生产依赖，未在本次角色数据修复中扩展依赖升级范围。

## 4. 当前产品路径

```text
持久化米游社登录态（Main-only）
  -> 尝试 Battle Chronicle 详情
  -> 5003 / schema / transport 失败
  -> calculator sync 获取完整 owned roster
  -> Enka 展示柜按 ID 补强精确面板
  -> ProfileStore 持久化完整 coverage
  -> Advisor 使用 112 个候选角色配队
```

如果 calculator sync 返回 `-502002`，表示用户没有开启养成计算器同步。当前代码不会擅自修改该隐私设置，而是返回明确错误并保留已有权威缓存。

## 5. 不要再走的死路

1. 不要让用户重复解决当前 5003 对应的验证码；官方 verify 已实测返回 10306。
2. 不要把 5003 强制改成 1034；这只会制造无限 create/verify 循环。
3. 不要把 Enka 展示数量当成账号角色总数。
4. 不要把 calculator 未开启、schema drift 或网络失败映射为空角色池。
5. 不要把 Cookie、完整 UID、验证码值或角色明细写入日志/Renderer。
6. 不要为了绕过风控关闭 `sandbox`、`contextIsolation` 或 `webSecurity`。

## 6. 后续事项

- 提交当前工作区改动。
- 若要补全 112 个角色的圣遗物主副词条，必须继续使用 Enka 展示柜或等待米游社提供包含这些字段的合法同步接口；不要从 calculator 基础 relic 条目推断数值。
- 发起真实 LLM 推荐前仍需告知用户：会发送脱敏角色摘要并产生其 Provider 费用。

## 7. 一句话交接

**完整角色池问题已解决并真实落盘：米游社 calculator sync 提供 112/112 ownership，Enka 的 12 条只负责精确面板补强；5003→Geetest 路线已被官方 10306 实测证伪，不应再重复。**
