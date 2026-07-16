# 1.0 RC 验收记录

> 自动门禁只能证明可重复的软件行为；真实账号、真实 Provider、系统公证与更新渠道必须留下脱敏人工证据。不得记录 Cookie、Key、完整 UID 或 raw Profile。

当前候选版本：`1.0.0-rc.1`（尚未 tag/发布）。

## 自动门禁

| Gate | 命令 / CI | 状态 |
| --- | --- | --- |
| lint + typecheck + 106 unit/eval + build | `npm run gate:local` | 本机通过 |
| Electron UI + zh/en 热切换 + 冷启动预算 | `npm run test:e2e:run` | 本机通过 |
| 生产依赖 high/critical | `npm run audit:prod` | 0 |
| macOS updater 元数据 | `npm run test:update-metadata -- release-rc1-signed-final` | `1.0.0-rc.1` 通过；校验 app-update/latest-mac/ZIP 文件名与 SHA-512，未发现敏感字段 |
| Renderer / 单架构体积 | `npm run test:package-budget` | 12 MiB / 605.1 MiB，本机通过 |
| macOS universal 架构 / 体积 | `lipo -info` + `GTA_RELEASE_DIR=release-rc1-signed-final npm run test:package-budget` | 主程序与 Framework 均为 x86_64+arm64；1058.0 MiB unpacked / 419.8 MiB ZIP |
| macOS universal packaged SDK | `GTA_RELEASE_DIR=release-rc1-signed-final npm run test:packaged:sdk` | `1.0.0-rc.1` production options 下五阶段 mock 连续 4 次通过 |
| macOS Developer ID 深度签名 | `codesign --verify --deep --strict` | 最终 signed 候选通过；Team ID `86QXUB3AFS` |
| macOS Apple 公证 / Gatekeeper | `spctl --assess` | **未通过：Unnotarized Developer ID** |
| Windows unpacked SDK | Windows CI | 待 CI |
| Windows NSIS 安装→覆盖安装→SDK→卸载→数据保留 | Windows CI | 待 CI |

2026-07-16 外部 gate 现状：米游社返回 `skipped/no-persisted-login`；Provider 返回 `skipped/missing-env`。skip 不计通过。

观察项：最终 signed 候选在刚完成约 1 GiB 深度签名与 ZIP 压缩后，第一次 packaged SDK smoke 曾被系统以 `SIGKILL` 终止；SDK 二进制直接验证/启动正常，随后完整 smoke 连续 4 次通过，未加入自动重试。若 CI 或干净机器再次出现，按 RC blocker 处理并保留系统诊断日志。

## 外部门禁（脱敏填写）

### 米游社账号矩阵

运行 `npm run gate:miyoushe-detail`，只记录 `owned/detailed/missing/partial` 汇总。

| Account alias | 网络/地区 | 展示柜 | 结果 | 日期 |
| --- | --- | --- | --- | --- |
| beta-a | 待填写 | 开 | 待验证 | — |
| beta-b | 待填写 | 关 | 待验证 | — |
| beta-c | 待填写 | 开 | 待验证 | — |

### Provider 矩阵

以临时环境变量运行 `npm run gate:provider-contract`。输出只包含状态码和耗时。

```bash
GTA_PROVIDER_API_KEY='…' \
GTA_PROVIDER_BASE_URL='https://provider.example' \
GTA_PROVIDER_MODEL='model-id' \
npm run gate:provider-contract
```

| Provider alias | 直连/兼容 | 连接 | 完整推荐 | 日期 |
| --- | --- | --- | --- | --- |
| Anthropic | 直连 | 待验证 | 待验证 | — |
| compatible-a | 兼容 | 待验证 | 待验证 | — |

### 更新、系统与 soak

| Gate | 状态 | 证据 |
| --- | --- | --- |
| 公开源码与匿名 Release 访问 | **未通过：远端仓库为 private** | 设为 public 后用未登录请求读取 release/update metadata |
| GitHub draft Release 写权限 | 本机 owner `repo` scope 已确认；实发待验证 | tag workflow 全平台验证后创建 draft |
| `rc.1 → rc.2` macOS 自动更新 | 待验证 | Profile/History/Key 保持 |
| `rc.1 → rc.2` Windows 自动更新 | 待验证 | Profile/History/Key 保持 |
| macOS Apple Silicon | 待 RC | 安装、启动、推荐、更新 |
| macOS Intel | CI 已配置，待 RC | universal app + Intel runner |
| Windows 11 | CI 已配置，待 RC | NSIS install/uninstall |
| 最后一个 RC 5 个自然日无 P0 | 未开始 | 起止日期待填写 |

## Release 判定

以上任一 P0 为“待验证/未通过”时保持 No-Go。自动化 skip、Enka 可用、源码构建通过或手动绕过 Gatekeeper，都不能替代对应门禁。
