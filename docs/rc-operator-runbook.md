# 1.0 RC 操作手册

本手册只描述需要维护者权限、真实账号或目标平台的步骤。任何输出都不得包含 Cookie、API Key、完整 UID、证书私钥或 raw Profile。

## 0. 当前入口

- 候选版本：`1.0.0-rc.1`
- 本机证据：`npm run gate:all` 与最终源码对应的 `release-rc1-signed-final` universal packaged gates 已通过；该目录仅为本机忽略产物。
- 发布状态：No-Go。远端仓库仍为 private，Actions secrets 为空，未 tag/commit/push。
- 证据表：每步完成后只把脱敏结果写入 `docs/rc-validation.md`。

## 1. 发布渠道

1. 维护者确认 GPL-3.0 源码和历史可公开后，把 `SoraYama/genshin-ai-group-team` 设为 public。该操作会影响仓库访问边界，必须人工确认。
2. 在未登录浏览器中确认仓库可访问。RC 发布后再确认以下 URL 无需 token 即可下载：
   - `latest-mac.yml` / `latest.yml`
   - macOS ZIP / DMG
   - Windows NSIS EXE
3. GitHub Actions 当前已启用；workflow 显式申请 `contents: write`，只在所有 build jobs 通过后创建 draft。

## 2. Apple secrets

在仓库 Settings → Secrets and variables → Actions 配置：

- `MACOS_CSC_LINK`：Developer ID Application `.p12` 的 base64 内容。
- `MACOS_CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`（当前证书对应 `86QXUB3AFS`）

推荐在本机用 `gh secret set NAME` 的交互输入，不把值写入命令行、文档或聊天。配置后运行 `gh secret list --app actions` 只核对名称。

Release job 会在上传前执行：Electron E2E、universal 合并、嵌套 SDK 架构、packaged 五阶段 query、体积、update metadata、codesign/notarization、`spctl`。任一失败都不会创建 draft。

## 3. 首个 RC

在获得提交/推送授权后：

1. 创建 `codex/v1-rc` 分支，提交当前工作区并推送。
2. 等待 `CI` 的 Linux quality、macOS ARM、macOS Intel、Windows jobs 全绿。
3. 合入 `master` 后创建与 `package.json` 完全一致的 annotated tag：`v1.0.0-rc.1`。
4. Release workflow 成功后保持 GitHub Release 为 draft，下载到干净 Apple Silicon、Intel Mac 和 Windows 11。
5. macOS 执行 `spctl --assess --type execute --verbose=2 <App>`；Windows 核对 SHA-256 并记录 SmartScreen 行为。

## 4. 真实数据门禁

### 米游社

在应用内完成登录后运行：

```bash
npm run gate:miyoushe-detail
```

至少覆盖 3 个国服账号/网络条件，记录 `owned/detailed/missing/partial` 数量；展示柜开/关、过期 Cookie、captcha/partial 都要出现于矩阵。输出若不是 `passed` 不计通过。

### Provider

用临时 shell 环境运行，不写 `.env`：

```bash
GTA_PROVIDER_API_KEY='…' \
GTA_PROVIDER_BASE_URL='https://provider.example' \
GTA_PROVIDER_MODEL='model-id' \
npm run gate:provider-contract
```

Anthropic 直连和至少一个 Anthropic Messages 兼容端点各通过一次；随后在 RC 应用内完成一条完整推荐。只记录 provider alias、HTTP 状态/耗时和结果，不记录请求体。

## 5. 更新闭环

1. 在 rc.1 安装后创建 `1.0.0-rc.2`，只合入 P0/P1 修复并补回归测试。
2. tag `v1.0.0-rc.2`，等待已验证 assets 进入 draft/RC channel。
3. 在 macOS ARM/Intel 与 Windows 11 从 rc.1 UI 检查、下载、重启安装 rc.2。
4. 更新前写入测试 Profile、History、API Key/custom header 与语言设置；更新后确认全部保留且 secret 不回显。
5. 离线、404、下载中退出后重进各执行一次，确认 Settings 出现可恢复 error/check/download 状态。

## 6. Soak 与正式 1.0

- 最后一个 RC 在所有目标平台稳定运行至少 5 个自然日。
- 期间只接收 P0/P1、安全、崩溃、数据丢失、安装/更新修复；出现 P0 后重新计时。
- 全部表格转为通过后，将版本改为 `1.0.0`，更新 CHANGELOG/下载说明，再走同一 Release workflow。
- 正式 Release 前最后一次从匿名网络读取 update metadata 和资产，确认 updater 不依赖维护者 token。
