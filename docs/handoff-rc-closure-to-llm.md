# v1.0 RC 收口交接（给新的 LLM Session）

> 更新时间：2026-07-16 18:15（Asia/Shanghai）  
> 仓库：`SoraYama/genshin-ai-group-team`  
> 当前分支：`codex/v1-rc`  
> 当前 HEAD：`5f46bf8 Improve Miyoushe roster fallback and captcha handling`

## 0. 新 Session 先读这里

当前不是“从零补基建”的阶段，而是 **v1.0 RC 链路收口与真实环境验收**阶段。

新 Session 的首要原则：

1. 不要重做已通过的 CI、Provider 和本地门禁基建。
2. 不要宣称米游社实时角色链路已经修复。当前真实状态是：**本地缓存可用，但实时刷新仍被米游社 5003 / 10306 阻断**。
3. 不要让用户反复解相同的 Geetest。已经多次用最新协议人工完成验证码，服务端仍拒绝验证提交。
4. 不要在日志、文档或 Renderer 中输出 Cookie、API Key、完整 UID、验证码参数或完整角色档案。
5. 在真正调用用户 Provider 生成推荐前，仍需向用户确认一次：会发送脱敏后的角色摘要并产生模型费用。

建议先执行：

```bash
git status --short
git log -5 --oneline
gh run view 29489794729
```

本交接记录当前执行状态；原始需求、架构背景和前期调研继续参考：

- `AGENTS.md`
- `docs/handoff-miyoushe-profile-to-llm.md`
- `docs/release-readiness.md`
- `docs/rc-validation.md`

其中后三份文档的部分状态已经过期，不能直接当作当前事实，具体见本文“文档债务”。

## 1. 当前结论

| 项目 | 当前状态 | 结论 |
|---|---|---|
| Git 工作区 | 干净 | 最新改动已提交并推送到 `origin/codex/v1-rc` |
| 本地质量门禁 | 通过 | lint、typecheck、113 个单测、build、2 个 Electron E2E、audit 全绿 |
| 已保存 Provider 实测 | 通过 | HTTP 200，约 1093 ms，门禁不会打印凭据 |
| 上一轮跨平台 CI | 通过 | macOS arm64、macOS Intel、Windows 全绿，含打包 SDK smoke、包体预算、NSIS 安装/卸载 |
| 最新提交 CI | 运行中 | Quality gates 已通过；三个 Electron smoke job 正在执行 |
| 米游社登录 | 可用 | Electron 持久化登录态可读，账号下单 UID 场景可工作 |
| 角色缓存 | 可用 | 当前本地档案为 12/12 个详细角色，可供推荐链路使用 |
| 米游社实时刷新 | 阻塞 | `/index` 返回 5003；人工 Geetest 提交返回 10306，服务端不接受第三方桌面验证 |
| Enka | 可用 | 继续作为展示柜面板和实时刷新失败时的降级数据源 |
| 完整推荐闭环 | 待最后一次真实执行 | UI 已填好档案、敌人和偏好；尚未在本 Session 中确认并发送真实推荐请求 |
| macOS 公证 | 暂缓 | 用户明确决定先跑通链路，暂不做 notarization |

## 2. Git 与 CI 证据

### 2.1 近期提交

```text
5f46bf8 Improve Miyoushe roster fallback and captcha handling
62cb464 fix(ci): 区分平台包体预算
dc1bf4 fix(ci): 禁止构建隐式发布
f0188ea ci(actions): 验证候选分支
0cc6e11 ci(actions): 支持手动运行门禁
```

`5f46bf8` 已推送，当前工作区无未提交文件。

### 2.2 已确认的绿色 CI 基线

- Run：<https://github.com/SoraYama/genshin-ai-group-team/actions/runs/29484554576>
- Commit：`62cb464`
- 结果：全部成功
- 覆盖：
  - Quality gates
  - Electron smoke（macOS latest）
  - Electron smoke（macOS 15 Intel）
  - Electron smoke（Windows latest）
  - Windows unpacked 构建
  - packaged Agent SDK protocol smoke
  - 平台差异化包体预算
  - Windows NSIS 安装与卸载 smoke

包体预算已按平台拆分：

- macOS universal：1150 MiB
- Windows 单架构：725 MiB
- macOS 单架构：650 MiB

实测 Windows 约 687.9 MiB，本地 macOS 约 605.1 MiB。

### 2.3 最新提交 CI

- Run：<https://github.com/SoraYama/genshin-ai-group-team/actions/runs/29489794729>
- Commit：`5f46bf8`
- 本文记录时状态：`in_progress`
- 已通过：Quality gates
- 运行中：macOS latest、macOS Intel、Windows Electron smoke

新 Session 必须先刷新这条 Run 的最终结果，不要沿用本文的瞬时状态。

## 3. 已完成并验证的基建

### 3.1 本地闭环门禁

完整执行过：

```bash
npm run gate:all
```

结果：

- ESLint 通过
- TypeScript typecheck 通过
- 17 个测试文件、113 个单测通过
- Vite + tsup build 通过
- 2 个 Electron E2E 通过
- 依赖审计 0 vulnerability

### 3.2 已保存 Provider 真实门禁

新增并验证：

```bash
npm run gate:provider-saved
```

相关实现：

- `src/main/gates/provider-saved-gate.ts`
- `package.json`
- `tsup.config.ts`

行为：

- 读取 Electron dev 对应的真实 `userData` 配置，而不是要求重新输入 Key。
- macOS dev 路径映射到 `Application Support/genshin-team-advisor`。
- 使用与应用一致的 `safeStorage` 身份；默认 app name 为 `genshin-team-advisor`，必要时可用 `GTA_SAFE_STORAGE_APP_NAME` 覆盖。
- 输出只包含连接结果与耗时，不输出 API Key、Authorization 或响应敏感内容。

本次真实结果：HTTP 200，耗时约 1093 ms。

## 4. 米游社链路：现在到底好了什么

### 4.1 已完成的修复

本次变更涉及：

- `src/main/services/miyoushe-game-record.ts`
- `src/main/services/miyoushe-login-window.ts`
- `src/main/services/miyoushe/browser-bridge.ts`
- `src/main/services/miyoushe/verification.ts`
- `src/main/ipc/profile.ipc.ts`
- `src/main/index.ts`
- `src/renderer/pages/Roster/RosterPage.tsx`
- 相应单元测试和真实门禁

已修复或补齐：

1. 移除误伤辅助米游社窗口的全局导航拦截；主窗口仍保留自己的导航白名单。
2. BrowserBridge 增加 `miyoushe.com` / `mihoyo.com` 的可信 HTTPS allowlist。
3. 修复隐藏 CDP BrowserBridge 挂住的问题：先加载 `about:blank`，再 attach debugger 和启用 Network。
4. 修复“HTTP 200 就自动判成功并关窗”的假阳性；现在会解析业务 retcode。
5. 主进程 Cookie 上下文补齐设备与认证字段，包括 `_MHYUUID`、`DEVICEFP`、`cookie_token_v2` 等；这些值不进入 Renderer。
6. `x-rpc-device_id` 与 `x-rpc-device_fp` 只在成对完整时发送。
7. 避免 Electron `session.fetch` 自动 Cookie 合并导致跨域 Cookie 覆盖：验证 create / submit 改为 `undici.request`，显式使用主进程内 Cookie。
8. Geetest 页面现在可以正常加载和由用户手工完成；没有自动破解验证码。
9. 补齐米游社交互验证协议实现和单测。
10. 10306 现在会透传成准确、可理解的用户提示，而不是最终只显示泛化 5003。

当前 UI 预期提示：

```text
米游社未接受本次安全验证（10306）；已保留本地角色缓存，请稍后重试或重新登录
```

### 4.2 已实现的验证协议

实现依据来自开源客户端的协议交叉验证：

- create：`/game_record/app/card/wapi/createVerification?is_high=true`
- submit：POST `/game_record/app/card/wapi/verifyVerification`
- `x-rpc-challenge_game: 2`
- `x-rpc-challenge_path`：目标 API path，例如 `/game_record/app/genshin/api/index`
- DS2 X4 签名
- 米游社版本与 UA：`2.109.0`
- Geetest runtime：`gt.0.5.2.js`
- `new_captcha: true`
- `protocol: https://`
- submit 字段：create 返回的 challenge、用户解题后的 validate、`${validate}|jordan`
- 若 submit 成功，应使用服务端返回的 `data.challenge` 作为目标请求的 `x-rpc-challenge`

参考实现：

- <https://github.com/PaiGramTeam/SIMNet/blob/master/simnet/client/components/verify.py>
- <https://github.com/FufuCore/FufuLauncher/blob/master/FufuLauncher/Services/GeetestService.cs>
- <https://github.com/daidr/paimon-webext/blob/master/src/utils/utils.ts>
- <https://github.com/HappyDIY/MHGLauncher/blob/master/backend/src/providers/note-client.ts>

### 4.3 仍然没有解决的问题

在当前账号、设备和网络环境下，多次让用户完成新的 Geetest 后，结果仍稳定为：

```text
verify submit HTTP 200
retcode 10306
accepted = false
challenge length = 32
validate length = 32
target /index retcode = 5003
```

这说明问题已经不是：

- Node TLS 指纹单一问题：Chromium `session.fetch` 也会 5003。
- 用户没完成验证码：用户已多次人工完成。
- challenge/validate 缺失：二者长度与格式存在。
- Geetest runtime 未加载：页面已能正常展示并回调。
- 简单 Cookie 缺项：已补齐主进程可见的认证和设备上下文。

更可信的结论是：**米游社服务端没有接受当前第三方 Electron 桌面的验证提交**。可能还依赖官方 App 的设备信任、风控态、JSBridge 或未公开签名信息。

### 4.4 不要再走的死路

1. 不要继续让用户重复解同一种验证码，除非协议或请求证据有实质变化。
2. 不要把 `community-game-records` SPA 当作可直接复用的官方网页回退。独立 Electron 中它依赖米游社 App JSBridge，没有发出预期的 `/index`、`/list`、`/detail` 请求。
3. 不要只根据 HTTP 200 判定业务成功，必须检查 retcode 和响应体。
4. 不要把 Cookie 或 challenge 交给 Renderer 来“方便调试”。
5. 不要通过降低 Electron 安全设置解决此问题。
6. 不要宣称“使用 BrowserWindow 就必然能绕过 5003”；实测已经否定。

## 5. 当前可工作的产品路径

当前账号下只有一个 UID，这是普通用户的正常产品路径，足以继续完成首个闭环。此前提到的“三账号”是 Beta QA 的差异覆盖矩阵，不是产品要求用户绑定三个账号。

目前可用流程：

```text
持久化米游社登录
  -> 读取账号 UID / 已缓存角色
  -> 实时刷新尝试
  -> 遇到 5003 / 10306 时保留本地 12/12 详细档案
  -> Enka 作为补充或回退
  -> 使用本地 ProfileBundle 发起 LLM 推荐
  -> 保存推荐历史
```

本机当前缓存档案为 12 个角色，12 个已有详细数据（武器、天赋、圣遗物/构筑字段可用）。这足够验证推荐链路，但不能据此宣称米游社实时刷新已经成功。

## 6. 尚未完成的真实推荐闭环

本 Session 已在 UI 中准备：

- 当前本地 12/12 详细档案
- 敌人：`abyss-mage, ruin-guard`
- 偏好：`操作简单、容错高`

但没有点击最终发送。原因不是技术报错，而是该操作会：

- 将脱敏后的角色档案摘要发送到用户配置的 Provider；
- 产生一次真实模型调用费用。

因此在动作发生前请求了用户确认；用户随后改为要求生成本交接文档。

新 Session 下一次继续时，应先简短说明发送范围和费用，然后取得明确确认，再完成：

1. 发起推荐；
2. 观察流式 progress / delta / done；
3. 验证最终队伍不是空结果或启发式误回退；
4. 验证 History 中新增记录；
5. 若失败，记录 Provider 状态码、Agent SDK 事件阶段和脱敏错误，不记录 Prompt 中的完整档案。

## 7. 文档债务

以下文档仍包含旧状态，需要在下一轮收口时更新：

- `docs/rc-validation.md`
  - 仍写 106 个测试；当前是 113。
  - 仍写 Windows 待验证；已有完整绿色 CI。
  - Provider / 米游社状态已变化。
- `docs/release-readiness.md`
  - 仍写仓库 private；仓库现在已公开。
  - 仍写 Windows pending。
  - Provider 不再是 missing-env，已通过 saved-provider gate。
- `docs/troubleshooting.md`
  - “打开可见战绩窗口即可完成回退”的表述不准确。
  - 应明确 5003 / 10306 时保留缓存、不要无限重试验证码。
- `docs/data-acquisition.md` 和 `AGENTS.md`
  - 部分 Cookie “关窗即清理”的描述与当前持久化 partition 策略存在历史冲突，应统一为当前实现。

更新文档时以代码、最新门禁和本文事实为准，不要机械复制旧结论。

## 8. 下一 Session 的建议执行顺序

### P0：确认最新提交 CI

```bash
gh run view 29489794729
```

若失败，优先按失败 job 修复并重新验证；若成功，把它作为 `5f46bf8` 的完整跨平台绿色证据。

### P0：完成一次真实推荐闭环

在用户确认会产生 Provider 请求后，使用当前缓存档案完成“推荐 -> 流式结果 -> 历史记录”的真实走通。

### P0：确定 5003 的 RC 产品策略

建议 RC 采用明确降级，而不是继续无限协议猜测：

- 有缓存：保留并继续推荐，显示“实时刷新失败，正在使用上次数据”。
- 无缓存但 Enka 可用：使用 Enka 展示柜数据并标注覆盖有限。
- 无任何数据：引导重新登录或稍后重试。
- 10306：本次会话不再自动弹第二次相同验证码。
- 调试用交互验证可保留在 feature flag 下，不把它当作稳定主路径。

### P1：更新 RC 文档

修正本文“文档债务”中列出的过期内容，保证 Release Readiness 与真实门禁一致。

### P1：提交并推送后续改动

提交前确认 diff 不包含任何运行时用户数据、Cookie、Key、完整 UID 或缓存档案。

### P1：剩余发布项

- RC1 -> RC2 自动更新演练；
- 5 天稳定性 soak；
- Beta 多账号差异覆盖（这是 QA 矩阵，不是普通用户使用要求）；
- macOS notarization 暂缓，除非用户重新调整优先级；
- Windows 暂不做代码签名，延续当前策略。

## 9. 常用验证命令

```bash
# 本地全门禁
npm run gate:all

# 使用应用中已保存的 Provider 做真实连接验证
npm run gate:provider-saved

# 米游社详情真实门禁；当前账号可能继续以 5003 失败
npm run gate:miyoushe-detail

# 查看最新状态
git status --short
git log -5 --oneline

# 查看 CI
gh run view 29489794729
gh run view 29484554576
```

注意：`gate:miyoushe-detail` 的失败目前是已知外部阻塞，不能因为其他门禁全绿就把它忽略，也不能因为它失败就否定缓存 + Enka + LLM 的可用降级闭环。

## 10. 安全与隐私红线

- Renderer 不得持有 Cookie、API Key 或完整验证上下文。
- 所有外部请求仍走 Main。
- 不记录 Cookie、Authorization、API Key、Geetest validate/seccode、完整 UID。
- Provider 门禁只输出状态、耗时和脱敏错误。
- 用户角色档案发送到 Provider 前要明确告知。
- 不自动破解 CAPTCHA，不模拟用户完成挑战。
- 不为了调通米游社而关闭 `sandbox`、`contextIsolation`、`webSecurity`。

## 11. 一句话交接

**基础开发—验证闭环已经建立，Provider 与跨平台 CI 已跑通；当前唯一明确的外部 P0 是米游社对第三方 Electron 验证提交返回 10306、目标接口继续 5003。下一步应停止重复验证码试错，先用 12/12 本地缓存 + Enka 完成一次真实 LLM 推荐与历史落盘，再把 5003 作为有清晰降级策略的 RC 风险收口。**
