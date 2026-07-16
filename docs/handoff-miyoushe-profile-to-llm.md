# Handoff: 米游社完整角色池到 LLM 的数据链路

> 更新时间：2026-07-15
>
> 仓库基线：`master` / `bde84fa`（Enhance Miyoushe login and session management）
>
> 优先级：P0，阻塞产品核心价值
>
> 建议新 session 首要目标：先用真实登录态验证 `character/list -> character/detail`，再打通 acquisition、profile、serializer、prompt 四层。

## 1. 一页结论

用户的判断是正确的：当前应用即使米游社登录成功，也无法向 LLM 提供足够完整的角色信息。

但根因不是“米游社登录后官方只能返回残缺信息”，而是当前实现停在 `/index`：

1. 米游社登录链路可以取得 Cookie 和绑定 UID。
2. 所谓 `fetchCharacterDetails` 实际只 GET `/index`，没有请求 `character/list` 或 `character/detail`。
3. BrowserBridge 的隐藏/可见验证降级也只观察 `/index`，所以验证码通过后仍拿不到详情。
4. Enka 只能覆盖游戏内展示柜角色，且当前 Enka parser 只保留 `fightPropMap`，丢弃武器、圣遗物和技能。
5. Profile merger 把未知面板填成 `0`，将“缺失”错误表达成“真实数值为 0”。
6. `AdvisorAgent.buildUserMessage` 最后只发送 `id/name/element/rarity/stats`；即使上游补齐武器、命座、天赋、圣遗物，LLM 仍然看不到。

因此完整修复必须覆盖四个边界：

```text
米游社/Enka acquisition
        -> Profile domain + merge/provenance
        -> LLM compact serializer
        -> Advisor prompt / fallback / UI completeness
```

不要只修某一层后宣布完成。

## 2. 本轮已确认与尚未确认

### 2.1 已由本地代码确认

- 当前所有米游社角色路径最终都只消费 `/index`。
- `MiyousheCharacterDetail` 类型声明了 weapon/artifacts/talents，但 `/index` mapper 固定返回 `artifacts: []`，talents 不赋值。
- BrowserBridge 只监听 `/game_record/app/genshin/api/index`。
- Enka 原始 schema 在当前项目里只声明了 `propMap` 和 `fightPropMap`。
- 非 Enka 展示角色的 HP/ATK/DEF/CR/CD/ER/EM 被 merger 填成 0。
- LLM 输入不包含 level 以外的 build 信息；level 仅间接存在于 `stats`。
- 现有测试明确接受 artifacts 为空、talents 缺失和 stats 为 0。

### 2.2 已由当前外部实现强力佐证

截至 2026-07，活跃维护的 `genshin.py` 仍然使用：

```text
POST character/list
  -> 取得全部 owned character IDs
POST character/detail { character_ids: [...] }
  -> 取得武器、圣遗物、技能、命座和面板属性
```

独立的 Battle Chronicle 导出脚本在官方页面登录态内也使用相同两段 POST，并将装备与天赋导出为 GOOD 格式。

这说明“官方详情链路仍存在”具有很高可信度；当前仓库里“必须有匹配 device_id/device_fp，否则 detail 始终 5003”的注释没有本地实现、raw probe 或 gate test 支撑。

### 2.3 仍需用户本机真实登录态确认

以下事项不能只靠开源实现最终确认：

- 当前国服账号、当前 IP、当前 Electron partition 的 Cookie 是否能直接通过 `character/list/detail`。
- Cookie 是否只需要当前提取的 `ltoken_v2/ltuid_v2/ltmid_v2`，或需要保留官方 partition 中的更多 Cookie。
- 当前风险控制是否对部分账号/IP要求可见 Geetest、官方页面预热或设备指纹。
- detail 接口一次提交所有 ID 是否稳定，还是应该分批。

因此实现顺序必须是“脱敏 probe -> 固化 sanitized fixture -> 产品接入”，不要先凭推测重写完整流程。

## 3. 当前代码链路

### 3.1 登录与 Cookie

相关文件：

- `src/main/services/miyoushe-login-window.ts`
- `src/main/services/miyoushe-client.ts`
- `src/main/services/login-session-store.ts`
- `src/main/ipc/profile.ipc.ts`

当前 BrowserWindow 在发现 `ltoken_v2`、`ltuid_v2`、`ltmid_v2` 后认为登录完成。Cookie 保存在独立的持久化 Chromium partition；渲染进程只拿 sessionId 或 boolean，不拿 Cookie 字面值。这个安全边界应保留。

### 3.2 米游社 roster fetch

文件：`src/main/services/miyoushe-game-record.ts`

现状：

- 只有 `/index`、`spiralAbyss`、`role_combat` 常量。
- 没有 `character/list` 和 `character/detail` 常量。
- `fetchCharacterDetails()` 名称具有误导性，内部实际调用 `getSigned(PATH_INDEX, ...)`。
- `/index.avatars` 被映射成 `MiyousheCharacterDetail`，但 artifacts 固定为空。
- `doSignedRequest()` 已支持 GET/POST，DS signer 也支持对精确 body 签名；缺少的是公开的 POST wrapper、endpoint contract 和 parser。

值得注意：日志目前会输出完整 body。实现 detail 后，诊断日志应只输出 endpoint、payload count、body hash 或字符长度，不要输出完整角色数据。

### 3.3 风控降级

文件：

- `src/main/services/miyoushe/browser-bridge.ts`
- `src/main/ipc/profile.ipc.ts`

当前三段逻辑：

1. 主进程 Direct HTTP 请求 `/index`。
2. Hidden BrowserBridge 打开官方 Battle Chronicle，截获 `/index`。
3. Visible BrowserBridge 允许用户完成验证，然后主进程重试 `/index`。

三段都不可能得到 detail。正确演进方向：

- 直连优先走 list/detail。
- BrowserBridge 同时观察官方页面自己的 list/detail 响应。
- 验证后重试的目标也必须是 list/detail。
- 不要伪造随机 `device_fp`；若设备字段成为必要条件，优先复用官方页面真实上下文或官方生成流程。

### 3.4 Enka

文件：`src/main/services/enka-client.ts`

Enka 的产品定位只能是：

- 无登录快速预览；或
- 米游社 detail 不可用时，为展示柜角色补强精确 build。

不能把 Enka 当完整角色池来源，因为 UID endpoint 只反映游戏展示柜。当前 parser 还没有解析 raw Enka 中的：

- `weapon`
- `reliquaryList`
- `skillLevelMap`
- `talentIdList`
- 更完整的属性映射

因此当前注释“展示的 8 个角色可由 Enka 提供 weapons/artifacts”与实际实现不一致。

### 3.5 Profile merge

文件：`src/main/services/profile-merger.ts`

当前优先级：

- Enka 赢 stats。
- 米游社赢 level/constellation/talents/weapon/artifacts。

问题：实际米游社 acquisition 没有 details，Enka parser 又丢装备；rich merge 只存在于手写测试 fixture 中。另一个严重问题是没有 Enka stats 时人为生成全 0 stats。

必须改成：

- unknown 保持 `undefined`，永不补 0。
- ownership、build、stats 分开记录来源。
- 每个角色具备 completeness 和 missingFields。
- 整个 profile 具备 roster/build 覆盖率，不能只用笼统的 `source: merged`。

### 3.6 To LLM 边界

文件：

- `src/main/services/advisor-agent.ts`
- `src/main/agents/advisor/prompt.ts`

`buildUserMessage()` 当前只发送：

```json
{
  "characters": [
    {
      "id": 10000000,
      "name": "...",
      "element": "...",
      "rarity": 5,
      "stats": {}
    }
  ],
  "enemies": [],
  "preference": ""
}
```

缺少命座、武器、天赋、圣遗物套装/主词条以及数据完整度。系统提示却要求模型判断“面板强度、轴位适配度、充能闭环、西风套路”，属于输入与任务不匹配。

本地 fallback 也按 stats 数值加权；遇到补 0 的角色会把“未知”错误判成“极弱”。

## 4. 正确的官方 endpoint 契约

### 4.1 国服

Base URL：

```text
https://api-takumi-record.mihoyo.com/game_record/app/genshin/api
```

请求：

```text
POST /character/list
POST /character/detail
```

list body：

```json
{
  "role_id": "100000001",
  "server": "cn_gf01"
}
```

detail body：

```json
{
  "role_id": "100000001",
  "server": "cn_gf01",
  "character_ids": [10000002, 10000003]
}
```

### 4.2 国际服

当前活跃参考实现使用：

```text
https://sg-public-api.hoyolab.com/event/game_record/genshin/api
```

当前项目仍使用旧形态：

```text
https://bbs-api-os.hoyolab.com/game_record/genshin/api
```

实施时应单独验证并更新国际服 route，不要把国服结论直接套用。

### 4.3 DS 签名要点

当前 `signDsV2` 的 CN recipe 与当前 `genshin.py` 一致：

- client type `5`
- app version `2.11.1`
- salt `xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs`
- POST body 与 GET query 参与签名

关键约束：传给 `signDsV2({ body })` 的字符串必须与最终 HTTP body 字节一致。只 stringify 一次，并复用同一个字符串签名和发送。

## 5. 数据能力边界

| 来源 | 角色覆盖 | 当前装备 | 天赋/命座 | 精确面板 | 未装备背包 |
|---|---:|---:|---:|---:|---:|
| 米游社 `/index` | 预计全池，需 count gate | 不可靠/不完整 | 基础命座可能有，天赋无 | 不完整 | 无 |
| 米游社 `character/list` | 全池 | 基础武器/角色信息 | 部分 | 部分 | 无 |
| 米游社 `character/detail` | 按 IDs 覆盖全池 | 武器 + 当前 5 件圣遗物 | 有 | 基础/额外/元素属性 | 无 |
| Enka UID | 仅展示柜 | 展示角色很详细 | 有 | `fightPropMap` 精确 | 无 |
| 静态角色数据库 | 全角色元数据 | 不含玩家拥有事实 | 技能机制元数据 | 不含玩家面板 | 无 |

产品里的“完整角色池”应定义为：全部 owned characters + 每个角色当前 equipped build snapshot。不要声称能读取全部背包资产。

## 6. 建议目标模型

以下是方向性接口，不要求一次性照搬命名。核心是把 ownership、build 和 provenance 分离。

```ts
type DataCompleteness = 'basic' | 'build' | 'detailed';

interface FieldProvenance {
  source: 'miyoushe-index' | 'miyoushe-list' | 'miyoushe-detail' | 'enka';
  fetchedAt: string;
  stale?: boolean;
}

interface CharacterBuildSnapshot {
  stats?: CharacterStats;
  weapon?: CharacterWeapon;
  artifacts?: ArtifactPiece[];
  talents?: CharacterTalents;
}

interface CharacterProfile {
  id: number;
  name: string;
  element: string;
  rarity: number;
  level?: number;
  constellation?: number;
  friendship?: number;
  imageUrl: string;
  build?: CharacterBuildSnapshot;
  completeness: DataCompleteness;
  missingFields: Array<'stats' | 'weapon' | 'artifacts' | 'talents'>;
  provenance: {
    ownership: FieldProvenance;
    build?: FieldProvenance;
    stats?: FieldProvenance;
  };
}

interface ProfileCoverage {
  expectedOwnedCount?: number;
  ownedCount: number;
  detailedCount: number;
  statsCount: number;
  enkaShowcaseCount: number;
}
```

迁移可分两步：

1. 先在现有 `CharacterProfile` 上增加可选 completeness/provenance，并停止补 0。
2. 再将 build 聚合为独立 snapshot，避免一次大范围 renderer breakage。

## 7. 建议给 LLM 的紧凑结构

不要把米游社 raw response 或五件圣遗物的全部描述原样塞进 prompt。先本地确定性压缩：

```ts
interface AdvisorCharacterInput {
  id: number;
  name: string;
  element: string;
  rarity: number;
  level?: number;
  constellation?: number;
  talents?: {
    normal?: number;
    skill?: number;
    burst?: number;
  };
  weapon?: {
    name: string;
    level: number;
    refinement: number;
    rarity: number;
  };
  artifactSummary?: {
    sets: Array<{ name: string; count: number }>;
    mainStats: Partial<Record<'sands' | 'goblet' | 'circlet', string>>;
  };
  stats?: {
    hp?: number;
    atk?: number;
    def?: number;
    critRate?: number;
    critDmg?: number;
    energyRecharge?: number;
    elementalMastery?: number;
  };
  completeness: 'basic' | 'build' | 'detailed';
  missingFields: string[];
}
```

Prompt 必须明确：

- 缺失字段是 unknown，不是 0。
- 不可根据 unknown 推断角色没练。
- 推荐应标注对数据完整度敏感的假设。
- 充能/武器/套装结论只能在相应字段存在时下判断。
- 全角色 ownership 可用于组队候选；build 不完整时降低信心，而不是直接剔除。

## 8. 推荐实施顺序

### Phase 0：只读脱敏 probe

目标：不改变产品行为，验证当前本机登录态。

建议新增开发期入口，例如 `npm run gate:miyoushe-detail` 或 main-only diagnostic service。不要让 renderer 得到 Cookie。

按同一 UID、同一 Cookie 依次请求：

1. `/index`
2. `character/list`
3. `character/detail` 单个 ID
4. `character/detail` 全量或分批 IDs

仅记录：

- HTTP status / retcode / message 分类
- endpoint
- response 顶层 keys
- index expected count
- list count
- detail count
- weapon/artifact/talent/stats 覆盖数

禁止记录：

- Cookie / Authorization
- raw detail JSON
- API Key
- 完整 UID（日志中可保留后 3 位）
- 角色具体面板值

验收：

```text
index.stats.avatar_number == character/list.length
character/list IDs ⊆ character/detail IDs
detail 至少有 weapon/relics/skills/property 字段
```

若 direct HTTP 返回正 `5003`/`1034`，记录为 Geetest/risk-control，不得解释为角色为空或接口永久不可用。

### Phase 1：米游社 list/detail 产品接入

主要文件：

- `src/main/services/miyoushe-game-record.ts`
- `tests/unit/services/miyoushe-game-record.spec.ts`

任务：

- 增加 CN/global endpoint builders。
- 增加 `postSigned<T>()`，签名和发送同一个 JSON 字符串。
- 定义 raw list/detail response types。
- 实现 field mapper：weapon、relics、skills、properties、constellations。
- 对 character IDs 分批，合并结果且保持 list 顺序。
- 对重复/遗漏 ID 做显式 coverage error 或 partial result，不要静默丢失。
- 保存一份脱敏 sanitized fixture，测试真实 schema，而不只是手写理想对象。

建议先保留 `/index` 作为 ping/expected-count，不再把它伪装成 details。

### Phase 2：风控与 BrowserBridge

主要文件：

- `src/main/services/miyoushe/browser-bridge.ts`
- `src/main/ipc/profile.ipc.ts`

任务：

- Bridge 观察并解析官方页面的 `character/list/detail`。
- 可见验证完成后重试 list/detail。
- 区分 auth-expired、captcha-required、rate-limited、signature/upstream。
- 正 `5003` 与负 `-5003` 不要混淆。
- Direct HTTP、bridge-hidden、bridge-visible 都返回一致的 typed result 和 coverage。

### Phase 3：Enka parser 补强

主要文件：

- `src/main/services/enka-client.ts`
- `tests/unit/services/enka-client.spec.ts`

任务：

- 解析展示角色的 weapon/reliquary/skills/talent/stats。
- 尊重 Enka TTL、429 和缺少 avatarInfoList 的语义。
- Enka build 可补强展示角色，但不能制造全池已覆盖的假象。

### Phase 4：Profile 模型与 merge

主要文件：

- `src/shared/domain.ts`
- `src/main/services/profile-merger.ts`
- `src/main/services/profile-store.ts`
- renderer 中所有读取 `character.stats` 的组件

任务：

- unknown 改为 optional，删除全 0 placeholder。
- 增加 provenance/completeness/coverage。
- 明确 field-level conflict rules。
- 为旧 cache 增加 schema migration 或容错读取。
- UI 显示“完整 build / 基础角色信息 / 数据缺失”，不再统一称“完整”。

### Phase 5：To LLM serializer 和 prompt

主要文件：

- `src/main/services/advisor-agent.ts`
- `src/main/agents/advisor/prompt.ts`
- 新增专用 serializer，例如 `src/main/services/advisor-profile-serializer.ts`

任务：

- 将 `buildUserMessage` 抽成可单测的纯函数。
- 传入武器、命座、天赋、套装、三件关键主词条、核心 stats、completeness。
- 严格限制 token；不要传 icon URL、描述文本、全部 substats，除非证明有收益。
- Prompt 增加 unknown 语义和 confidence 约束。
- 本地 fallback 对缺失 stats 使用可解释的基础排序，不得将 unknown 当 0。
- 为同一 Profile 生成稳定序列化结果，便于 snapshot/eval。

### Phase 6：端到端验收

最少覆盖：

- 登录米游社后 owned count 与 Battle Chronicle 一致。
- 非 Enka 展示角色也能获得 detail 或明确标为 partial。
- 关闭展示柜时，米游社 detail 仍可独立工作。
- Enka 失败时不会丢失米游社全角色池。
- 米游社 detail 风控时能回退到 basic roster，并向用户标明完整度。
- LLM 请求 fixture 中可见 weapon/talents/artifactSummary/completeness。
- 未知 stats 不出现伪造的全 0。

## 9. 测试矩阵

### Unit

- DS 对 POST body 的签名固定向量。
- list/detail raw schema mapper。
- 分批、顺序、重复 ID、partial response。
- error classification：`-100`、`10001`、`1034`、正 `5003`、429、5xx、non-JSON。
- Enka equipment mapper。
- merger field provenance。
- compact serializer token/字段约束。
- fallback unknown stats 行为。

### Fixture contract

- 使用真实响应脱敏后的 sanitized fixture。
- fixture 不应包含 UID、昵称、Cookie、面板具体值等用户隐私；数值可以稳定替换。
- 对 raw key 名做契约测试，避免手写 fixture 与真实接口脱节。

### External gate

- opt-in，CI 默认不运行。
- 只在本机持久化登录态存在时运行。
- 输出 coverage summary，不输出 raw 数据。
- 失败要给出分类和下一步，不自动无限重试。

### E2E

- mock detailed profile，验证 Roster 完整度标签。
- Advisor 请求 payload 包含紧凑 build。
- partial profile 时 UI 与 prompt 都正确表达 unknown。

## 10. Definition of Done

只有同时满足以下条件，才算这个 P0 gap 关闭：

- [ ] 真实账号 gate 验证 list/detail 能成功或能稳定走 BrowserBridge。
- [ ] owned count 与 expected count 有明确校验。
- [ ] 全角色 detail coverage 有统计，partial 不静默。
- [ ] weapon/artifacts/talents/stats 至少从一个可信来源进入 Profile。
- [ ] unknown 不再填 0。
- [ ] Profile 有 field-level provenance 和 completeness。
- [ ] Advisor serializer 实际把 build 信息传给 LLM。
- [ ] Prompt 明确处理 unknown/partial 数据。
- [ ] fallback 不再因缺数据错误降权角色。
- [ ] 单测、typecheck、lint、build 通过。
- [ ] 不破坏 Cookie 不进 Renderer、日志 redact、sandbox 等安全边界。

## 11. 不要踩的坑

- 不要把 `/index` 方法继续命名为 `fetchCharacterDetails`。
- 不要把成功登录等价为 detail 请求已经成功。
- 不要把 `5003` 一律归因于 device fingerprint。
- 不要随机拼 `device_id/device_fp` 后直接持久化。
- 不要依赖 Enka 构建完整角色池。
- 不要将 missing stats 填 0。
- 不要只升级 domain type，却忘记 LLM serializer。
- 不要把 raw 米游社详情完整塞进 prompt。
- 不要把用户 Cookie/raw profile 写入测试 fixture、日志或 issue。
- 不要在 CI 强制请求真实米游社/Enka。

## 12. 外部参考

- [`genshin.py` 当前 list/detail 调用](https://github.com/seriaati/genshin.py/blob/master/genshin/client/components/chronicle/genshin.py#L78-L125)
- [`genshin.py` detail models](https://github.com/seriaati/genshin.py/blob/master/genshin/models/genshin/chronicle/characters.py#L155-L225)
- [`genshin.py` CN/global routes](https://github.com/seriaati/genshin.py/blob/master/genshin/client/routes.py#L141-L154)
- [`genshin.py` Geetest retcodes](https://github.com/seriaati/genshin.py/blob/master/genshin/constants.py#L130-L131)
- [Battle Chronicle to GOOD 导出脚本](https://gist.github.com/atouu/ccf615f6ccd2d228a101118b558cd4d3#file-bctogo-user-js-L189-L228)
- [Enka UID endpoint 边界](https://github.com/EnkaNetwork/API-docs/blob/master/api.md#uid-endpoints)
- [Enka Genshin avatar schema](https://github.com/EnkaNetwork/API-docs/blob/master/docs/gi/api.md#avatarinfolist)
- [米游社 Cookie/DS 社区鉴权参考](https://github.com/UIGF-org/mihoyo-api-collect/blob/main/other/authentication.md)

## 13. 给新 session 的建议首条 Prompt

```text
请先完整阅读 AGENTS.md 和 docs/handoff-miyoushe-profile-to-llm.md。

目标是修复“米游社完整角色池 -> Profile -> LLM”P0 链路，但不要一开始就大改所有层。

第一阶段只做：
1. 审计 handoff 中所有代码定位是否仍与当前 HEAD 一致；
2. 设计并实现一个 main-process-only、默认不运行、输出完全脱敏的 character/list -> character/detail external gate；
3. 为 POST DS/body、endpoint route、错误分类补单测；
4. 不让 Cookie/raw profile 进入 renderer、日志或 fixture；
5. 运行 typecheck、lint 和相关单测；
6. 在拿到真实 gate 结果前，不要假设 device_id/device_fp 是必需或不必需。

完成后汇报：实际请求矩阵、retcode 分类、字段覆盖率、仍然未知的风险，以及下一阶段产品接入的最小 patch 方案。
```

## 14. 当前工作树注意事项

生成本 handoff 时，`AGENTS.md` 是用户已有的未跟踪文件。不要删除、覆盖或擅自纳入提交。除本 handoff 外，没有为这个调研修改产品代码。
