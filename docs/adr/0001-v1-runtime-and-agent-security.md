# ADR 0001：1.0 Runtime、Agent SDK 与权限边界

- 状态：Accepted
- 日期：2026-07-16
- 决策范围：1.0 冲刺基线

## 背景

1.0 的核心链路同时依赖 Electron 主进程、Claude Agent SDK 的平台二进制、玩家自带的 Anthropic Messages 兼容端点，以及米游社本地登录态。只验证源码态 query 或 renderer build，无法证明安装包中的子进程、权限边界和外部数据链路成立。

## 决策

### Agent SDK

- 精确锁定 `@anthropic-ai/claude-agent-sdk@0.3.211` 和 `zod@4.4.3`，不使用 caret 范围。
- 所有 SDK 调用经过 `AgentSdkAdapter`，业务代码不直接拼装 query options。
- 默认不暴露任何原生工具：`tools`、`allowedTools` 为空，`Agent`、`Task`、`Bash`、文件和 Web 工具均明确禁用。
- 使用 `permissionMode: dontAsk`；`PreToolUse` hook 对未登记工具默认拒绝。
- 不读取用户或项目 Claude settings，不持久化 SDK session。API Key、base URL 和 model 只通过该次子进程的 `env` 注入。
- 打包态显式解析 `app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]`。不能依赖 ASAR 内的自动发现路径。

### Orchestrator 边界

- 1.0 是单次推荐流程，不开放 Claude Code 原生 `Agent/Task`。Orchestrator 是 Main 进程内的 host control plane，不是第六个 LLM subprocess。
- 版本化 route policy 固定为 DataCurator → TeamComposer → Critique → RotationCoach → Explain；host 负责 schema/owned-ID 校验、超时、取消、usage 和最终映射，但不生成或修改队伍内容。
- 五个专业角色各自使用独立 prompt、独立 `maxTurns: 1` query 和 Zod 输出契约。该边界避免递归 spawn、工具权限继承和不可审计的子任务历史，同时仍保留六类职责（1 host + 5 LLM roles）。
- 若未来引入多轮 Advisor 对话，再单独 ADR 评估受限 `Agent` tool；不得仅通过 prompt 打开。

### 打包验证

- macOS `pack:dir` 后必须运行 `npm run test:packaged:sdk:mac`。
- 烟测启动真实打包应用，调用已重签名的平台 binary，并连接只存在于本机回环地址的 Anthropic SSE mock。
- 烟测输出只包含 gate、状态和经过脱敏的错误摘要，不输出 prompt、header、Key 或响应正文。
- 本机确认 Apple Developer ID 签名后的 SDK binary 可执行；npm 原始 binary 在当前受管设备会被终端安全软件终止，因此不能用原始 binary 结果替代打包态验证。

### Electron

- 锁定 Electron `43.1.1` 作为当前 1.0 runtime 基线；从 39 的迁移于 2026-07-16 完成。
- 43 必须通过 macOS/Windows packaged smoke 后才能作为最终发布版本；若 RC 前退出官方支持窗口，再按同一门禁升级。
- 升级前后均维持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`。

### 米游社数据

- `/index` 只用于身份和 expected owned count 探针。
- 完整角色池使用 `POST character/list`，当前 build 使用分批 `POST character/detail`。
- 国际服 base route 使用 `https://sg-public-api.hoyolab.com/event`。
- 外部 gate 只读取 Electron 持久 partition；无登录态时明确 skip。Cookie 不从环境变量、renderer 或 fixture 注入。

### 更新渠道

- 1.0 使用 GitHub Releases；macOS 产出 DMG + ZIP，Windows 产出 NSIS。
- 自动更新进入 Sprint 4，必须用 `rc.1 -> rc.2` 真实产物验证，不以配置文件存在作为通过。

## 后果

- 平台 binary 必须按目标 OS 原生安装和打包，CI 不做跨平台发布产物。
- 新增业务工具时必须同时增加 allowlist、Zod 契约、权限拒绝测试和 packaged smoke；不能仅修改 prompt。
- 未取得公证凭据、Windows 安装验证和真实米游社 list/detail gate 前，1.0 仍为 No-Go。
