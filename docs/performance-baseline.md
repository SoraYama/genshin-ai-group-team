# 1.0 性能与体积基线

> 本文记录可重复执行的门禁，不把单台开发机的偶然数字当作跨平台承诺。

| 指标 | 1.0 门禁 | 运行方式 |
| --- | ---: | --- |
| 首个 Electron 窗口可用 | `< 15 s` | `npm run test:e2e:run` |
| Renderer 生产目录 | `<= 20 MiB` | `npm run test:package-budget` |
| Renderer 文件数 | `<= 30` | 同上 |
| 单架构 unpacked 应用 | `<= 650 MiB` | 同上 |
| macOS universal unpacked 应用 | `<= 1150 MiB` | 同上 |
| macOS universal ZIP | `<= 450 MiB` | 同上 |

2026-07-16 基线：Renderer 由全字体包的约 25 MiB / 814 assets 降到约 12 MiB / 17 assets。Noto Sans SC 只打包简体中文子集，JetBrains Mono 只打包 Latin 子集。

体积主要由 Electron runtime 和 Agent SDK 平台 binary 构成。2026-07-16 最终 Developer ID signed universal 候选为 1058.0 MiB unpacked / 419.8 MiB ZIP：Electron Framework 487 MiB，两个锁定的 SDK executable 合计约 471 MiB，app resources 约 96 MiB。universal 阈值保留约 9%/7% 回归余量；单架构阈值从原 800 MiB 收紧到 650 MiB。

优化不得通过移除打包态 SDK、禁用 source-map 之外的安全诊断，或改用系统中不存在的外部 CLI 来伪造指标。
