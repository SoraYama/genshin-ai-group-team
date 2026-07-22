# 场景数据发布与本地消费

本文件描述 `ScenarioV2` 的发布边界。它只适用于深境螺旋、幽境危战和幻想真境剧诗的场景数据，不处理玩家 Cookie、展示柜或 AI 服务密钥。

## 当前仓库负责什么

桌面 App 仓库负责“验证和消费”，不负责把任意网页内容直接变成玩家数据：

- `src/shared/scenario-v2.ts` 冻结三种玩法的 strict Zod 契约；
- `src/main/scenario-publication/` 提供 RFC 8785 JCS、SHA-256、Ed25519、manifest、reader、版本路由、最近可用版本和原子存储；
- HTTP 或本地文件 reader 只在 Main 进程使用并由依赖注入，Renderer 不联网；
- App 在构造消费服务时必须明确声明 `expectedUse`（`production` 或 `development-sample`），并为该用途注入独立的可信 Ed25519 公钥集合。生产私钥不得进入应用源码、安装包、日志或 CI 普通变量；
- manifest 的 `channel` 只是 mismatch gate，不是信任根。可信用途来自调用配置，签名可信度来自该用途独立的 keyring；返回给 UI 的 `trustedUse` 也只来自这条可信配置；
- 验证通过的 publication 按用途分目录原子写入 `app.getPath('userData')/cache/scenarios/<trustedUse>`。生产与开发 last-known-good 不能互相读取；写入失败、网络失败或校验失败不会覆盖 LKG；
- `fresh`、`expiring`、`stale`、`unknown` 根据本机检查时刻和签名 payload 内的有效期计算，绝不回写到被签名 payload。

M1 新链路与旧 `ScenarioStore` 隔离存在；后续玩法纵切将把 IPC/UI 切到 `ScenePublicationService`。这种并行边界避免旧 v1 数据被误当作已签名的 v2 publication。

## 独立数据仓库负责什么

未来的 `genshin-team-advisor-data` 仓库负责“采集、审核和发布”：

1. 只录入已经公开并上线的正式服事实，不录入测试服、泄露或未来预测。
2. 官方公告优先；社区 wiki 或静态知识库只补充其许可允许再分发的文字/ID，并保留 URL、署名、许可和抓取时间。
3. 采集结果和人工覆盖先进入 PR。来源冲突、字段来源不完整、未知字段或许可不清楚时阻止合并。
4. 审核者确认有效期、敌人构成、玩法规则和字段级 provenance 后，运行同一套 strict schema。
5. 通过审核的 payload 用保存在受控签名环境中的 Ed25519 私钥签名；payload、detached integrity 和 manifest 一同发布。
6. manifest 保留每个玩法的 `current` 与 `history`。回滚只需把 `current` 指回仍通过签名验证的历史 descriptor，再发布新 manifest；不重写历史 payload。

公共数据仓库不存玩家资料、Cookie、API Key、官方图片、游戏 UI 切片或无法确认许可的素材。内部 cross-check 证据单独保存，不进入公共签名 payload。

## 发布格式与验证顺序

manifest v1 中每个 descriptor 固定 `mode`、`schemaVersion`、`scenarioId`、`dataVersion`、payload 路径、integrity 路径和发布 channel。路径必须是发布根目录下的相对 JSON 路径。

App 按以下顺序处理：

1. strict 解析 manifest，并找到对应玩法的 `current`；
2. 分别读取 payload 与 detached integrity；
3. 先识别 `payload.meta.schemaVersion`。当前只注册 v2；未知新版返回 `unsupported-schema-version`，不以丢弃字段的方式“兼容”；
4. 检查 descriptor channel 与调用方声明的 `expectedUse`，再从该用途的独立 keyring 选 key；strict 解析 payload/integrity，对 canonical payload 计算 SHA-256，并显式要求签名/验签 key 的 `asymmetricKeyType` 为 `ed25519`；
5. 比较 manifest 与 payload 的 mode、schemaVersion、scenarioId 和 dataVersion，任何冲突都拒绝；
6. 只有全部通过后才用同目录临时文件、flush 和 rename 原子替换本地缓存。

manifest 是离线 publisher 的 commit point：所有 payload 和 integrity 文件先写完，最后才写 manifest。远端部署也应先上传内容寻址目录，再原子切换 manifest。

## 开发样例不是当前事实

`resources/scenarios/v2/development-source` 仅用于开发、测试和 UI 演示：

- 敌人、角色、效果和规则均为原创虚构占位；
- 固定在 2026-01 的有效期只是测试 freshness 的输入；
- 每个文件都是 `fixtureKind: development-only` wrapper；`syntheticProvenance.kind` 固定为 `synthetic-development-data`，逐字段说明是合成测试输入；
- wrapper 不是 `ScenarioV2` publication，不包含正式 `sourceRefs`，尤其不会把虚构字段标成来自 `genshin-db`、官方公告或社区 wiki；
- 它们不能在 UI 中显示为“本期”“正式服当前敌人”或作为正式推荐依据；
- production publisher 只接受 `channel: production` 的 strict `ScenarioV2`。把 development wrapper 或 development channel 交给它会被拒绝，不存在把合成 provenance 转成正式 provenance 的隐式步骤。

验证三个开发样例及其 current/history 索引：

```bash
npm test -- --run tests/unit/scenario-publication/committed-fixtures.spec.ts
```

正式发布应直接调用 `scripts/scenario-data/publish.ts` 的构建产物，显式传入受保护的 Ed25519 私钥路径、key ID、production 输入目录、输出目录和审核后的发布时间。

## 玩家界面状态语义

| 服务结果                          | 玩家文案语义                             | 推荐行为                                     |
| --------------------------------- | ---------------------------------------- | -------------------------------------------- |
| `ready + fresh`                   | 挑战数据已更新                           | 可作为当前场景输入                           |
| `ready + expiring`                | 本期数据即将结束，显示结束时间           | 可推荐，但提示即将换期                       |
| `ready/last-known-good + stale`   | 这是截至某日的旧资料，不代表本期         | 只读参考或自定义演练，不声称“本期推荐”       |
| `ready/last-known-good + unknown` | 数据有效期尚未开始或缺少结束时间         | 明示无法判断是否为当前期，禁止无提示使用     |
| `last-known-good`                 | 更新失败，正在使用最近一次验证通过的数据 | 保留数据版本、审核时间和安全的错误类别       |
| `unavailable`                     | 暂时没有可验证的挑战数据                 | 禁用依赖当前场景的推荐；角色浏览和历史仍可用 |

HTTP 404、网络不可用、JSON 损坏、schema drift、digest mismatch、bad signature、identity mismatch、未知 schema 和原子写失败都有稳定 typed code。对玩家只展示可行动的中文说明；日志不得拼接响应正文、请求头、Cookie、API Key 或 Authorization。

## 审核、轮换与吊销

- 常规更新：来源 PR → schema/provenance 校验 → 人工复核 → 受控签名 → staging 验签 → 上传内容文件 → 切换 manifest。
- 紧急回滚：选择 history 中最后一份无误且仍适用的签名 publication，更新 `current`，保留错误版本供审计但不再引用。
- 密钥轮换：先随 App 发布新公钥/key ID，再用新私钥签名数据；旧 key 的删除或吊销需要保留能解释历史缓存的迁移窗口。
- 私钥泄漏：停止使用该 key、发布 App 侧吊销列表、让受影响 publication 失效，并从重新审核的 payload 生成新 dataVersion；不能只换 manifest URL。

独立数据仓库上线前，仓内 development sample 是唯一 v2 fixture，不应被误解为已经存在的正式场景数据源。
