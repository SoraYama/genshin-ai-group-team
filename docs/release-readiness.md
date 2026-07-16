# 1.0 发布凭据与渠道清单

> 更新日期：2026-07-16。此文件只记录 owner 和就绪状态，不记录密码、token 或证书私钥。

| 项目 | Owner | 当前状态 | 验收证据 |
| --- | --- | --- | --- |
| GitHub 仓库可见性 | 仓库维护者 | 当前为 private，P0 blocker | 公开源码仓库与 Release 可被未登录 updater 读取 |
| macOS Developer ID Application | 维护者 | 已在本机发现 | `Developer ID Application: Yanqi Hou (86QXUB3AFS)`；`pack:dir` 深度签名成功 |
| Apple Team ID | 维护者 | 已确认 | `86QXUB3AFS` |
| Apple notarization 凭据 | 维护者 | 远端 Actions secrets 为空，P0 blocker | 配置 CI secrets；产物通过 `spctl --assess` |
| GitHub Releases 写权限 | 仓库维护者 | 本机 owner 登录且有 `repo` scope；远端 workflow 尚未推送 | RC tag workflow 在全平台验证后创建 draft release |
| GitHub update feed | 仓库维护者 | 代码与 publish 配置已完成，待 RC 实发 | `latest-mac.yml` / Windows metadata 可由已发布 RC 获取 |
| Windows 构建 runner | 仓库维护者 | CI 已配置，结果待运行 | Windows 原生 optional SDK binary、NSIS 安装/覆盖安装/SDK/卸载/数据保留 smoke |
| Windows 签名 | 不适用 | 1.0 明确不签 | 发布文档展示 SmartScreen 提示和校验值 |
| Anthropic 直连测试 Key | 发布验证者 | 不入仓库，待 RC 手测 | 只记录 gate 结果，不保存 Key |
| 兼容 Messages 端点 | 发布验证者 | 待选择 | 至少一个 known-good base URL 通过 provider contract gate |
| 米游社 Beta 账号/IP | Beta 维护者 | 当前机器无可复用登录态 | 3～5 个脱敏 gate summary，不收集 Cookie/raw profile |

## 当前发布判断

- 当前版本：`1.0.0-rc.1`，尚未创建 tag 或远端 draft。
- 已通过：106 项 unit/eval、2 项 Electron E2E、源码门禁、全依赖 0 vulnerability，以及最终源码对应的 `release-rc1-signed-final` macOS universal 双架构/Developer ID 深度签名、production-options packaged 五阶段 SDK mock、updater 元数据和体积预算。
- 最终 signed 候选的 `codesign --verify --deep --strict` 有效，但 `spctl` 明确以 `Unnotarized Developer ID` 拒绝；直接 executable smoke 通过不等于干净机器 Gatekeeper 启动通过，不能替代公证。
- Release workflow 已改为先完成 macOS/Windows E2E、打包态 SDK、体积、更新元数据、Gatekeeper/NSIS 闸门，再由独立 job 汇总并创建 draft；不会先上传未验证包。
- 远端当前无 workflow/run 记录，因为工作区改动尚未提交推送；这不计作 CI 通过。
- 未通过：公开仓库/Release、Apple 公证、GitHub RC 自动更新、Windows CI/安装闭环、真实账号 list/detail coverage、真实 Provider、RC soak。当前外部 gate 分别返回 `no-persisted-login` 与 `missing-env`。
- 因此当前仍是开发态 No-Go，不发布 1.0。
