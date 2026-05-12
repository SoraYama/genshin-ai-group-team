# genshin-team-advisor

> 原神 AI 配队助手 — 本地优先的开源桌面应用。玩家自带 LLM Key，自己掌控数据。
>
> **License**: GPL-3.0（衍生项目必须同样开源，防止被闭源 fork）
> **Repo / 包名（占位）**: `genshin-team-advisor` — 后续可改名，仅作 scaffold 时使用

## 1. 产品定位

**是什么**
- 一个跑在玩家电脑上的 Electron 桌面应用。
- 输入米游社 Cookie 或 Enka UID，本地拉取角色面板，调用玩家自己配置的 LLM，给出当期深渊/活动的配队建议与解释。
- 完全开源，二进制由社区自己打包或从 Release 下载。

**不是什么**
- 不是 SaaS：无服务器后端，无登录系统，无运营成本。
- 不替玩家承担 LLM 费用：作者从不持有任何 API Key。
- 不是数据采集器：所有数据本地存储，不上传任何遥测。
- 不复刻原神素材：仅在 UI 风格上向官方致敬，不嵌入原版立绘 / 音频 / 字体。

**核心价值主张**
1. **隐私本地**：Cookie 仅在主进程内存中短暂使用，绝不发往作者的服务器。
2. **模型自由**：玩家任意配置 Anthropic 直连或兼容端点（base URL 可改）。
3. **完整可审计**：所有外部请求路径、Prompt、缓存格式开源，玩家可关电源停服。

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 容器 | Electron 39+ | 跨 Win/macOS/Linux，主进程拥有 Node 全部能力 |
| 渲染层 | React 19 + TypeScript | 组件生态最广 |
| 构建 | Vite（renderer）+ tsup（main/preload）| 与参考项目 arkwright 对齐；renderer HMR + main 端 ESM 输出 |
| LLM | `@anthropic-ai/claude-agent-sdk` | 用户提供 Anthropic Key 或兼容 base URL；SDK 负责工具调用、流式、对话管理。注：SDK 内部 spawn 自带的 `cli.js`，**用户无需预装 Claude Code CLI**——SDK 的 cli.js 通过 npm install 进入 `node_modules`，打包时由 `asarUnpack` 暴露给 Electron 子进程，用 Electron 自带 Node runtime 执行。配置通过 `Options.env` 注入 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`。 |
| 配置存储 | `electron-store`（普通配置）+ `safeStorage`（API Key 等敏感字段） | 利用 OS 钥匙串能力，不裸存明文 |
| 缓存 | `app.getPath('userData')` 下结构化 JSON / SQLite | 与 SDK 会话绑定，可清理 |
| 状态管理 | Zustand（renderer 内），跨进程靠 IPC | 轻、可持久化、类型友好 |
| HTTP | undici（主进程内）| 避免引入 axios 重型依赖 |
| 测试 | Vitest（main + 单元）+ Playwright（renderer E2E）| 与现仓一致，迁移成本低 |
| Lint/Format | ESLint + Prettier | 必须配，避免重蹈一千行 App.tsx 覆辙 |

## 3. 进程架构

```
┌─────────────────────────────────────────────────────────────┐
│                       Renderer (React)                      │
│   只能见到 window.api.*，不持有任何凭据，不直接联网          │
└─────────────────────────────────────────────────────────────┘
                  │ contextBridge.exposeInMainWorld
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                       Preload (CJS)                         │
│   类型化 IPC 桥；只暴露白名单 channel                        │
└─────────────────────────────────────────────────────────────┘
                  │ ipcRenderer.invoke / on
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                       Main (Node)                           │
│  ├─ ConfigService    （electron-store + safeStorage）       │
│  ├─ MiyousheClient   （Cookie → 角色列表）                  │
│  ├─ EnkaClient       （UID → 角色面板）                     │
│  ├─ AvatarMetadata   （Enka 元数据缓存）                     │
│  ├─ ProfileCache     （userData/profiles.sqlite）           │
│  ├─ AdvisorAgent     （claude-agent-sdk query 包装）        │
│  └─ HistoryStore     （推荐历史 + 全文检索）                │
└─────────────────────────────────────────────────────────────┘
```

**铁律**
- Renderer **从不**直接调 `fetch` 访问外部域名。所有外部 IO 走 IPC → Main。
- 凭据（米游社 Cookie / API Key）**从不**进入 Renderer 进程内存，前端只见 `hasCookie: boolean` 这种谓词。
- Main 进程默认禁用 `nodeIntegration`，启用 `contextIsolation` + `sandbox`。

## 4. 目录结构

```
.
├── CLAUDE.md
├── README.md
├── LICENSE
├── package.json                    # workspaces: 否（单包，直接放 src/）
├── electron-builder.json
├── vite.config.ts                  # renderer 专用
├── tsup.config.ts                  # main + preload
├── tsconfig.json                   # renderer
├── tsconfig.node.json              # main + shared
│
├── src/
│   ├── main/
│   │   ├── index.ts                # app.whenReady, BrowserWindow
│   │   ├── preload.ts              # contextBridge
│   │   ├── ipc/
│   │   │   ├── registry.ts         # 统一注册器，类型由 shared 推导
│   │   │   ├── config.ipc.ts
│   │   │   ├── miyoushe.ipc.ts
│   │   │   ├── enka.ipc.ts
│   │   │   ├── advisor.ipc.ts
│   │   │   └── history.ipc.ts
│   │   ├── services/
│   │   │   ├── config-service.ts
│   │   │   ├── miyoushe-client.ts
│   │   │   ├── enka-client.ts
│   │   │   ├── avatar-metadata.ts
│   │   │   ├── profile-store.ts
│   │   │   ├── history-store.ts
│   │   │   └── advisor-agent.ts    # claude-agent-sdk 包装
│   │   ├── agents/                 # 见 §5
│   │   │   ├── orchestrator/
│   │   │   ├── data-curator/
│   │   │   ├── team-composer/
│   │   │   ├── critique/
│   │   │   ├── rotation-coach/
│   │   │   └── explain/
│   │   └── windows/
│   │       └── main-window.ts
│   │
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx                 # 路由壳，纯组装
│   │   ├── pages/
│   │   │   ├── Onboarding/         # 首次启动引导（Cookie/UID/API Key）
│   │   │   ├── Roster/             # 角色总览
│   │   │   ├── Advisor/            # 配队推荐主流程
│   │   │   ├── History/            # 推荐历史
│   │   │   └── Settings/           # 模型 / 数据源 / 关于
│   │   ├── components/             # 通用 UI 原语
│   │   ├── design/                 # 主题 token、原神风格 SVG 装饰、字体声明
│   │   ├── store/                  # Zustand slices
│   │   ├── ipc/                    # window.api 的类型化 hook 包装
│   │   └── styles/
│   │
│   └── shared/
│       ├── ipc-contract.ts         # 渲染/主进程共享的 IPC 类型定义
│       ├── domain.ts               # CharacterProfile, Recommendation 等
│       └── errors.ts
│
├── resources/                      # 应用图标、安装图、原神风格 SVG 装饰资源
├── docs/
│   ├── architecture.md
│   ├── data-acquisition.md         # 用户怎么取 Cookie / UID（含截图）
│   └── llm-provider.md             # 各家兼容端点配置示例
└── tests/
    ├── unit/                       # Vitest，跑 main/services
    └── e2e/                        # Playwright，跑 renderer
```

## 5. Agent 编排（Claude 介入点）

> 本节单独立章，因为 claude-agent-sdk 是这个产品的"大脑"，分工必须明确。**核心原则：Agent 之间的边界 = 输入输出契约 + 系统提示词 + 可用工具集 三件套**，不允许任何 Agent 越权访问外部世界（外部 IO 必须走 Skill Tool）。

### 5.1 总览

```
                            ┌───────────────────────────┐
   用户 ←─ IPC 流式 ──▶     │  OrchestratorAgent (主)   │
                            │  系统提示：路由 / 用户对话 │
                            └─────────────┬─────────────┘
                                          │ spawn (sub-agent)
            ┌────────────────┬────────────┼────────────┬─────────────────┐
            ▼                ▼            ▼            ▼                 ▼
   ┌──────────────┐ ┌────────────────┐ ┌─────────┐ ┌────────────┐ ┌───────────────┐
   │ DataCurator  │ │ TeamComposer   │ │Critique │ │ Rotation   │ │ ExplainAgent  │
   │ (静默后台)   │ │ (产出 2-3 套)  │ │(红队)   │ │ Coach      │ │ (面向用户解释)│
   └──────────────┘ └────────────────┘ └─────────┘ └────────────┘ └───────────────┘

   ── Skill Tools （SDK in-process，所有 Agent 可申请使用）──
   ┌────────────────────────────────────────────────────────────────────┐
   │ fetch_miyoushe_roles · fetch_enka_profile · read_profile_cache    │
   │ query_genshin_db · query_enemy_data · append_history · log_event  │
   └────────────────────────────────────────────────────────────────────┘
```

### 5.2 Agent 角色定义

| Agent | 输入 | 输出 | 系统提示要点 | 允许的 Tool | 何时启动 |
|---|---|---|---|---|---|
| **OrchestratorAgent** | 用户自然语言 + 上下文 | 流式回复 + 子任务调度 | 不回答专业配队问题，只做路由、追问、汇总。**不允许**自己生成队伍。 | 全部 Skill Tools + spawn 各子 Agent | 用户进入 Advisor 页 |
| **DataCuratorAgent** | UID / Cookie | 标准化的 `ProfileBundle` | 数据清洗 + 缺字段补全。失败要降级（Enka 挂 → miyoushe-only）。 | `fetch_miyoushe_roles`、`fetch_enka_profile`、`query_genshin_db`、`read_profile_cache` | 用户绑定 UID 时；数据缓存过期时 |
| **TeamComposerAgent** | `ProfileBundle` + 敌人列表 + 偏好 | 2~3 套队伍 JSON（无解释） | 只关心"组队是否成立"，重元素反应、坑位互补、充能闭环。**禁止输出 markdown 段落**，只输出结构化 JSON。 | `query_genshin_db`、`query_enemy_data`（只读） | Orchestrator 在用户发起推荐时调用 |
| **CritiqueAgent** | TeamComposer 的 JSON | 弱点清单（issue list） | 红队视角：找元素冲突、充能黑洞、无法触发反应、敌人元素免疫。**不修改队伍**，只挑刺。 | `query_genshin_db`、`query_enemy_data`（只读） | TeamComposer 完成后强制调一次 |
| **RotationCoachAgent** | 单套队伍 | 循环手法 + 关键节点 | 站位顺序、E/Q 释放节奏、触发反应链路、注意事项。 | `query_genshin_db`（只读） | 每套队伍生成详情页时按需调 |
| **ExplainAgent** | TeamComposer 输出 + Critique 弱点 + Rotation | 给玩家看的中文解释（带语气） | 把上面三个 Agent 的硬输出"翻译"成玩家能读的话；带情境感（"这套适合开荒""这套打深渊更稳"）。 | 无（仅做转写） | 推荐流程末尾，最终给用户看的就是它的输出 |

### 5.3 关键设计决策

1. **TeamComposer / Critique / Explain 解耦**：避免一个超大提示词同时背三件事——分开后每个的提示词都可单独优化、单独测试，且 Critique 是真正的独立观察者（不是 self-review）。
2. **DataCurator 后台静默**：玩家不应该感知它的存在；只在数据失效时被唤醒。它**不**进入 Orchestrator 的对话历史，避免污染上下文。
3. **Orchestrator 不亲自配队**：写死在系统提示里。这是为了避免"小模型也能配"的问题——Composer 必须用够强的模型，Orchestrator 用一个便宜的模型即可。**两者可配置不同的 model**。
4. **Skill Tools 是唯一 IO 通道**：任何 Agent 都不能直接 `fetch` / `fs.read`。Tool 实现都在 main 进程的 services/ 下，调用前由 main 校验参数，调用后写日志（带 redact）。
5. **流式协议**：Orchestrator 用 SDK 的 streaming，把 sub-agent 的进度（"正在分析敌人…""正在生成队伍…"）作为 progress event 通过 IPC 转给 renderer，渲染端展示成 stepper。
6. **失败降级**：任何 sub-agent 超时 / 报错 → Orchestrator 走规则引擎 fallback（保留现仓的 `scoreCharacter` 思路重做），向用户明确"AI 不可用，已用本地启发式算法"。

### 5.4 提示词与版本管理

- 每个 Agent 的系统提示词独立成文件：`src/main/agents/<name>/prompt.ts`（导出字符串常量）。
- 提示词带版本号（如 `TEAM_COMPOSER_PROMPT_V1`），CHANGELOG 记录每次调整与起因。
- Prompt 单测：`tests/unit/agents/<name>.spec.ts` —— 给定典型输入，断言 SDK 的 mock 返回能被 Agent 正确解析（用 `claude-agent-sdk` 的测试 hook 或自写 mock query）。

### 5.5 与 SDK 的具体衔接

- 主 Agent 用 `query({ systemPrompt, mcpServers, tools })` 启动；sub-agent 通过 `Task` MCP tool 由 Orchestrator 主动 spawn（参考 arkwright `/src/main/cc/mcp-server.ts` 的 `createMcpServers` 模式）。
- Skill Tools 用 `createSdkMcpServer({ name, tools: [...] })` 注册；每个 tool 必须有 `inputSchema`（zod）和 `outputSchema`，主进程的 IPC 层在 tool 执行前后加日志埋点。
- Token 计费/上限提醒：从 SDK 的 usage event 取 token 数，写到 settings → "本月用量"小卡片，玩家心里有数。

## 6. IPC 协议

**命名空间**：`<domain>:<action>`，例如 `advisor:recommend`、`config:set-llm`。

**类型契约**：在 `src/shared/ipc-contract.ts` 用 discriminated union 定义所有请求/响应：

```ts
export type IpcContract = {
  'config:get-public': { req: void; res: PublicConfig };          // 不含 secret
  'config:set-llm':    { req: LlmConfigInput; res: { ok: true } };
  'config:test-llm':   { req: void; res: LlmHealthReport };
  'miyoushe:bind':     { req: { cookie: string }; res: BindResult };
  'enka:refresh':      { req: { uid: string }; res: ProfileBundle };
  'advisor:recommend': { req: AdvisorInput; res: never };          // 流式，走 event channel
  // ...
};
```

**流式事件**：长任务（推荐生成）使用 `mainWindow.webContents.send('advisor:event', ...)`，渲染端通过 `window.api.advisor.onEvent(cb)` 订阅，返回 unsubscribe。

**安全**：preload 维护白名单，未注册的 channel 一律拒绝。

## 7. 配置 & 凭据管理

| 类别 | 存储 | 示例 |
|---|---|---|
| 普通设置 | `electron-store` 明文 JSON | 主题、是否自动更新元数据 |
| LLM API Key | `safeStorage.encryptString` 后存到 userData/secrets.bin | Anthropic key、自定义 base URL token |
| 米游社 Cookie | Electron 持久化 partition `persist:miyoushe-login`（默认 cookie DB），由 Chromium OSCrypt 加密；可通过 `miyoushe:logout` 一键清除 | `ltoken_v2=...; ltuid_v2=...; ltmid_v2=...` |
| 已绑定 UID | `electron-store` | 玩家可绑多个 UID |

**Provider 策略：仅 Anthropic 直连 + 兼容 baseUrl**（决策已锁定）。Settings → LLM 配置仅有四个字段：
- `apiKey`（必填，`safeStorage` 加密落盘）
- `baseUrl`（可选，默认 `https://api.anthropic.com`；兼容 Anthropic Messages 协议的代理在此填即可：智谱 / 魔搭 / OpenRouter / 自建 Claude 兼容网关）
- `model`（默认 `claude-sonnet-4-6`，文本输入框可手改；下拉只给 known-good 列表作快捷选择）
- `customHeaders`（可选 KV，应对部分代理需要 `X-Api-Key` 等附加头）

**不引入多 provider 抽象层** —— 代码里 SDK 是唯一调用路径，复杂度收敛在"换 baseUrl"这一根杠杆上。如果未来有玩家强需 OpenAI 协议，再评估升级路径。

**SDK 接入要点**：
- 用户配置通过 `query({ options: { env: { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL } } })` 注入子进程，env 不污染 `process.env`，进程退出即清除。
- `Options.pathToClaudeCodeExecutable` 显式指向 `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`（dev 环境）或 `process.resourcesPath/app.asar.unpacked/node_modules/.../cli.js`（打包后）。
- `Options.executable: 'node'`，runtime 用 Electron 内置 Node。
- 通过 `disallowedTools: ['Bash', 'Edit', 'Write', 'WebFetch', ...]` 关掉所有不需要的 Claude Code 原生 tools，只保留我们自己 `createSdkMcpServer` 注册的业务工具。

## 8. 数据流（推荐生成示例）

```
[Renderer Settings 页]
   ↓ ipc: config:set-llm
[Main: ConfigService] → safeStorage 加密落盘

[Renderer Onboarding]
   ↓ ipc: miyoushe:bind { cookie }
[Main: MiyousheClient] → 米游社 → 角色列表
   ↓ ipc: enka:refresh { uid }
[Main: EnkaClient] → enka.network → 面板数据 → ProfileStore

[Renderer Advisor]
   ↓ ipc: advisor:recommend { uid, enemies, preference }
[Main: AdvisorAgent]
   ├─ 读取 ProfileStore
   ├─ claude-agent-sdk query() with userKey
   ├─ 流式回吐 token / tool_use / final
   └─ HistoryStore.append(...)
   ↓ event: advisor:event (delta | done | error)
[Renderer] 增量渲染推荐结果
```

## 9. 缓存与持久化

| 内容 | 路径（相对 userData）| 引擎 |
|---|---|---|
| 设置 | `config.json` | electron-store |
| 加密凭据 | `secrets.bin` | safeStorage |
| 角色 / 面板缓存 | `cache/profiles.json` | 自维护 JSON（v1）→ 后期可升 sqlite |
| Enka 元数据 | `cache/enka-meta.json` + 1h TTL | 自维护 |
| 推荐历史 | `history.json`（200 条上限）| 自维护 |
| Agent 会话 | `sessions.sqlite` | better-sqlite3（v2 引入） |

## 10. 安全边界

- **CSP**：Renderer 进程默认 CSP `default-src 'self'`；外链图标走主进程代理（避免 enka.network 直连导致渲染端持有任何远端关联）。
- **Cookie 处理**：永不跨进程边界，但**允许由 Electron 自己持久化**到加密的 session partition。
  - 推荐路径：弹独立 `BrowserWindow`（`persist:miyoushe-login` 持久化 session partition）让用户在内置 Chromium 里登录米游社，主进程轮询 `session.cookies` 直到三个关键 cookie (`ltoken_v2` / `ltuid_v2` / `ltmid_v2`) 都出现，立即提取拼装、关窗。**不再 `clearStorageData`** —— cookie 留在分区的加密 SQLite 里。
  - 加密层：Chromium `OSCrypt` —— macOS 用 Keychain 派生密钥 + AES-128-CBC；Windows 用 DPAPI；Linux 用 kwallet/gnome-keyring。与 `safeStorage` 同一套底层。
  - App 启动时 `seedRosterSessionsFromPersistedCookie` 从分区读 cookie、调一次 `miyoushe.fetchRoles` 校验，然后把 cookie 注入 `RosterSessionStore`（24h 内存 TTL，按 UID 索引，供刷新使用）。
  - 提取的 cookie 仍**经由 main 进程内的 `LoginSessionStore`**（5 分钟、单次消费）传给 `profile:import-from-session`，渲染端拿到的只是 sessionId，**永远见不到 cookie 字面值**。
  - 用户可通过 `miyoushe:logout` IPC 一键清除 partition（Roster 页 "退出米游社登录" 按钮即此通道），相当于 Chromium 自带的退出登录功能。Cookie 自然过期时 Chromium 也会按 `expirationDate` 自动驱逐。
  - 手动粘贴路径作为退路保留，整条链路仍在 IPC handler 作用域。
  - 日志强制 redact `cookie` / `apiKey` / `Authorization` 字段。
- **沙箱**：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`。登录用 `BrowserWindow` 同样开启沙箱，且使用独立 partition 隔离主窗口。
- **依赖审计**：CI 跑 `npm audit --production`，高危依赖阻塞合并。

## 11. 视觉风格

> **目标**：玩家打开应用第一眼，要能感觉"这是原神周边工具"。当前旧仓库的实现差距巨大——纯 CSS 渐变 + Noto Serif，离官网体验差三档。

**还原要点**（实施时由 frontend-design skill + 真实 DevTools 抓取计算样式 → 落地到 `src/renderer/design/tokens.ts`）

- **字体**：以官网计算后字体栈为准（多为 HYWenHei 商授字体），开源替代评估顺序：LXGW WenKai TC（标题）、Source Han Serif SC（正文）、Noto Sans SC（数据 / 等宽场景）。**不引入字体不等于"原神风"**——字重、字距、行高同等重要。
- **配色**：抓 `ys.mihoyo.com` / `genshin.hoyoverse.com` 实际渲染的金色（border / underline 用色），通常不是 `#f7b769` 这种偏暖橙的；沉色背景多偏冷蓝灰渐变 + 雾化。具体 token 在实施阶段填入。
- **按钮**：原神 UI 多用斜切（clip-path 平行四边形或 trapezoid）+ 双边描金 + hover 呼吸光。**禁止**圆角矩形 + 实心金色背景这种最廉价的"伪原神"组合。
- **卡片**：四角装饰构件（顶角金箍 / 底角小三角）以 SVG 实现，不要全靠 border。
- **节奏 & 留白**：参考官网 hero 区——大留白、视差背景、入场动画分节奏。
- **图标**：元素图标用线稿单色，不要色块；自绘或采用 CC0 替代（不能直接用游戏内图标）。

**强制约束**
- **禁止**直接使用游戏内立绘、UI 切片、官方字体——版权红线。
- 所有装饰 SVG 必须自绘或采用 CC0 / OFL 资源，并在 `resources/credits.md` 列出来源。

## 12. 数据获取（用户取数指南）

> 写到 `docs/data-acquisition.md`，但要求 onboarding 页内嵌精简版图文。

**米游社账号（推荐：内置浏览器登录）**
1. 应用 Onboarding 页点 "用内置浏览器登录米游社"。
2. 弹出独立窗口加载 `https://www.miyoushe.com/ys/`，正常扫码或账号密码登录。
3. 主进程检测到 `ltoken_v2` / `ltuid_v2` / `ltmid_v2` 三个 cookie 出齐后自动关窗。
4. 应用列出该账号下所有 UID，用户选一个 → 自动拉取 Enka 面板。
5. Cookie 全程不入磁盘、不入渲染端；登录用的 session partition 在关窗时清空 cookie 存储。

**手动粘贴 Cookie（备选）**
1. 浏览器登录 `https://www.miyoushe.com/ys/`。
2. F12 → Application → Cookies → 选中 `miyoushe.com`。
3. 复制 `ltoken_v2`、`ltuid_v2`、`ltmid_v2` 三个 key=value，用 `;` 串起来。
4. 粘贴进应用 → 校验 → 选择 UID。

**Enka UID（推荐先用，无需登录）**
- 直接输入游戏内 9 位数 UID。
- 应用调 `https://enka.network/api/uid/<uid>` 拿展示柜内的角色面板（最多 8 个）。

**LLM API Key**
- Anthropic 直连：从 `console.anthropic.com` 拿 key。
- 兼容代理（魔搭 / 智谱 / OpenRouter）：填对应 base URL 与 key。
- 应用提供"测试连接"按钮，调用 `messages` 接口跑一次 1-token 请求。

## 13. 开发命令

```bash
npm install                       # 安装
npm run dev                       # concurrently: vite (renderer) + tsup watch (main) + electron
npm run typecheck
npm run lint
npm run test                      # vitest 单元
npm run test:e2e                  # playwright 渲染端 E2E
npm run build                     # vite build + tsup
npm run pack                      # electron-builder，产出 dmg（macOS）+ exe（NSIS, Windows）
npm run pack:mac                  # 仅 macOS，CI 优先入口
npm run pack:win                  # 仅 Windows
npm run pack:dir                  # 不出安装器，仅 unpacked 目录用于本地试装
```

## 14. 测试策略

| 层 | 工具 | 范围 |
|---|---|---|
| 主进程单元 | Vitest | services（注入 fetch / fs mock）、IPC handler |
| Shared 类型 | tsc --noEmit | 契约一致性 |
| 渲染端 | Playwright + electron 启动 | onboarding 流程、推荐流程、设置页 |
| 真实外部联通 | `npm run gate:external`（手动） | 米游社 / Enka / Anthropic—CI 不强制跑 |

CI（GitHub Actions）：lint + typecheck + unit + 构建产物（不发布）。Release 走 tag 触发。

## 15. 路线图（v0.1 → v1.0）

- **v0.1 Walking Skeleton**：壳 + IPC 通路 + Settings 页（仅 LLM Key 输入与测试）。
- **v0.2 Profile**：Cookie 校验 + Enka 拉取 + 角色卡。
- **v0.3 Advisor**：claude-agent-sdk 接入，单环境推荐。
- **v0.4 History & Compare**：历史筛选、双环境对比。
- **v0.5 Visual Pass**：frontend-design 主导，落地原神风 token 与组件库。
- **v1.0 Release**：自动更新 + 安装器签名（macOS notarization、Windows 暂不签）+ 多语言（zh / en）。

**目标平台优先级**：macOS > Windows。Linux 暂不出 release（构建脚本保留 AppImage 配置但不进 CI 矩阵）。
