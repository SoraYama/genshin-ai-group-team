# genshin-team-advisor

> 原神 AI 配队助手 — 本地优先的开源桌面应用。玩家自带 LLM Key，自己掌控数据。

## 状态

`v0.1` Walking Skeleton — Electron 壳 + IPC 通路 + Settings 页（仅 LLM Key 录入与连接测试）。

详细产品定位、架构、Agent 编排见 [CLAUDE.md](./CLAUDE.md)。

## 开发

```bash
npm install
npm run dev          # vite + tsup --watch + electron 同时启动
npm run typecheck
npm run test
npm run pack:dir     # 出 unpacked 目录用于本地试装
```

## License

GPL-3.0-or-later. 见 [LICENSE](./LICENSE)。
