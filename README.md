# genshin-team-advisor

> 原神 AI 配队助手 — 本地优先的开源桌面应用。玩家自带 LLM Key，自己掌控数据。

## 状态

`1.0.0-rc.1` 候选代码已完成，当前仍为 **No-Go**：本机源码/Electron/universal packaged gates 已通过；Apple 公证、Windows 安装更新、真实账号与 Provider、远端 RC 更新和 5 天 soak 尚未完成。

详细产品定位与约束见 [AGENTS.md](./AGENTS.md)，当前实现见 [docs/architecture.md](./docs/architecture.md)，执行计划见 [docs/v1.0-sprint-plan.md](./docs/v1.0-sprint-plan.md)。

## 开发

```bash
npm install
npm run dev          # vite + tsup --watch + electron 同时启动
npm run typecheck
npm run test
npm run test:e2e
npm run pack:dir     # 出 unpacked 目录用于本地试装
```

## 质量闭环

```bash
npm run gate:local   # lint（零警告）+ typecheck + unit + build
npm run test:e2e     # production build + Electron UI smoke
npm run audit:prod   # 仅生产依赖的安全审计
npm run audit:all    # 全依赖 high/critical 安全门禁
npm run gate:all     # 本机完整门禁
npm run gate:miyoushe-detail      # opt-in：读取本机持久登录态，验证 index/list/detail
npm run test:packaged:sdk         # pack:dir 后验证当前平台打包态完整 Agent 编排
npm run test:update-metadata      # 完整 macOS 打包后验证 updater 元数据与 ZIP checksum
```

Electron E2E 使用独立临时 `userData`，不会读取或修改本机真实 Cookie、API Key、角色缓存。
当前全依赖安全审计为 0 个已知漏洞；CI 会阻断全依赖 high/critical。

Agent 默认不开放任何 Claude 原生工具。API Key 只注入单次 SDK 子进程；Cookie 只存在于 Electron 主进程和加密的持久 partition，不进入 renderer、fixture 或推荐历史。

## 使用与隐私

- [隐私说明 / Privacy](./docs/privacy.md)
- [数据获取 / Data acquisition](./docs/data-acquisition.md)
- [LLM Provider 配置](./docs/llm-provider.md)
- [故障排查 / Troubleshooting](./docs/troubleshooting.md)
- [1.0 RC 操作手册](./docs/rc-operator-runbook.md)
- [第三方资源与商标说明](./resources/credits.md)

界面可在中文与 English 间即时切换。中文是推荐内容的默认语言；English 覆盖核心 UI、错误与发布/排障文档。

## License

GPL-3.0-or-later. 见 [LICENSE](./LICENSE)。
