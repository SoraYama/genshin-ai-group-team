# 原神 AI 配队 Web SPA 技术方案（全栈 JS）

> 适用范围：**中国大陆用户**，SPA + 后端 API + LLM 推荐；数据获取采用“米游社 Cookie 手动输入 + 社区数据 + 手动微调 + 本地缓存”。

---

## 1. 目标与约束

### 目标
- 单页应用（SPA）展示角色、圣遗物、配队建议。
- 支持**米游社 Cookie 手动输入**获取用户数据 + 用户手动微调。
- 当期敌人数据来自社区公开数据源。
- LLM 在后端推理，输出推荐队伍 + 解释。

### 关键约束（CN 合规）
- **不提供账号登录/OAuth**，仅用户手动输入 Cookie。
- Cookie **不存前端**，仅后端短期加密缓存。
- 不使用版权不明的 UI 资源；**不得盗用原神素材**。

---

## 2. 技术栈（全栈 JS）

### 前端
- Vite + React + TypeScript
- 状态管理：Zustand + 持久化中间件（localStorage / IndexedDB）
- UI：自研主题 + Tailwind CSS（可选：vanilla-extract）
- 图像：角色立绘使用公开资源或用户提供图链接

### 后端
- Node.js + Fastify（或 Express）
- 数据缓存：Redis（优先），无 Redis 时用内存 LRU
- HTTP 客户端：undici / axios
- API 文档：OpenAPI (Swagger)

### LLM
- 智谱 AI（国内版，后端调用）

---

## 3. 数据源与可用性

### 用户数据（米游社）
- **入口方式**：用户在前端输入 Cookie（ltoken/ltuid 等），后端代理调用米游社接口。
- **风险**：非官方接口、风控严格、随时变更。
- **处理**：仅后端使用，短期加密缓存，失败时要求重新输入。

### 社区公开数据
- **genshin-db（MIT）**：角色/武器/圣遗物/怪物数据
  - https://github.com/theBowja/genshin-db
- **Project Amber**：深渊楼层/敌人
  - https://gi.yatta.moe
- **AnimeGameData**：原始数据（如需）
  - https://github.com/DimbreathBot/AnimeGameData

> 注：部分社区源可能**无明确商业许可**，上线前需二次法务确认或替换为授权来源。

---

## 4. 系统架构

```
[Web SPA]
  ├─ Cookie 手动输入 + UID 绑定
  ├─ 角色/圣遗物展示 + 手动微调
  ├─ 本地缓存（IndexedDB/LocalStorage）
  └─ 调用后端 API 进行推荐

[Backend API]
  ├─ /api/mys/import (米游社代理)
  ├─ /api/enemy/current (敌人数据)
  ├─ /api/ai/recommend (LLM 推荐)
  └─ /api/health (外部 API 连通测试)
```

---

## 5. 数据模型（简化）

```ts
type Element = 'anemo' | 'cryo' | 'dendro' | 'electro' | 'geo' | 'hydro' | 'pyro';

interface CharacterStats {
  level: number;
  hp: number;
  atk: number;
  def: number;
  critRate: number;
  critDmg: number;
  energyRecharge: number;
  elementalMastery: number;
}

interface Artifact {
  slot: 'flower' | 'plume' | 'sands' | 'goblet' | 'circlet';
  mainStat: string;
  subStats: Array<{ key: string; value: number }>
  setName: string;
  level: number;
  rarity: 4 | 5;
}

interface CharacterProfile {
  id: number;
  name: string;
  element: Element;
  weaponType: string;
  rarity: 4 | 5;
  stats: CharacterStats;
  artifacts: Artifact[];
}

interface RecommendationInput {
  characters: CharacterProfile[];
  enemySeason: string;
  enemyList: Array<{ id: string; name: string; element?: Element; tags?: string[] }>;
  userPreference?: { playstyle?: string; avoid?: string[] };
}
```

---

## 6. API 设计（概要）

### 6.1 `/api/mys/import`
**输入**：Cookie（后端接收）
**输出**：角色/武器/圣遗物结构化数据（归一化）
**缓存**：按 UID + 账号 hash 缓存 1h

### 6.2 `/api/enemy/current`
**输出**：当期敌人配置（手动维护/社区数据）

### 6.3 `/api/ai/recommend`
**输入**：RecommendationInput
**输出**：推荐队伍（2-3套）+ 解释

### 6.4 `/api/health`
**目的**：外部依赖连通测试
- Enka（若作为公开展示补充）
- genshin-db / Project Amber
- 智谱 AI API
- Miyoushe（仅在用户提供 Cookie 时可测）

---

## 7. 测试与“外部 API 打通”约束

**要求**：所有外部 API 连通性必须通过测试后，才进入下一阶段开发。

### 7.1 连接性测试（必须）
- `health:genshin-db`：可用性 + 延迟 < 2s
- `health:enemy-data`：Project Amber 或替代源返回 200
- `health:llm`：智谱 API 请求成功
- `health:miyoushe`：必须依赖用户手动 Cookie

### 7.2 自动化测试
- API 集成测试：使用 Vitest / Jest + nock（仅模拟）
- E2E 连接测试：真实调用外部 API（带速率限制）
- 测试失败 → 阻止后续功能开发

---

## 8. UI/UX 方案（Genshin 风格还原）

### 8.1 字体（合规替代）
> 原神 UI 常见字体为 HYWenHei 系列（商用授权不确定）
**推荐替代（合法商用）**：
- **Source Han Serif / Noto Serif CJK (OFL 1.1)**
- **LXGW WenKai (OFL 1.1)**

示例：
```css
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap');

:root {
  --font-title: "Noto Serif SC", serif;
  --font-body: "Noto Serif SC", serif;
}
```

### 8.2 色彩与氛围
基调：深蓝灰背景 + 金色点缀 + 冷色高光
```css
:root {
  --bg-dark: #2a2d37;
  --bg-mid: #3e4d60;
  --accent-gold: #f7b769;
  --accent-blue: #a4d5e5;
  --text-light: #e9eef2;
}
```

### 8.3 组件外观
- **角色卡片**：玻璃拟态 + 金色描边 + 角色立绘
- **信息面板**：半透明深色面板 + 白色/淡金标题
- **按钮**：斜角框体 + 轻微内阴影
- **布局**：左侧角色列表 + 右侧详情

### 8.4 参考项目
- Genshin Optimizer（大规模 SPA 结构）
- Genshin-Calc（Enka 导入 + 视觉风格）
- Team Randomizer（角色选择 UI）

---

## 9. 开发阶段划分

### Phase 1：外部 API 打通（强约束）
- 完成 `health` 测试
- 完成 cookie 代理
- 完成 LLM API 调通

### Phase 2：前端角色展示
- 角色列表 + 信息卡
- 角色立绘展示
- 手动微调面板

### Phase 3：AI 推荐输出
- 后端 LLM prompt pipeline
- 推荐结果 UI + 解释

---

## 10. 风险与缓解

- **米游社接口不可用** → 提供手动导入/缓存数据
- **社区数据许可不明** → 替换为授权数据
- **LLM 不稳定** → 增加 fallback（规则引擎）
- **前端风格侵权风险** → 只还原风格，不使用原版素材

---

## 11. 下一步

- 明确 Phase 1 测试清单
- 实现 `health` 端点 + CI 阶段阻断
- 开始 UI 组件库搭建（Genshin 风格主题）
