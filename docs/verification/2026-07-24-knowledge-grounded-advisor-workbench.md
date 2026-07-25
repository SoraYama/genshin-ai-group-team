# 知识库驱动 Advisor Workbench 验证记录

## 结论

- 验证日期：2026-07-25（Asia/Shanghai）
- 实现提交：`365a5350e33e4e2e928f55c605095bfd4417d49c`
- 自动门禁结论：通过。
- 固定公开知识来源结论：通过，目录与策略各 112 个 canonical 角色。
- 真实保存态门禁结论：未执行。`gate:provider-saved`、`gate:agent-saved`、`gate:advisor-saved` 会读取玩家已保存的凭据、访问已配置的第三方 Provider，并产生真实模型用量；当前正在等待用户对此给出明确授权。不得把本记录解释为真实 Agent 或完整 Advisor 管线已经通过。

因此，本实现的离线行为、构建、视觉布局和知识来源边界已有可复核证据；`smart-service` 真实端到端成功仍是本任务唯一未闭合项。

## 自动门禁

最终验证窗口为 2026-07-25 20:02–20:06（Asia/Shanghai）。

| 命令                                | 退出码 | 结果                                                                   |
| ----------------------------------- | -----: | ---------------------------------------------------------------------- |
| `npm run lint`                      |      0 | ESLint 零 warning                                                      |
| `npm run typecheck`                 |      0 | renderer、main/shared、renderer tests 三组 TypeScript 检查通过         |
| `npm run test`                      |      0 | 120 个文件、1587 项测试通过                                            |
| `npm run test:golden`               |      0 | 6 个文件、80 项约束/历史/离线 golden 测试通过                          |
| `npm run build`                     |      0 | Vite renderer 与 tsup main/preload 构建通过                            |
| `npm run test:renderer-budget`      |      0 | `rendererMiB=12.26`、`javascriptKiB=502`、`cssKiB=93`、25 个文件       |
| `npm run test:e2e:visual`           |      0 | 13/13 Electron E2E 通过，用时约 2.6 分钟                               |
| `npm run gate:knowledge-provenance` |      0 | 公开固定提交在线复核通过：112 个目录项、5 个排除项、元素与武器类型一致 |

完整单测第一次运行发现一个仍写死为 104 的 unreviewed 数量断言；目录补齐后正确值为 107。更新该机械断言后重新运行完整测试，结果为 120/120 文件、1587/1587 测试通过。

`gate:knowledge-provenance` 在网络沙箱内的第一次尝试因 DNS 被禁而退出 1；获准只访问公开的固定 Git 原始文件后重新运行并退出 0。这不是产品逻辑失败。成功输出复核了：

- Enka characters SHA-256：`51dbaef256968a41dab3429d60f88f77f29645c4b79bf606fc93d4fbf3be33e4`
- Enka localization SHA-256：`ee8a58105be0595b386d035377711d7aa0859d09550241b291459372bbd38976`
- genshin-db-dist supplement SHA-256：`da5d96d246972062380a7c24b095e404c091e64a8958b2c3869abfba03fb9299`

## 目录与 coverage

- `character-catalog.v1.json`：112 个 canonical 角色，5 个有审计原因的上游排除项。
- `character-strategies.v2.json`：112 个角色，与目录 ID 一一对应。
- 已审阅角色：5 个。
- `unreviewed` 明确缺口：107 个。
- 新补 canonical 角色：
  - `10000125` 哥伦比娅，水元素、法器；
  - `10000126` 兹白，岩元素、单手剑；
  - `10000127` 叶洛亚，岩元素、长柄武器。
- 上述三名角色都只加入 `unreviewed` / `gap` 保守占位，`facts` 为空；本次没有把未审阅的流派、队友或配装信息伪装成可信事实。
- 旧 Enka `10000904` 被审计为指向 `10000125` 的 alternate/provisional 旧 ID，不作为独立火元素角色使用。

提交后再次运行公开 provenance gate，`resources/knowledge/` 工作区保持 clean。运行前后摘要一致：

| 文件                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `character-catalog.v1.json`         | `918ea30bc7e990e432d52c911449004f634102aeac163d840cf6553788c1a7ab` |
| `character-strategies.v2.json`      | `111a327063b734e9835721d7d02aafe621bf28a04e7b175e1d2696ea38863b23` |
| `characters.v1.json`                | `57a8c402475ea6018e9cdebb0f0a634b4845d0691d459a0cd6617d4d278fc111` |
| `enemy-mechanic-strategies.v1.json` | `46cd8ce533eea401ad35c90e63568fb23b4aa439c80603ce32f9e10a15ba1c5e` |
| `review-evidence.v1.json`           | `6e1ae244a39bffab62518defb28392598578d9f43e712302c583d175cbcb606b` |
| `sources.v1.json`                   | `db83172e24c886a50a631799b5dceea797af4c3b081c299ca2fd4597b4d7e0d4` |

## 视觉证据

最终视觉 E2E 生成的目标视口截图：

- `test-results/visual-matrix/abyss-input-and-result-1440x900.png` — SHA-256 `d4103b4372c434125150e7dc5ace23968eb0e61e3edd260296193d37aa65e15b`
- `test-results/visual-matrix/abyss-input-and-result-1280x800.png` — SHA-256 `319b9118f458cf32578cec7b7309e84f3335bfdedc449d7d86ef72c94350da85`

两种视口均通过自动断言：约束、场景与结果位于核心工作区，且没有被整页横向溢出隐藏。`test-results/` 是本地忽略产物，不随提交发布。

## 隐私与持久化边界

最终完整单测覆盖了 research query 脱敏、trace 文本/工具审计、HistoryStore、guide cache、Advisor 业务工具与 validator。另一次聚焦运行覆盖 9 个相关文件、249 项测试并通过。

对本机现有 `userData` 的只读结构检查（未输出任何 secret 值）得到：

- `history.json` 中有 3 条既有深渊方案；
- 未发现 `rawOutput`、`rawMessagesSummary`、`webSearchEvidence`、`tools`、`stages`、`transcript`、`correlationId` 或 `model` 等 Agent 原文字段；
- `cache/guide-research.json` 当时不存在，因此没有可声称已用真实搜索结果验证的落盘样本；
- trace store 的“只保留最近一次”与敏感值脱敏由内存单元测试验证；由于真实 Advisor 门禁尚未获准，不能声称本次已用真实模型运行复核 trace 替换。

## 真实保存态门禁

| 门禁                          | 状态         | 说明                                                                                           |
| ----------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `npm run gate:provider-saved` | 等待明确授权 | 工具审批在进程执行前拒绝了使用已保存凭据访问已配置第三方端点；没有新的成功或失败 Provider 证据 |
| `npm run gate:agent-saved`    | 等待明确授权 | 未启动，不得推断 SDK 子进程成功                                                                |
| `npm run gate:advisor-saved`  | 等待明确授权 | 未启动，不得推断 `smart-service`、四阶段原文/usage 或真实 trace/cache 边界成功                 |

获得用户明确授权后，必须按 Provider → Agent → Advisor 顺序执行并只记录脱敏 JSON 摘要。只有三层全部通过，才能把设计状态提升为“Implemented and verified”并关闭真实链路 blocker。
