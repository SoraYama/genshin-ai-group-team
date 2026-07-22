# 数据源与发布契约

本文冻结 M0 的业务数据边界。产品只服务当前已公开、已上线内容，**不展示、推断或打包任何未发布数据**。所有外部读取未来都由 Electron Main 进程执行；Renderer 不直接联网。

许可和服务条款可能变化。下表是产品的最小使用约束，不替代上游条款；每次引入新来源或改变再分发方式都必须重新人工审核。

## 来源分工、许可与更新策略

| 来源                                       | 可用于什么                                               | 许可、条款与再分发                                                                                                                                                                                                                                                                                                     | 更新节奏、触发与陈旧策略                                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方公告与公开规则页                       | 活动名称、开放时间、公开玩法规则、当期公告中的敌人与增益 | 页面、图片和游戏素材受发布方版权及服务条款保护。只保存经人工核对的事实字段、短引用所需来源链接和抓取时间；不镜像页面，不再分发官方图片、字体、音频或 UI 切片。                                                                                                                                                         | 官方发布、修订或撤回公告时事件驱动更新；轮换切换前后每日人工复查一次，审核通过后发布新 `dataVersion`。版本化包无滑动 TTL，以 `effectiveFrom` / `effectiveTo` 判定是否适用。 |
| 已认证的米游社战绩数据（Battle Chronicle） | 玩家拥有角色、等级、命座、武器、圣遗物等账号可见资料     | 受 HoYoverse/米游社服务条款与隐私政策约束；必须由玩家主动授权。Cookie 只在 Main 进程安全边界使用，原始响应和账号资料不进入公共数据包、不向其他用户再分发。                                                                                                                                                             | 绑定账号、玩家手动刷新或持久登录恢复时拉取；本地角色快照超过 24 小时标记为可能过期，刷新失败保留最近一次本地快照并显示状态。                                                |
| Fandom / community wiki 文本               | 已公开玩法或机制的文字补充、人工核对线索                 | `community-wiki` 来源引用必须包含页面 URL、作者/社区 attribution 和许可声明。Fandom 默认文本许可为 [CC BY-SA 3.0](https://www.fandom.com/licensing)，但采集时仍要核对具体 wiki 页面的许可；其他社区 wiki 使用 `source-declared` 记录其实际许可声明与链接。讨论区、聊天、图片和站点 UI 不在默认文本许可范围内，不采集。 | 不自动轮询；版本更新后由人工按需核对。每次采用文本时记录页面修订时间，每季度复查链接与许可，发现变化即停止重新发布直到审核完成。                                            |
| `genshin-db`                               | 角色、武器、天赋、敌人等静态公开知识和本地查询索引       | npm 包代码标注 [MIT](https://www.npmjs.com/package/genshin-db)；包内数据涉及的上游游戏内容权利不因代码许可自动转移。固定包版本并保留许可证，只发布规范化事实字段，不打包上游图片或其他官方素材。                                                                                                                       | 无网络 TTL；仅在升级固定依赖版本时更新。升级必须经过变更 diff、来源和许可复查，再生成新的业务数据版本。                                                                     |
| Enka                                       | 玩家主动提供 UID 后的公开展示柜角色面板                  | **仅限 profile scope**。不假定 Enka 响应或素材具有可再分发许可；遵守服务当时公布的条款、限流和署名要求。只为该玩家本地解析数值，不把原始响应、图片 URL 或缓存汇入公共数据包。                                                                                                                                          | 玩家导入 UID 或手动刷新时触发；本地展示柜快照超过 24 小时标记为可能过期。服务失败时保留本地最近快照，不用 Enka 推断完整角色仓库或玩法数据。                                 |
| 原始/拆包/数据挖掘来源                     | 开发期间交叉检查字段名、映射和解析器结果                 | **仅开发期 cross-check**。不主张再分发权，不进入玩家可见数据包、文案、日志样本或预测；临时文件不随安装包或 Release 发布。                                                                                                                                                                                              | 只在解析器开发或已公开版本变更时由开发者手动运行；不定时抓取、不设生产 TTL。交叉检查结束即清理临时数据，结论必须由允许发布的来源重新支持。                                  |

账号数据只描述玩家状态，不作为全局玩法规则来源；官方公告与已审核知识库描述玩法规则。Enka 只补充 UID 展示柜资料，不能替代完整账号资料、活动规则或敌人轮换。`battle-chronicle` 与 `enka-profile` 即使有效且非开发来源，也不能独立支撑场景规则字段。

## 现场数据边界

- 只收录官方已公开且已上线的版本、轮换和玩法数据。
- 不提供泄露内容、测试服未发布内容、未来卡池/敌人/活动预测，也不以模糊措辞暗示这类信息。
- “已在客户端文件中出现”不等于“已公开上线”。原始或数据挖掘结果只能帮助开发者发现解析错误。
- 公共发布 payload 的每个实际字段路径都必须由允许的场景发布来源支持；只声明但未被该字段引用的来源不计入支持证据。

## 字段级来源

每个发布 payload 必须包含非空 `sourceRefs` 与非空 `fieldProvenance`。运行时 schema 强制：

- 每个来源引用具有唯一稳定 ID；
- 每条字段来源的 `sourceRefId` 必须指向同一 payload 内存在的来源；
- `community-wiki` 引用强制记录 URL、attribution 和 `CC-BY-SA-3.0` 或 `source-declared` 许可声明；其他来源记录可访问时的原始 URL、抓取时间和必要署名；
- 人工修正或多来源裁决写入字段备注；
- 公共发布 `sourceRefs` 只允许 `official-announcement`、`community-wiki` 或 `genshin-db`；Battle Chronicle、Enka 和开发交叉检查证据不得嵌入发布 payload；
- 内部审核证据单独保存为 `InternalReviewEvidence`，可记录 `battle-chronicle`、`enka-profile`、`development-cross-check` 及任意内部核对路径，但不参与发布签名与分发；
- 公共 `fieldPath` 只能取受控路径，并必须完整覆盖对应模式：深渊为 `meta.effectiveRange`、`scenario.floors`、`scenario.blessing`；幽境危战为 `meta.effectiveRange`、`scenario.phases`、`scenario.difficulties`、`scenario.reusePolicy`；幻想真境剧诗为 `meta.effectiveRange`、`scenario.eligibility`、`scenario.cast`、`scenario.nodes`、`scenario.vigor`；
- 重复来源 ID、悬空引用、任意路径、跨模式路径或缺少必需路径的 payload 一律拒绝。

同一个场景字段路径可以引用多个允许发布的正式来源，但不得只写笼统的“来自网络”。例如活动有效期可来自官方公告，敌人静态抗性可来自固定版本的 `genshin-db`。玩家角色数值属于独立的玩家资料记录，可来自米游社或 Enka，不并入场景发布 provenance；开发交叉检查结论只进入内部审核记录。

## 生效日期、版本与严格兼容

- 场景 payload 的 `schemaVersion` 描述结构兼容性；`dataVersion` 唯一标识一份已发布业务数据。
- `effectiveFrom` 必填，`effectiveTo` 可选但不得早于开始时间。有效区间按半开区间 `[effectiveFrom, effectiveTo)` 解释，因此检查时刻等于 `effectiveTo` 已是 stale。它们属于经审核、被签名的 payload。
- 推荐计划拥有独立的 `schemaVersion: 2`，以便历史记录与场景数据分别迁移；同时回显所用 `dataVersion`。
- 外部发布 envelope、场景 payload、推荐计划和玩家干预的所有对象层级均以 Zod `.strict()` 递归拒绝未知字段，避免嵌套 producer drift 被静默丢弃。
- 兼容策略是“先识别版本，再执行显式迁移，最后按当前 strict schema 解析”；不通过接受未知字段实现前向兼容。
- 时区敏感的活动时间在采集层保留明确偏移或统一为 UTC，并在 UI 按玩家时区显示。

## 审核 payload 与完整性 envelope

自动采集结果不能直接成为发布数据。发布前至少由一名审核者完成：

1. 对照官方公告确认玩法、时间和当期范围。
2. 对关键敌人机制、资格与复用规则做第二来源交叉检查。
3. 检查字段级来源、各来源条款、署名和再分发范围。
4. 确认没有未发布内容或受限素材混入。
5. 在 payload 的 metadata 写入审核人和审核时间，再生成外层完整性信息。

完整性字段**不属于被哈希或被签名的 payload**。发布文件采用以下确定性 envelope：

```text
{
  payload: <reviewed ScenarioV2>,
  integrity: {
    scope: "payload",
    serialization: "RFC8785-JCS",
    hash: { algorithm: "sha256", encoding: "base64", value },
    signature: { algorithm: "ed25519", keyId, encoding: "base64", value }
  }
}
```

验证者直接取磁盘或网络解码得到、尚未经 Zod 转换的 `payload` JSON 值，按 RFC 8785 JSON Canonicalization Scheme 生成 UTF-8 字节。该 JCS 必须与 strict schema 解析结果的 JCS 完全相同，任何 trim/default/coerce 造成的变化均拒绝。SHA-256 与 Ed25519 都覆盖这同一份原始 canonical 字节；`keyId` 只能选择可信 Ed25519 公钥，私钥 PEM、private `KeyObject` 和含 `d` 的 JWK 一律拒绝。任何 envelope 其他字段、运行时缓存状态和完整性字段本身都不进入 canonical payload scope。哈希、签名、算法、编码或可信 key 不匹配时，该发布包不得进入推荐链路。

M1 已实现本地发布、验签、last-known-good 与原子缓存边界；生产密钥轮换、吊销列表和独立数据仓库上线流程见 [场景数据发布与本地消费](./scenario-publication.md)。

## 运行时新鲜度与最近可用版本

`fresh`、`stale`、`last-known-good`、`refresh-failed` 都是随时间和网络结果变化的本地状态，不能写入经审核、被签名的 metadata。缓存结构在发布 envelope 外另存 `runtime`，包括新鲜度、检查时间、最近刷新尝试和可选错误码。

已通过签名验证和 schema 校验的发布 envelope 可以成为本地最近可用版本。新包下载、解析、签名或刷新异常时：

- 不覆盖最近可用发布 envelope；
- 在本地 runtime 状态标记 `stale`、`last-known-good` 或 `refresh-failed`，并展示数据版本和最后审核时间；
- 仍在 payload 有效期内时，可以谨慎继续推荐，同时在结果中给出警告；
- 已超出 `effectiveTo` 时，只能作为旧资料参考，禁止声称它代表当前轮换；
- 没有可验证的最近可用版本时，停止依赖当期数据的推荐，保留玩家本地资料与静态浏览能力；
- 恢复后只有通过完整校验和人工审核的新 envelope 才能替换旧版本。

“使用旧资料”是可见的产品状态，不得静默处理。错误日志只记录来源 ID、版本与错误类别，不记录 Cookie、API Key 或 Authorization 内容。

仓内合成开发样例不冒充上述任何正式来源。它们使用独立的 `development-only` wrapper 和 `synthetic-development-data` provenance，只能由开发 fixture schema 校验；production publisher 必须拒绝该 wrapper 与 `development-sample` channel，不能把合成字段自动转换成 `official-announcement`、`community-wiki` 或 `genshin-db` 来源。
