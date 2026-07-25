# 知识库驱动 Advisor Workbench 验证记录

## 结论

- 验证日期：2026-07-25–2026-07-26（Asia/Shanghai）
- 实现提交：
  - `365a5350e33e4e2e928f55c605095bfd4417d49c`（112 角色目录与固定来源）
  - `5c9bf7b1ad8da9b46f608343a97aad13df3e46f9`（exact-112 schema 与 supplemental fail-closed 审查修复）
- 自动门禁结论：通过；2026-07-26 修复后为 123 个文件、1614 项测试。
- 固定公开知识来源结论：通过，目录与策略各 112 个 canonical 角色。
- 真实保存态门禁结论：用户已明确授权。`gate:provider-saved` 与 `gate:agent-saved` 已通过，证明保存配置可访问 Provider 且 SDK 子进程确实运行模型；`gate:advisor-saved` 多次到达真实 WebSearch、Compose、Critique 与 Repair，但在最后一次修复后复验前，Provider 返回原文 `Credit balance is too low`。因此完整 Advisor 四阶段仍未通过。

因此，本实现的离线行为、构建、视觉布局、知识来源边界、保存配置与基础 SDK 模型调用已有可复核证据；`smart-service` 从 Compose 到 Explain 的完整真实成功仍待充值后复跑。

## 自动门禁

初次完整验证窗口为 2026-07-25 20:02–20:06；审查修复最终验证窗口为 20:14–20:18（Asia/Shanghai）。

| 命令                                | 退出码 | 结果                                                                   |
| ----------------------------------- | -----: | ---------------------------------------------------------------------- |
| `npm run lint`                      |      0 | ESLint 零 warning                                                      |
| `npm run typecheck`                 |      0 | renderer、main/shared、renderer tests 三组 TypeScript 检查通过         |
| `npm run test`                      |      0 | 120 个文件、1592 项测试通过                                            |
| `npm run test:golden`               |      0 | 6 个文件、80 项约束/历史/离线 golden 测试通过                          |
| `npm run build`                     |      0 | Vite renderer 与 tsup main/preload 构建通过                            |
| `npm run test:renderer-budget`      |      0 | `rendererMiB=12.26`、`javascriptKiB=502`、`cssKiB=93`、25 个文件       |
| `npm run test:e2e:visual`           |      0 | 13/13 Electron E2E 通过，用时约 2.6 分钟                               |
| `npm run gate:knowledge-provenance` |      0 | 公开固定提交在线复核通过：112 个目录项、5 个排除项、元素与武器类型一致 |

2026-07-26 针对真实模型暴露的问题完成修复后，重新运行：

- `npm run lint`：退出 0；
- `npm run typecheck`：退出 0；
- `npm run test`：123/123 文件、1614/1614 测试通过；
- `npm run test:golden`：6/6 文件、80/80 测试通过；
- `npm run build`：退出 0；
- `npm run test:renderer-budget`：`rendererMiB=12.26`、`javascriptKiB=502`、`cssKiB=93`、25 个文件；
- `npm run gate:knowledge-provenance`：退出 0，公开固定来源摘要与 112 角色目录复核结果不变。

完整单测第一次运行发现一个仍写死为 104 的 unreviewed 数量断言；目录补齐后正确值为 107。更新该机械断言后重新运行完整测试，结果为 120/120 文件、1587/1587 测试通过。

质量审查修复又新增 5 项回归测试，最终结果为 120/120 文件、1592/1592 测试通过。第一次把完整测试与 lint/typecheck 并行运行时，一个既有同步性能测试在竞争 CPU 的情况下记录 536.6 ms，超过 500 ms 阈值；未修改阈值或优化器代码，随后独立运行两次完整测试均通过。

`gate:knowledge-provenance` 在网络沙箱内的第一次尝试因 DNS 被禁而退出 1；获准只访问公开的固定 Git 原始文件后重新运行并退出 0。这不是产品逻辑失败。成功输出复核了：

- Enka characters SHA-256：`51dbaef256968a41dab3429d60f88f77f29645c4b79bf606fc93d4fbf3be33e4`
- Enka localization SHA-256：`ee8a58105be0595b386d035377711d7aa0859d09550241b291459372bbd38976`
- genshin-db-dist supplement SHA-256：`da5d96d246972062380a7c24b095e404c091e64a8958b2c3869abfba03fb9299`
- supplemental allowlist：`supplementalCount=3`，`supplementalIds=10000125,10000126,10000127`

provenance verifier 对 supplemental 使用固定三项 allowlist。任何其他不在 Enka 快照中的 committed ID 都会失败；三个 required ID 任一缺失、结构或名称异常、元素/武器值未知、或 required ID 重复都会 fail closed。catalog 与 strategy committed schema 都锁定为恰好 112 项，不接受 111 或 113 项快照。

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
- trace store 的“只保留最近一次”与敏感值脱敏既有内存单元测试覆盖，也在真实 Advisor 门禁的多次运行中观察到最新运行替换；真实搜索均返回空 `results`，没有可声称已验证的 accepted research cache 写入样本。

## 真实保存态门禁

| 门禁                          | 状态             | 说明                                                                                                                                                       |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run gate:provider-saved` | 通过             | 保存配置请求返回 HTTP 200，延迟约 1899 ms                                                                                                                  |
| `npm run gate:agent-saved`    | 通过             | 模型 `claude-sonnet-5`；模型原文 `agent gate ok`；usage 为 input 184 / output 8；延迟 4953 ms                                                               |
| `npm run gate:advisor-saved`  | 已运行，尚未通过 | 已真实执行 WebSearch、Compose、Critique 与 Repair 并保留脱敏原文/usage；最终修复后复验被 Provider 余额阻断，原文 `Credit balance is too low`，尚无 Rotation/Explain 成功证据 |

真实 Advisor 运行暴露并驱动修复的问题包括：

1. 官方 Anthropic 端点此前错误使用 Bearer token；现仅官方端点注入 `ANTHROPIC_API_KEY`，兼容端点继续使用 `ANTHROPIC_AUTH_TOKEN`。
2. 141 个检索缺口令 prompt 超过隐私预算；现按锁定角色与本地基线优先级最多检索 3 项，其余保持 unknown，且不自动写入知识库。
3. 当前 Provider 的 SDK `outputFormat` 不可用；最小 schema 真实请求返回 `AGENT_TURN_RESULT_ERROR`，因此生产链路仍用严格 JSON + Zod，并对单一 JSON fence 和字符串内部明显未转义的中文引号做受限解析。
4. Critique 曾生成契约外 `target`，现提示词枚举每一种允许形状；真实输出随后正确使用 `abyss-team` / `abyss-chamber`。
5. 空搜索结果曾被误报为损坏输出；现成功执行 allowlisted WebSearch 且模型返回空 `results` 时记为 `SEARCH_NO_VALID_RESULTS`，不写缓存、不阻断 Composer。
6. Abyss 文本修复可复用同一次运行内首轮已审计的只读工具证据；若修复轮换角色或重新调用工具，仍按新证据完整校验。Stygian/Theater 保持逐轮独立审计。
7. 确定性硬校验通过后，Critique 的软风险最多触发一次修复；第二次 Critique 仍有软风险时保留原文和 issue，继续 Rotation/Explain，不再因为无法消除的 unknown 反复扩张 prompt。

充值后应重新按 Provider → Agent → Advisor 顺序运行。只有 `gate:advisor-saved` 同时证明 Compose、Critique、Rotation、Explain 均 completed、均有正 usage 与非空脱敏原文，才能关闭真实链路 blocker。
