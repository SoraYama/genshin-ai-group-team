# 角色知识数据约定

`resources/knowledge/characters.v1.json` 是本地、版本化、严格校验的保守知识种子。它只记录配队约束需要的稳定事实，不记录倍率、排行或未经验证的最佳循环。

- `knowledgeVersion` 随任何事实或约定变化递增。
- 未收录角色返回完整 `unknownFields`，不得由模型补全。
- 已收录角色缺失的字段必须出现在 `unknownFields`；已提供字段不得同时标为 unknown。
- `energyNeeds` 是保守的低/中/高分档，不代表确定的充能阈值。
- `capabilities` 仅用于硬机制匹配：`healing`、`shield`、`grouping`、`off-field`、`on-field`、`onslaught`、`plunging`、`normal-attack`、`charged-attack`。

## 场景硬机制标签

场景可用 `requires-capability:<值>` 声明硬要求。当前约定版本为 `1`（随 Scenario v2 发布，工具输出为 `contractVersion: 1`）。允许值包括上述 capability，以及武器类型 `sword`、`claymore`、`polearm`、`bow`、`catalyst`。

- 每个标签只约束它所在的半场。
- 对应队伍必须至少有一名知识记录明确满足该 capability 或武器类型。
- 未知 requirement 一律 fail closed，不能靠偏好或模型推断绕过。
- 不以 `requires-capability:` 开头的普通描述标签仍只用于展示，不会自动升级为硬约束。
