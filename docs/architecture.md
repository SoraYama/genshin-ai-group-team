# Architecture

本文描述 1.0 当前实现，作为改动边界和验证入口；目标架构与现实不一致时，以代码与本文件的同步变更为合并条件。

## 进程与信任边界

```text
Renderer (React, sandbox)
  └─ window.api 白名单
       ↓ invoke / advisor:event / update:event
Preload (contextBridge, CJS)
       ↓ 已登记 IPC contract
Main (Electron + Node)
  ├─ Config / Profile / History / Scenario stores
  ├─ Miyoushe / Enka / icon proxy / updater
  └─ AdvisorAgent → host Orchestrator → five isolated SDK queries
                         ↓
                    user-selected LLM baseUrl
```

- Renderer 没有 Node 能力，不直接访问外部网络，也拿不到 Cookie、API Key 或已保存的 custom header 值。
- Preload 只暴露 `src/shared/ipc-contract.ts` 中登记的 channel；启动时 `ensureAllChannelsRegistered()` 检查遗漏。
- Main 拒绝权限请求、弹窗、webview 和应用外导航。图标通过 `gtai-img:` 协议由 Main 代理。
- 所有外部响应都在 Main 标准化；IPC 未知异常只返回稳定错误码，不返回 raw body 或凭据。

## 数据链路

1. 内置登录窗口把米游社 Cookie 留在隔离的持久 Chromium partition；Renderer 只收到短期 `sessionId`。
2. 米游社 `character/list` 确定完整 owned roster，`character/detail` 补充 build；失败会按角色记录 partial/missing，而不是伪造 0。
3. Enka 仅补强展示柜角色，遵守响应 TTL 与 429；展示柜为空不等同于账号无角色。
4. `ProfileMerger` 写入 Profile v2，保留 field provenance、coverage 和旧缓存 migration。
5. `AdvisorProfileSerializer` 生成有界摘要，排除凭据、URL、raw response 与完整圣遗物副词条。

## 推荐链路

`AdvisorOrchestrator` 是 Main 内的确定性控制面，顺序执行五个相互隔离、每阶段 `maxTurns: 1` 的 SDK query：

```text
DataCurator → TeamComposer → Critique → RotationCoach → Explain
```

每阶段输入输出都经过 Zod 契约验证，并有 45 秒超时、统一取消信号和 usage 汇总。Composer 只能选择 owned/usable ID；Critique 必须逐队审查；Rotation 与 Explain 必须覆盖所有保留队伍。任一阶段失败时由 `AdvisorAgent` 返回明确标注的本地启发式 fallback。

Orchestrator 自身不调用 LLM、不生成队伍，也不暴露 Claude 原生 `Agent/Task`；它使用版本化 route policy 承担路由、校验、取消和汇总。因此六类职责的实际部署是 1 个 host control plane + 5 个 LLM roles，而不是 6 个可递归 spawn 的模型进程。

SDK 默认拒绝所有原生工具与递归 Agent/Task，只允许纯文本 query；运行时二进制必须从已锁定版本依赖或打包后的 `asar.unpacked` 路径解析。

## 本地持久化

| 数据 | 位置 | 保护方式 |
| --- | --- | --- |
| API Key / custom header 值 | `userData/config.json` | `safeStorage` 密文；公开配置只返回存在性/名称 |
| 米游社 Cookie | `persist:miyoushe-login` partition | Chromium OSCrypt；支持应用内清除 |
| Profile / History / 场景缓存 | `userData` | 本机 JSON；不上传作者服务 |
| 推荐 SDK session | 不持久化 | 每阶段独立短会话 |

卸载默认保留 `userData` 防止误删；完整删除流程见 `privacy.md`。

## 更新与发布

- macOS 产出 DMG + ZIP；ZIP 和 `latest-mac.yml` 是自动更新必需品。1.0 必须 Developer ID 签名并经 Apple notarization。
- Windows 产出 NSIS，1.0 暂不签名；CI 必须验证安装、打包态 SDK、卸载和用户数据保留。
- updater 不静默安装：检查、下载、重启安装都在 Settings 显示状态并由用户确认。
- Release workflow 只响应与 `package.json` 版本一致的 `v*` tag，并发布 draft assets 与 SHA-256 manifest。

## 验证阶梯

```text
gate:local
  → Electron E2E
  → audit
  → package + size/update metadata gates
  → packaged SDK protocol smoke
  → real Miyoushe/provider gates
  → signed/notarized install + rc.1→rc.2 update
  → five-day RC soak
```

自动门禁、命令和未完成的外部证据统一记录在 `rc-validation.md`。任何 P0 未通过时均保持 No-Go。
