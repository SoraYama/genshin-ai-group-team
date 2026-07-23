# 角色橱窗官方元素图标与信息纠偏规格

## 背景

角色橱窗当前有三个明确问题：

1. 七元素筛选和角色信息使用项目自绘的通用几何符号，玩家无法立即映射到游戏内元素。
2. `CharacterProfile.imageUrl` 数据链路仍然存在，但 `CharacterCard` 无条件渲染首字占位，导致角色头像消失。
3. 页面仅根据统一的 120% / 180% 阈值把充能效率评价为“偏低 / 中等 / 较高”。该判断没有角色爆发能量、技能产球、队伍同元素角色、武器、循环长度或战斗环境作为依据。

## 已确认的产品决策

- 删除仓库中“元素图标必须原创、不能使用游戏内图标”的旧规则。
- 七元素图标使用 HoYoLAB 官方 Wiki 页面公开加载的 84×84 PNG：
  - Pyro: `https://wiki.hoyolab.com/_nuxt/img/pyro.2267e27.png`
  - Hydro: `https://wiki.hoyolab.com/_nuxt/img/hydro.3e969aa.png`
  - Electro: `https://wiki.hoyolab.com/_nuxt/img/electro.be07020.png`
  - Anemo: `https://wiki.hoyolab.com/_nuxt/img/anemo.e0f1804.png`
  - Geo: `https://wiki.hoyolab.com/_nuxt/img/geo.2498e06.png`
  - Cryo: `https://wiki.hoyolab.com/_nuxt/img/cryo.b810caa.png`
  - Dendro: `https://wiki.hoyolab.com/_nuxt/img/dendro.88f5bfa.png`
- 图标随安装包本地加载，不让 Renderer 直接访问外网。每个文件在 manifest 中记录官方来源和 SHA-256，`resources/credits.md` 标明权利归 HoYoverse / COGNOSPHERE 所有以及项目无隶属关系。
- 角色头像继续使用现有 `gtai-img:` 主进程代理和缓存链路。只在 URL 为空、不符合代理协议或图片加载失败时显示首字占位。
- 角色总览只陈述面板充能效率，不再评价“偏低 / 中等 / 较高”。是否够用只能在配队推荐阶段结合角色、队伍、产球和循环上下文判断。

## UI 行为

### 元素图标

- `ElementIcon` 保留现有 React API：`element`、`size`、`className`。
- 内部实现从自绘 SVG 切换为官方 PNG `<img>`。
- 图标在筛选栏和角色事实行中保持原有尺寸与可访问文本；图片本身为装饰，语义继续由旁边的元素名称提供。

### 角色头像

- `CharacterPortrait` 优先渲染 `character.imageUrl`。
- 仅接受 `gtai-img://avatar/...` 与 `gtai-img://remote/...`，避免绕过既有 Renderer 外部 IO 边界。
- 使用 `loading="lazy"`、`decoding="async"`；加载失败后退回当前首字占位。
- 头像使用 `object-fit: cover`，保留现有切角卡片轮廓。

### 充能信息

- 卡片标签从“关键提示”改为“充能效率”。
- 有有效数据时显示 `117.5% · 是否够用需结合角色、队伍产球与实战循环判断。`
- 无有效数据时显示 `暂无可靠面板数据。`
- 删除 `ENERGY_RECHARGE_THRESHOLDS`、`EnergyRechargeBand` 与 `classifyEnergyRecharge`，防止其他调用方继续复用错误结论。

## 验收标准

- 七个官方图标文件均存在、PNG 头有效，且 SHA-256 与 manifest 一致。
- `ElementIcon` 生成本地 PNG 图片标签，不再包含旧 `ElementShape`。
- 有合法代理头像 URL 时卡片输出 `<img>`；空 URL、非法 URL或加载失败时保留占位。
- 任意数值的充能效率都不会生成“偏低 / 中等 / 较高”结论。
- 中文和英文文案同步更新。
- `npm run gate:local` 通过；Roster Electron E2E 验证头像可见、文本无旧评价，并更新受影响的视觉基线。

