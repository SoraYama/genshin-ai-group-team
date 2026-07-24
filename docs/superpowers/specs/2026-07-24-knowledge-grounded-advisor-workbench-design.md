# 知识库驱动的 AI 配队与单视口工作台设计

## 状态

- 日期：2026-07-24
- 范围：深境螺旋配队链路、角色页与可观测性
- 已确认决策：
  - 深境螺旋先完成完整样板；幻想真境剧诗与幽境危战只保留可迁移接口。
  - 可信本地知识库是攻略上下文主链路，Web Search 只在知识缺失、过期或冲突时兜底。
  - Web Search 结果不会自动写入可信知识库，只进入本次运行与 24 小时临时缓存。
  - 默认按当前武器与圣遗物判断角色流派；换装只能作为可选调整，不得偷偷假设已经完成。
  - UI 只保留最近一次模型运行记录，不把模型原文写入推荐历史。
  - 配队页采用“上部左侧限制 / 右侧场景 / 下部结果”的单视口工作台。
  - 角色页采用全宽头像矩阵，点击后打开右侧详情抽屉。

## 问题与已确认现状

### 推荐质量的根因

当前推荐链路虽然存在五阶段 Agent 管线，但模型拿到的专业上下文不足：

- `resources/knowledge/characters.v1.json` 只有 8 个角色。
- 角色知识只有武器类型、宽泛职责、能量与少量能力标签，没有角色流派、装备匹配、队友槽位、反应归属或环境适配。
- `AdvisorProfileSerializer` 会传入武器、圣遗物套装与主词条摘要，但没有一层确定性逻辑把这些信息解释为“当前 build 属于什么用途”。
- Composer 只能查询上述有限本地知识；`WebSearch` 与 `WebFetch` 在 SDK 边界中被明确禁用。
- 本地优化器总是先生成一个可行基线，模型失败后服务直接返回该基线，因此用户容易看到一个完整方案，却不知道模型是否真正参与。

攻略研究表明，同一角色的实际职责会因装备、反应归属与站场方式发生根本变化：

- 雷电将军的绝缘充能输出与全精通超绽放触发是两套不同职责。
- 久岐忍可作为超绽放触发、激化辅助或纯治疗，武器和主词条优先级不同。
- 纳西妲的站场驾驶与后台挂草会改变充能、精通和双暴权重。
- 心海在海染站场、千岩辅助与妮露绽放中的反应归属和装备目标不同。
- 芙宁娜的队伍必须结合治疗覆盖、生命变化与充能环境判断，而不是只按水元素后台位处理。

研究来源：

- [Raiden Shogun Quick Guide](https://keqingmains.com/q/raiden-quickguide/)
- [Kuki Shinobu Quick Guide](https://keqingmains.com/q/shinobu-quickguide/)
- [Nahida Quick Guide](https://keqingmains.com/q/nahida-quickguide/)
- [Kokomi Quick Guide](https://keqingmains.com/q/kokomi-quickguide/)
- [Furina Quick Guide](https://keqingmains.com/q/furina-quickguide/)

### 开发环境的真实模型状态

2026-07-24 的检查结果：

- 保存的 Provider 配置存在 API Key，当前 Base URL 为 Anthropic，模型为 `claude-sonnet-5`。
- 项目自带的 `gate:provider-saved` 发起真实 1-token 请求并成功返回 HTTP 200，耗时约 2290 ms。
- 同一天最近三条深渊历史记录全部为 `source: local-rules`。
- 最新方案包含“智能服务未能给出通过检查的方案，已改用更保守的本地规则”。
- 当月 usage 仍为输入 0、输出 0。
- SDK runtime 目录证明子进程曾启动，但现有服务会吞掉具体异常，也不会保存任何阶段原文。

因此准确结论是：Provider 可达，但当前深渊 Agent 管线没有成功完成。现有 UI 无法显示失败阶段或模型原文。

### UI 根因

- 配队入口先展示三张官网式大图，再把敌情、角色干预、生成按钮和结果纵向堆叠；核心操作需要向下滚动。
- 深渊工作台组件超过一千行，把场景、角色选择、执行状态与结果展示全部塞在同一个长页面中。
- 角色页把完整面板直接铺在每张大卡中，角色池与详情无法快速切换，整体更像攻略页而不是桌面工具。

## 目标

1. 让模型在配队前获得当前 build、可信角色配队知识和怪物机制配队知识。
2. 让知识覆盖与来源可审计；未知内容保持未知。
3. 让 Web Search 只补知识库缺口，且永不自动污染可信知识。
4. 让用户直接看到本次是否使用模型、知识库、搜索或本地规则，并能查看模型原文。
5. 让深渊配队与角色检查在常见桌面视口内完成，不依赖整页长滚动。
6. 保持 Renderer 无凭据、无外部网络；所有 IO 继续通过 Main。

## 非目标

- 本轮不重构幻想真境剧诗与幽境危战的完整 UI 和 Agent 管线。
- 不实现伤害模拟器、圣遗物全库存优化或 gcsim 等价计算。
- 不自动抓取并复制第三方攻略全文。
- 不让 Web Search 结果自动进入正式知识库。
- 不让模型越过本地硬约束或把未知机制当成已知事实。

## 总体架构

```text
ProfileSnapshot + ScenarioSnapshot
              │
              ▼
       BuildInterpreter
              │ build archetypes + evidence
              ▼
   GenshinKnowledgeBase (trusted)
      ├─ CharacterStrategyKnowledge
      └─ EnemyMechanicStrategyKnowledge
              │
              ▼
         CoverageGate
          │        │
   sufficient    missing/stale/conflicting
          │        ▼
          │   ResearchAgent + WebSearch
          │        │
          │        ▼
          │   EphemeralGuidePacket
          └────────┬───────────────
                   ▼
         KnowledgeContextPacket
                   │
                   ▼
 Composer → Critique → Rotation → Explain
                   │
                   ├─ validated smart-service result
                   └─ explicit local-rules fallback

Every stage ──▶ AgentRunTraceStore (latest run only)
```

## 可信知识库

### 文件边界

新知识拆成三个版本化文件，避免继续扩大单个种子文件：

```text
resources/knowledge/
├── sources.v1.json
├── character-strategies.v2.json
└── enemy-mechanic-strategies.v1.json
```

- `sources.v1.json` 维护来源 ID、标题、URL、发布方、页面版本提示和复核时间。
- `character-strategies.v2.json` 维护角色流派与配队知识。
- `enemy-mechanic-strategies.v1.json` 维护机制到队伍策略的映射。
- 每个 bundle 都包含 schemaVersion、knowledgeVersion、gameVersion、updatedAt 与 coverage。
- 所有文件由 Zod strict schema 加载；未知字段和无效引用阻止应用启动该知识版本。

### 全角色覆盖

构建时维护一份受支持角色目录。知识覆盖测试要求目录中的每个角色至少拥有：

- 基础职责；
- 至少一个保守流派；
- 适用环境；
- 队友槽位；
- 明确的 unknown 字段。

多流派角色必须有多个 archetype，并提供可审计的 build 匹配信号。新角色若只出现在 Profile、尚未进入受支持目录或知识库，则返回 unknown 并触发搜索兜底，不能由模型自动晋升为可信事实。

### 角色配队知识

`CharacterStrategyKnowledge` 的概念字段：

```ts
interface CharacterStrategyKnowledge {
  characterId: string;
  name: string;
  archetypes: Array<{
    id: string;
    label: string;
    buildSignals: BuildSignal[];
    roles: CharacterRole[];
    fieldTime: 'on-field' | 'off-field' | 'quickswap' | 'flex';
    reactionOwnership: string[];
    suitableEnvironments: string[];
    teamSlots: TeamSlotRequirement[];
    synergies: KnowledgeRelation[];
    conflicts: KnowledgeRelation[];
    energyNotes: string[];
    sustainNotes: string[];
    rotationNotes: string[];
    sourceIds: string[];
    unknownFields: string[];
  }>;
}
```

`BuildSignal` 是确定性匹配信号，可表达：

- 武器名称、武器副属性或武器能力标签；
- 圣遗物套装与件数；
- 沙、杯、头主词条；
- 元素精通、充能、生命、防御、双暴等面板范围；
- 命座范围；
- `required` 与权重。

BuildInterpreter 输出匹配 archetype、分数、置信度和逐条 evidence。未达到最低证据阈值时返回 `unknown`，不得按角色名字猜流派。

### 怪物机制配队知识

`EnemyMechanicStrategyKnowledge` 的概念字段：

```ts
interface EnemyMechanicStrategyKnowledge {
  id: string;
  mechanicTags: string[];
  match: EnemyMechanicMatcher;
  requiredCapabilities: string[];
  preferredCapabilities: string[];
  suppressedArchetypes: string[];
  preferredTeamPatterns: TeamPattern[];
  halfAllocationNotes: string[];
  risks: string[];
  sourceIds: string[];
  unknownFields: string[];
}
```

它不硬编码“唯一最佳队伍”，而是描述：

- 哪些能力是硬要求；
- 哪些队伍骨架更适合；
- 哪些流派会被抗性、免疫、护盾、移动或多波次压制；
- 上下半分配时需要避免什么冲突。

## 知识检索与搜索兜底

### KnowledgeContextPacket

每次推荐生成一个有界、结构化的上下文包：

```ts
interface KnowledgeContextPacket {
  knowledgeVersion: string;
  buildInterpretations: BuildInterpretation[];
  trustedMatches: TrustedKnowledgeMatch[];
  ephemeralMatches: EphemeralGuideMatch[];
  unknowns: KnowledgeGap[];
  coverage: {
    requested: number;
    trusted: number;
    ephemeral: number;
    unknown: number;
  };
  citations: Citation[];
}
```

Composer、Critique、Rotation 与 Explain 读取同一 packet，避免各阶段对角色职责产生不同假设。

### CoverageGate

只有以下情况触发 ResearchAgent：

- 候选角色没有可信策略条目；
- 当前 build 无法匹配任何可信 archetype；
- 目标怪物机制没有策略条目；
- 条目超过复核有效期；
- 两条可信来源产生显式冲突。

CoverageGate 生成不含 UID、昵称或完整面板的匿名研究任务，只携带角色名、流派信号、装备类别、敌人机制与场景标签。

### Web Search

ResearchAgent 是唯一允许使用 SDK `WebSearch` 的阶段：

- `WebFetch`、文件、Shell、Agent/Task 等原生工具继续禁用。
- 搜索工具调用通过 PreToolUse 计数器硬限制为最多三次，超限返回 `SEARCH_BUDGET_EXCEEDED`。
- 首批接受来源域名固定为 `keqingmains.com`、`kqm.gg`、`library.keqingmains.com`、`hoyolab.com` 和 `genshin.hoyoverse.com`；调整列表必须修改版本化来源清单并经过测试。
- 返回 JSON 必须包含结论、适用范围、来源 URL、页面时间线索与冲突。
- 返回后再次校验 URL host、长度、结论数量和 schema；不在接受列表的来源直接丢弃，不进入 EphemeralGuidePacket。
- Provider 或兼容端点不支持 WebSearch 时返回 `SEARCH_UNAVAILABLE`，不切换到第二套搜索 Provider。

Anthropic 官方 Agent SDK 示例允许通过 `allowedTools: ['WebSearch']` 建立无状态研究 Agent；Web Search 也会返回带引用的实时结果。参考：

- [Claude Agent SDK research agent cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-00-the-one-liner-research-agent)
- [Claude Web Search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

### 临时缓存

- Key 由规范化后的匿名研究任务和知识版本哈希组成。
- TTL 为 24 小时。
- 缓存位于 `userData/cache/guide-research.json`。
- 缓存条目显式标记 `trust: ephemeral-web`。
- 缓存不会被合并进 `resources/knowledge`，也不会改变可信 coverage。
- 清理场景缓存时一并清理；历史记录只保存来源摘要，不保存搜索原文。

## Agent 管线

### 前置步骤

1. 读取 Profile 与 Scenario。
2. 本地优化器证明当前锁定、排除和双队约束至少存在可行解。
3. BuildInterpreter 解释候选角色的当前装备。
4. KnowledgeService 检索角色与怪物机制知识。
5. CoverageGate 必要时调用 ResearchAgent。
6. 生成 KnowledgeContextPacket。

### Composer

Composer 必须：

- 调用 `read_profile_cache` 读取最终候选角色详情；
- 调用 `query_enemy_data` 读取每个目标房间；
- 调用新的 `query_team_knowledge` 读取与 packet 一致的知识；
- 只选择 owned、eligible 且未排除的角色；
- 明确每个角色的 archetype 与队内职责；
- 区分“当前装备直接可用”和“需要可选换装”；
- 为依赖攻略的结论附 citation ID。

### Critique

Critique 增加以下检查：

- 角色职责与当前 build 是否冲突；
- 两名角色是否争夺同一反应触发权；
- 站场时间是否冲突；
- 充能闭环是否只有文字声称而无事实支持；
- 治疗、护盾与抗打断是否满足场景压力；
- 怪物抗性、免疫、护盾、多波次与移动机制是否覆盖；
- 结论是否缺少可信知识或临时来源。

### Rotation 与 Explain

- Rotation 只能引用 Profile、Scenario、可信知识或已验证临时来源中的事实。
- Explain 明确分区：
  - 为什么这队适合该半场；
  - 当前 build 如何被使用；
  - 风险和未知；
  - 可选换装建议；
  - 来源。
- 换装建议不得改变推荐成立的前提；若必须换装，方案必须标记为 `requires-adjustment`，不能显示为可直接使用。

## 模型运行记录与真实状态

### AgentRunTrace

每次生成创建一个只存在 Main 内存的 trace：

```ts
interface AgentRunTrace {
  correlationId: string;
  startedAt: string;
  finishedAt?: string;
  finalSource?: 'smart-service' | 'local-rules' | 'blocked';
  model: string;
  stages: AgentStageTrace[];
  knowledge: KnowledgeTraceSummary;
  usage: AgentUsage;
  failure?: AgentFailure;
}
```

每个阶段记录：

- started / completed / failed / skipped；
- 输入摘要；
- 模型原文；
- 工具调用与成功状态；
- 知识命中与 citation ID；
- 搜索查询和接受的 URL；
- usage、耗时与修复轮次；
- 错误代码与脱敏消息。

### 生命周期与安全

- 只保留最近一次 trace；新推荐开始时替换。
- 不写入 HistoryStore。
- Renderer 只在用户打开“模型运行记录”抽屉时通过 IPC 读取。
- Cookie、API Key、Authorization、自定义 Header 值和上游原始错误 body 永不进入 trace。
- UID 在展示给本机用户时允许存在于请求摘要，但绝不进入搜索 query。
- trace 原文设定总字节上限；超限时按阶段截断并明确标记。

### 真实 SDK 门禁

保留现有 `gate:provider-saved`，并新增：

- `gate:agent-saved`：用已保存 Key 运行一个无工具 SDK query，要求拿到可验证原文与 usage。
- `gate:advisor-saved`：用本地 Profile、正式 Scenario 与知识库运行一次真实深渊推荐，要求最终 source 为 smart-service，并输出各阶段状态摘要。

外部门禁手动运行，不在 CI 消耗玩家 Key。

## 错误与降级语义

| 失败点 | 行为 | UI |
| --- | --- | --- |
| 可信知识完整 | 不联网 | 显示“本地知识已覆盖” |
| 知识缺失/过期/冲突 | 调用 ResearchAgent | 显示“正在补充攻略上下文” |
| WebSearch 不支持或失败 | 继续可信知识 | 显示覆盖缺口与低置信度 |
| Composer 输出非法 | 最多两轮定向修复 | Trace 显示 repair-1 / repair-2 |
| Critique 要求修复 | 回到 Composer，受总修复预算限制 | 显示具体 issue |
| Rotation/Explain 非法 | 失败并降级，不伪造文本 | 显示失败阶段 |
| SDK/Provider 异常 | 返回本地规则基线 | 结果来源醒目标记“本地规则” |
| 本地规则也不可行 | blocked | 显示未满足硬约束，不拼凑队伍 |

所有 catch 必须映射成稳定错误代码并写入 trace。服务不得再用空 catch 吞掉 Agent 失败原因。

## 配队工作台

### 视口结构

桌面端主工作区采用两行结构：

```text
┌────────────────────────────────────────────────────────────┐
│ 左：队伍限制与角色偏好      │ 右：楼层、房间与敌人机制       │
├────────────────────────────────────────────────────────────┤
│ 下：固定双队结果、依据、风险、来源与运行记录入口             │
└────────────────────────────────────────────────────────────┘
```

- 页面本身不承担核心内容长滚动。
- 上半区与结果区使用 `minmax(0, 1fr)` 和内部滚动。
- 左侧显示偏好、锁定/排除与紧凑头像选择器。
- 右侧显示楼层/房间选择、上下半敌情和知识覆盖状态。
- 生成按钮固定在场景区底部；生成后结果只更新下半区。
- 修改条件后保留旧结果并标记待更新，不立即清空。
- 结果区首屏显示：
  - smart-service / local-rules / blocked；
  - 可信知识覆盖；
  - 是否使用 Web Search；
  - 两队头像与职责；
  - 当前 build 适配摘要；
  - 风险、来源和运行记录入口。

### 状态

- idle：可编辑限制和场景。
- preparing-context：解释 build 与读取知识。
- searching-guides：仅 CoverageGate 触发时出现。
- composing / critiquing / rotating / explaining：显示真实阶段。
- completed-smart：模型方案通过。
- completed-local：明确本地降级。
- blocked：硬约束无解。
- cancelled：保留上一次有效结果。

不再使用与实际模型阶段无关的固定假进度。

## 角色页

### 头像矩阵

- 顶部保留账号切换、同步状态、搜索与元素/完整度过滤。
- 主区使用紧凑头像矩阵。
- 每项只显示头像、名字、等级、元素和圣遗物套装缩写。
- 列表区域内部滚动；页面壳保持一个工作视口。

### 详情抽屉

点击角色后从右侧打开临时抽屉，优先级为：

1. 当前 build 识别与置信度；
2. 武器、精炼、圣遗物套装与三件主词条；
3. 关键面板与天赋；
4. 适用环境、队友槽位和冲突；
5. 数据来源、缺失字段与更新时间。

抽屉关闭后恢复完整角色矩阵。键盘焦点返回触发角色；Escape 可关闭。

## 测试与验收

### 单元测试

- strict schema 拒绝缺少来源、版本、角色 ID 或机制标签的知识。
- 受支持角色目录与知识库 coverage 一致。
- BuildInterpreter 覆盖雷电将军、久岐忍、纳西妲、心海和芙宁娜等多流派样例。
- 怪物机制正确映射破盾、抗性、多波次、聚怪价值、单体与生存压力。
- CoverageGate 在知识充分时不搜索，在缺失、过期或冲突时搜索。
- Web 结果不会写入可信知识文件或可信 coverage。
- AgentRunTrace 脱敏敏感字段并执行字节上限。
- SDK、搜索、工具、schema 与 validator 失败使用不同错误代码。

### 管线测试

- Composer 必须读取最终选中角色 build、知识与每个目标房间。
- 依赖攻略的结论必须带 citation ID。
- Build 与职责冲突会被 Critique 拒绝。
- 两轮修复预算后仍非法则明确降级。
- 模型成功时 source 为 smart-service、usage 大于 0 且存在阶段原文。
- 模型失败时 source 为 local-rules 且存在失败阶段和原因。

### UI 与 E2E

- `1440×900` 和 `1280×800` 下，深渊核心工作台不产生整页长滚动。
- 左限制、右场景、下结果同时存在于工作视口。
- 角色页使用全宽头像矩阵，点击打开右侧抽屉。
- 进度与真实 Agent 阶段一致。
- 结果来源、知识覆盖、搜索兜底和本地降级在首屏可见。
- 模型运行记录显示原文、工具、引用、token、耗时与错误。
- 键盘、焦点、Escape 与可访问名称通过 E2E。

### 门禁

必须通过：

```text
npm run lint
npm run typecheck
npm run test
npm run test:golden
npm run build
npm run test:e2e:visual
```

真实 Provider / Agent / Advisor 门禁单独记录结果。

## 完成标准

1. 当前 Provider 可达但 Agent 静默降级的问题显示明确根因。
2. 最近一次模型原文可从结果区查看。
3. 可信知识不再只有 8 个角色；受支持角色目录拥有完整索引。
4. 多流派角色依据现有装备选择职责。
5. 怪物机制能够影响队伍骨架与上下半分配。
6. Web Search 只在知识缺口时运行，且不会污染可信知识库。
7. 智能服务、本地规则和 blocked 三种来源不会混淆。
8. 配队页与角色页在目标桌面视口内完成核心操作。
9. 自动门禁和手动真实 Agent 门禁全部给出可审计证据。

## 后续迁移

深境螺旋完成后，幻想真境剧诗与幽境危战复用：

- BuildInterpreter；
- GenshinKnowledgeBase；
- CoverageGate 与 ResearchAgent；
- AgentRunTraceStore；
- 结果来源与运行记录 UI。

各玩法只实现自己的 Scenario matcher、mechanic knowledge query、validator 与工作区布局，不复制知识与可观测性基础设施。
