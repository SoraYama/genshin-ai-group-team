# Enka 展示柜与完整角色池的数据完整性设计

## 背景与证据

当前本机 profile 摘要包含 12 个角色，所有角色的 `source` 与 ownership provenance 都是 `enka`，没有任何米游社 ownership 数据；但 coverage 被计算成 `partial: false`。这会把“Enka 展示柜子集”错误显示为“完整角色池”。

根因有两层：

1. Enka UID 接口只提供公开角色展示柜的 `avatarInfoList`，不能证明账号的全部 owned characters。
2. `profile:refresh` 在 Enka 成功、米游社失败时用 Enka 子集重新构建并覆盖 profile；`mergeProfile` 又在没有权威 ownership 来源时把展示柜数量当成 `ownedCount`，并可能得到 `partial: false`。

## 目标

1. Enka-only profile 永远明确标记为部分数据，不能宣称 ownership 完整。
2. 已缓存过米游社全角色池时，后续米游社刷新失败不得被 Enka 子集覆盖。
3. 缓存回退期间，保留完整角色集合，并用新鲜 Enka 数据补强展示角色的面板。
4. 米游社重新登录并成功返回 `character/list` / `character/detail` 后，重新建立权威 ownership 与 coverage。
5. 不把 Cookie、完整 UID、角色详情或风险验证上下文暴露到 Renderer 或日志。

## 非目标

- 不尝试从 Enka 推断未公开角色。
- 不自动破解或绕过 Geetest。
- 不把全部背包武器、圣遗物或未装备资产定义为“完整角色数据”。
- 不在没有米游社成功响应时伪造 `expectedOwnedCount`。

## 方案选择

采用“权威 ownership + 新鲜字段补强 + 陈旧回退”模型：

- 米游社 `character/list` 是完整 ownership 的唯一权威来源。
- Enka 是展示角色 build/stats 的补强来源。
- 缓存过的米游社角色池可以在外部刷新失败时继续使用，但必须标为 stale / partial。
- 没有权威 ownership 缓存时，只显示 Enka 子集并标为 partial。

不采用以下方案：

- 只修改 UI 文案：无法阻止刷新覆盖已有完整缓存。
- 无登录态时自动弹登录窗口：会让普通刷新产生突兀的外部交互；保留现有显式“重新登录并拉取全部角色”入口更可控。

## 数据模型与合并规则

`ProfileMergeInput` 增加可选的缓存回退输入，包含旧 profile 的 characters 与 coverage。合并按以下优先级执行：

1. **米游社本次成功**：以本次米游社角色列表作为 ownership 基础；Enka 按角色 ID 补强字段；忽略旧缓存的 ownership 集合。
2. **米游社本次失败且存在缓存**：保留旧角色集合；所有沿用的旧 provenance 标为 `stale: true`；对本次 Enka 展示角色，用新鲜 Enka stats/build 覆盖相应字段；profile source 为 `miyoushe-stale`，coverage 强制 `partial: true`。
3. **米游社本次失败且无缓存**：只返回 Enka 展示角色；profile source 为 `enka`，coverage 强制 `partial: true`，`expectedOwnedCount` 保持未知。

`ownedCount` 在 stale 回退时表示当前缓存中可用于配队的已知角色数，不等同于实时账号总数。`expectedOwnedCount` 只沿用旧米游社 coverage 或来自新的 `/index`，绝不由 Enka 数量生成。

## 组件改动

### `src/main/services/profile-merger.ts`

- 扩展合并输入以接收缓存 profile。
- 增加 cached-character 与 fresh-Enka 的字段级合并。
- 集中决定 `ProfileSource` 与 coverage，避免 IPC 层重复推导出误导性的 `miyoushe+enka`。
- Enka-only 与 stale fallback 均强制 `partial: true`。

### `src/main/ipc/profile.ipc.ts`

- `profile:refresh` 将现有 profile 传给 merger 作为失败回退。
- `importWithCookie` 在目标 UID 已存在缓存且米游社导入失败时同样保留缓存。
- 本次米游社成功时仍以新角色池替换旧 ownership。
- refresh summary 继续分别显示 Enka、米游社和合并后数量，不输出敏感数据。

### Renderer

现有 coverage 与刷新摘要已经能显示 partial、no-cookie、captcha-required 和重新登录按钮。本轮不新增自动弹窗；修正后的 domain 数据会让现有 UI 显示真实状态。

## 错误与恢复行为

- 无米游社登录态：显示 Enka 子集或 stale cache，并提示重新登录获取全部角色。
- 5003 / 10306：保留缓存；只对当前 trace 完成一次验证，不循环弹窗。
- Enka 失败、米游社成功：使用米游社完整角色池，Enka 只记为补强失败。
- 两个数据源都失败且存在缓存：原样返回旧 profile，不覆盖文件。
- 两个数据源都失败且无缓存：返回已有的上游不可用错误。

## 测试策略

以 TDD 覆盖以下回归：

1. Enka-only 的 12 个详细角色仍为 `partial: true`，source 为 `enka`。
2. 旧缓存有更多米游社角色、刷新只拿到 Enka 子集时，合并后不丢角色，source 为 `miyoushe-stale`。
3. stale 回退中，展示角色使用新鲜 Enka stats/build，非展示角色保留旧字段并标 stale。
4. 米游社随后成功时，以新的权威角色池恢复 source/coverage，不继续携带 stale ownership。
5. 两源都失败时继续返回现有 profile，不改写缓存。

完成后运行 focused unit tests、`npm run gate:local`、Electron E2E 和依赖审计。真实数据恢复以用户在内置窗口重新登录后，刷新摘要出现非零“米游社全角色”计数且 `ownedCount` 与 `expectedOwnedCount` 一致为准。

## 验收标准

- Enka-only 不再显示为完整角色池。
- 外部刷新失败不会缩减已有角色集合。
- 成功米游社刷新能恢复权威全角色数量。
- 所有缺失或陈旧状态在 coverage/source 中可观察，不以假 0 或假完整表示。
- 安全边界保持不变，所有凭据只存在于 Main。
