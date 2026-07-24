# Knowledge-Grounded Advisor Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让深境螺旋配队以本地可信攻略知识和角色当前 build 为依据，只在知识缺口时使用 Web Search，并让用户在单个桌面视口中完成约束、场景、结果和最近一次模型原文的检查。

**Architecture:** 在现有本地可行解与五阶段 Agent 管线之间加入 `BuildInterpreter → KnowledgeBundleStore → CoverageGate → GuideResearchAgent`，产出所有阶段共享的 `KnowledgeContextPacket`。可信知识只来自版本化资源文件，Web Search 结果只进入 24 小时临时缓存；每次运行同时写入仅存内存的 `AgentRunTraceStore`。Renderer 通过白名单 IPC 按需读取最新 trace，并把深渊页改成上方双栏、下方结果的固定工作台，角色页改成头像矩阵和右侧详情抽屉。

**Tech Stack:** Electron 43、React 19、TypeScript 5.8、Zod 4、Claude Agent SDK 0.3、Vitest、Playwright、Vite、tsup。

---

## 实施约束

- 只先完成 `spiral-abyss`，但共享类型和服务不得绑定深渊专属 UI。
- Renderer 不直接联网；ResearchAgent 只运行在 Main。
- `WebSearch` 只允许在 `research` 阶段，单次推荐最多三次调用；`WebFetch` 始终禁止。
- 搜索任务不得包含 UID、昵称、完整属性或任何凭据。
- 搜索结果不得写入 `resources/knowledge`，也不得增加可信 coverage。
- 最近一次 trace 只在内存中保存，不写入 HistoryStore。
- 默认尊重当前 build；换装只能作为可选建议。若方案必须换装才能成立，状态必须是 `requires-adjustment`。
- 每个实现任务都先运行指定测试观察失败，再实现，再观察通过；不跳过 red/green 证据。

## Task 1: 建立可信知识、build 解释和运行记录的共享契约

**Files:**

- Create: `src/shared/advisor-knowledge.ts`
- Create: `src/shared/agent-run-trace.ts`
- Modify: `src/main/agents/contracts.ts`
- Modify: `src/shared/abyss-advisor.ts`
- Test: `tests/unit/shared/advisor-knowledge.spec.ts`
- Test: `tests/unit/shared/agent-run-trace.spec.ts`

- [ ] **Step 1: 写知识 schema 的失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  characterStrategyBundleSchema,
  knowledgeContextPacketSchema,
  sourceRegistrySchema
} from '../../../src/shared/advisor-knowledge.js';

describe('advisor knowledge contracts', () => {
  it('rejects a strategy fact without a registered citation', () => {
    const result = characterStrategyBundleSchema.safeParse({
      schemaVersion: 2,
      knowledgeVersion: '2026-07-24',
      reviewedAt: '2026-07-24T00:00:00+08:00',
      characters: [{
        id: '10000052',
        name: '雷电将军',
        baseRoles: ['on-field', 'off-field'],
        archetypes: [{
          id: 'em-hyperbloom',
          role: 'off-field',
          signals: [{ field: 'elementalMastery', op: 'gte', value: 700 }],
          environments: ['hyperbloom'],
          teammateSlots: ['dendro-applier', 'hydro-applier', 'flex'],
          facts: [{ text: '高精通配置优先视为超绽放触发位', citationIds: ['missing'] }]
        }],
        unknowns: []
      }]
    });
    expect(result.success).toBe(false);
  });

  it('keeps trusted and ephemeral coverage separate', () => {
    const packet = knowledgeContextPacketSchema.parse({
      knowledgeVersion: '2026-07-24',
      buildInterpretations: [],
      trustedMatches: [],
      ephemeralMatches: [],
      unknowns: [{ kind: 'character', key: '10000133', reason: 'missing' }],
      coverage: { requested: 1, trusted: 0, ephemeral: 0, unknown: 1 },
      citations: []
    });
    expect(packet.coverage.trusted).toBe(0);
  });
});
```

- [ ] **Step 2: 写 trace 脱敏与字节上限的失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { agentRunTraceSchema, sanitizeTraceText } from '../../../src/shared/agent-run-trace.js';

describe('agent run trace contracts', () => {
  it('redacts secrets and marks truncation', () => {
    const value = sanitizeTraceText(
      'Authorization: Bearer secret-token\napiKey=sk-ant-secret\n' + '原文'.repeat(20_000),
      2_048
    );
    expect(value.text).not.toContain('secret-token');
    expect(value.text).not.toContain('sk-ant-secret');
    expect(value.truncated).toBe(true);
    expect(Buffer.byteLength(value.text, 'utf8')).toBeLessThanOrEqual(2_048);
  });

  it('requires an explicit source once a trace is terminal', () => {
    expect(agentRunTraceSchema.safeParse({
      correlationId: 'run-1',
      startedAt: '2026-07-24T00:00:00+08:00',
      status: 'completed',
      model: 'claude-sonnet-5',
      stages: [],
      knowledge: { trusted: 0, ephemeral: 0, unknown: 0, searched: false },
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    }).success).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试并确认因为模块不存在而失败**

Run:

```bash
npx vitest run tests/unit/shared/advisor-knowledge.spec.ts tests/unit/shared/agent-run-trace.spec.ts
```

Expected: FAIL，提示无法解析 `advisor-knowledge.js` 和 `agent-run-trace.js`。

- [ ] **Step 4: 实现严格共享契约**

`src/shared/advisor-knowledge.ts` 至少导出以下 schema 和推导类型：

```ts
export const knowledgeTrustSchema = z.enum(['trusted-local', 'ephemeral-web']);
export const sourceCitationSchema = z.object({
  id: z.string().trim().min(1).max(96),
  sourceId: z.string().trim().min(1).max(64),
  url: z.url(),
  title: z.string().trim().min(1).max(160),
  reviewedAt: z.iso.datetime({ offset: true }),
  trust: knowledgeTrustSchema
}).strict();

export const buildInterpretationSchema = z.object({
  characterId: canonicalCharacterIdSchema,
  archetypeId: z.string().trim().min(1).max(80).nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  matchedSignals: z.array(z.string().trim().min(1).max(160)).max(12),
  conflictingSignals: z.array(z.string().trim().min(1).max(160)).max(12),
  currentBuildUsable: z.boolean(),
  adjustment: z.enum(['none', 'optional', 'required']),
  unknowns: z.array(z.string().trim().min(1).max(200)).max(12)
}).strict();

export const knowledgeContextPacketSchema = z.object({
  knowledgeVersion: z.string().trim().min(1).max(80),
  buildInterpretations: z.array(buildInterpretationSchema).max(128),
  trustedMatches: z.array(trustedKnowledgeMatchSchema).max(256),
  ephemeralMatches: z.array(ephemeralGuideMatchSchema).max(64),
  unknowns: z.array(knowledgeGapSchema).max(128),
  coverage: z.object({
    requested: z.number().int().nonnegative(),
    trusted: z.number().int().nonnegative(),
    ephemeral: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative()
  }).strict(),
  citations: z.array(sourceCitationSchema).max(256)
}).strict();
```

Schema 的 `superRefine` 必须验证：

- 每条 fact 的 `citationIds` 都能在 bundle 内解析；
- source registry 的 URL host 与声明域一致；
- character、archetype、mechanic、citation ID 唯一；
- coverage 四个计数自洽；
- `ephemeral-web` citation 不得出现在可信 bundle。

`src/shared/agent-run-trace.ts` 至少定义：

```ts
export const agentFailureCodeSchema = z.enum([
  'AGENT_ABORTED',
  'AGENT_TIMEOUT',
  'SDK_START_FAILED',
  'PROVIDER_ERROR',
  'SEARCH_UNAVAILABLE',
  'SEARCH_BUDGET_EXCEEDED',
  'SEARCH_OUTPUT_INVALID',
  'TOOL_REQUIREMENT_FAILED',
  'AGENT_OUTPUT_INVALID',
  'VALIDATION_FAILED'
]);

export const agentStageNameSchema = z.enum([
  'knowledge',
  'research',
  'compose',
  'repair-1',
  'repair-2',
  'critique',
  'rotation',
  'explain'
]);
```

`AgentStageTrace` 记录 `status`、`inputSummary`、`rawOutput`、`tools`、`citationIds`、`usage`、`durationMs`、`failure` 和 `truncated`。`AgentRunTrace` 使用运行态/终态 discriminated union：`status: running` 时允许没有 `finalSource`，`status: completed | failed` 时必须有 `smart-service | local-rules | blocked`。`sanitizeTraceText` 以 UTF-8 字节截断，至少脱敏 `apiKey`、`Authorization`、`Cookie`、`ANTHROPIC_AUTH_TOKEN`、自定义 header 值和 Bearer token。

- [ ] **Step 5: 扩展 Agent 上下文和深渊结果摘要**

把 `v2PipelineContextSchema.knowledge` 从 `version + unknownCharacterIds` 改为：

```ts
knowledge: knowledgeContextPacketSchema
```

在 `abyssAdvisorProgressStepSchema` 增加 `interpreting-builds`、`checking-knowledge`、`researching-guides`；在结果公共字段增加：

```ts
knowledgeSummary: z.object({
  trusted: z.number().int().nonnegative(),
  ephemeral: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  searched: z.boolean()
}).strict()
```

`blocked()` 和所有现有 fixture 显式传入零值摘要，避免以 optional 隐藏迁移遗漏。

- [ ] **Step 6: 运行测试与类型检查**

Run:

```bash
npx vitest run tests/unit/shared/advisor-knowledge.spec.ts tests/unit/shared/agent-run-trace.spec.ts tests/unit/shared/abyss-advisor.spec.ts tests/unit/services/v2-agent-context.spec.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: 提交契约**

```bash
git add src/shared/advisor-knowledge.ts src/shared/agent-run-trace.ts src/shared/abyss-advisor.ts src/main/agents/contracts.ts tests/unit/shared/advisor-knowledge.spec.ts tests/unit/shared/agent-run-trace.spec.ts tests/unit/shared/abyss-advisor.spec.ts tests/unit/services/v2-agent-context.spec.ts
git commit -m "feat: define advisor knowledge and trace contracts"
```

## Task 2: 建立全角色索引和版本化可信来源清单

**Files:**

- Create: `resources/knowledge/sources.v1.json`
- Create: `resources/knowledge/character-catalog.v1.json`
- Create: `resources/knowledge/character-strategies.v2.json`
- Modify: `resources/credits.md`
- Modify: `electron-builder.json`
- Create: `tests/unit/knowledge/committed-bundles.spec.ts`
- Create: `tests/unit/knowledge/source-policy.spec.ts`

- [ ] **Step 1: 写提交资源的失败测试**

测试直接读取三个 JSON，并验证：

```ts
const catalog = characterCatalogBundleSchema.parse(readJson('character-catalog.v1.json'));
const strategies = characterStrategyBundleSchema.parse(readJson('character-strategies.v2.json'));
const sources = sourceRegistrySchema.parse(readJson('sources.v1.json'));

expect(new Set(strategies.characters.map(({ id }) => id)))
  .toEqual(new Set(catalog.characters.map(({ id }) => id)));
expect(catalog.characters.length).toBeGreaterThanOrEqual(112);
expect(strategies.characters.every(({ baseRoles, archetypes }) =>
  baseRoles.length > 0 && archetypes.length > 0
)).toBe(true);
expect(sources.sources.map(({ host }) => host).sort()).toEqual([
  'genshin.hoyoverse.com',
  'hoyolab.com',
  'keqingmains.com',
  'kqm.gg',
  'library.keqingmains.com'
]);
```

再断言 `resources/credits.md` 包含每个 source ID 和“攻略事实为摘要改写，不复制攻略正文”的说明。

- [ ] **Step 2: 运行测试并确认资源缺失**

Run:

```bash
npx vitest run tests/unit/knowledge/committed-bundles.spec.ts tests/unit/knowledge/source-policy.spec.ts
```

Expected: FAIL，缺少三个资源文件。

- [ ] **Step 3: 写来源清单**

`sources.v1.json` 只允许以下首批来源：

```json
{
  "schemaVersion": 1,
  "sourceVersion": "2026-07-24",
  "sources": [
    {
      "id": "kqm",
      "name": "KeqingMains",
      "host": "keqingmains.com",
      "trust": "trusted-local",
      "reviewCadenceDays": 180
    },
    {
      "id": "kqm-library",
      "name": "KQM Theorycrafting Library",
      "host": "library.keqingmains.com",
      "trust": "trusted-local",
      "reviewCadenceDays": 180
    },
    {
      "id": "kqm-short",
      "name": "KQM Short Domain",
      "host": "kqm.gg",
      "trust": "trusted-local",
      "reviewCadenceDays": 180
    },
    {
      "id": "hoyolab",
      "name": "HoYoLAB",
      "host": "hoyolab.com",
      "trust": "trusted-local",
      "reviewCadenceDays": 90
    },
    {
      "id": "genshin-official",
      "name": "Genshin Impact Official",
      "host": "genshin.hoyoverse.com",
      "trust": "trusted-local",
      "reviewCadenceDays": 365
    }
  ]
}
```

- [ ] **Step 4: 写全角色目录**

使用 Enka 角色元数据的 canonical ID、元素和名称哈希，结合 Enka `loc.json` 生成中文名；武器类型由已引用的角色策略复核后写入静态目录。两份上游快照都要记录 URL、获取时间和摘要，生成器必须从各自快照字节计算摘要后再序列化：

```ts
const catalog = characterCatalogBundleSchema.parse({
  schemaVersion: 1,
  catalogVersion: 'enka-2026-07-24',
  sources: [
    {
      url: ENKA_CHARACTER_METADATA_URL,
      retrievedAt: retrievedAt.toISOString(),
      sha256: createHash('sha256').update(characterSnapshotBytes).digest('hex')
    },
    {
      url: ENKA_LOCALIZATION_URL,
      retrievedAt: retrievedAt.toISOString(),
      sha256: createHash('sha256').update(localizationSnapshotBytes).digest('hex')
    }
  ],
  characters: normalizedPlayableCharacters
});
```

提交的 JSON 必须含计算后的 64 位小写 SHA-256；schema 和资源测试拒绝非 64 位小写十六进制值。目录覆盖当前元数据中的所有可玩角色；旅行者不同元素形态归一到同一 canonical 角色并在 `aliases` 中记录。

- [ ] **Step 5: 写每个角色的保守基础策略**

每个 catalog ID 必须有且只有一条策略，至少包含：

- 可确认的 `baseRoles`；
- 一个保守 archetype；
- `environments`；
- `teammateSlots`；
- `unknowns`；
- 每条事实的 citation。

不确定的数据写入 `unknowns`，不能推测填满。单流派条目采用：

```json
{
  "id": "10000032",
  "name": "班尼特",
  "baseRoles": ["support", "sustain"],
  "archetypes": [
    {
      "id": "burst-support",
      "role": "support",
      "signals": [
        { "field": "energyRecharge", "op": "gte", "value": 180 }
      ],
      "environments": ["attack-scaling-team", "healing-required"],
      "teammateSlots": ["on-field-damage", "off-field-damage", "flex"],
      "facts": [
        {
          "text": "元素爆发同时承担增益、治疗和火元素附着相关职责",
          "citationIds": ["kqm-bennett-guide"]
        }
      ]
    }
  ],
  "unknowns": []
}
```

- [ ] **Step 6: 对五个多流派角色写可判别策略**

将已经调研的差异落成原子事实和 build signals：

- 雷电将军：`em-hyperbloom` 与 `emblem-on-field`；
- 久岐忍：`em-hyperbloom` 与 `healer-quicken`；
- 纳西妲：`on-field-driver` 与 `off-field-dendro`；
- 珊瑚宫心海：`bloom-trigger`、`off-field-healer`、`on-field-driver`；
- 芙宁娜：`off-field-fanfare`，并记录全队治疗和循环压力。

雷电将军条目的核心结构：

```json
{
  "id": "10000052",
  "name": "雷电将军",
  "baseRoles": ["on-field", "off-field"],
  "archetypes": [
    {
      "id": "em-hyperbloom",
      "role": "off-field",
      "signals": [
        { "field": "elementalMastery", "op": "gte", "value": 700 },
        { "field": "artifactMainStats", "op": "contains-count", "value": "ELEMENT_MASTERY", "count": 2 }
      ],
      "environments": ["hyperbloom", "single-target", "low-field-time"],
      "teammateSlots": ["dendro-applier", "hydro-applier", "flex"],
      "facts": [{
        "text": "高精通配置在超绽放队中承担后台雷触发职责",
        "citationIds": ["kqm-raiden-quickguide"]
      }]
    },
    {
      "id": "emblem-on-field",
      "role": "on-field",
      "signals": [
        { "field": "artifactSet", "op": "equals", "value": "绝缘之旗印", "count": 4 },
        { "field": "energyRecharge", "op": "gte", "value": 200 }
      ],
      "environments": ["burst-cycle", "energy-support", "frontloaded-damage"],
      "teammateSlots": ["buffer", "off-field-damage", "sustain"],
      "facts": [{
        "text": "充能与双暴配置以元素爆发站场和全队循环为核心",
        "citationIds": ["kqm-raiden-quickguide"]
      }]
    }
  ],
  "unknowns": []
}
```

只做摘要改写，不复制 KQM 原文。引用 URL 使用已审核页面：

- `https://keqingmains.com/q/raiden-quickguide/`
- `https://keqingmains.com/q/shinobu-quickguide/`
- `https://keqingmains.com/q/nahida-quickguide/`
- `https://keqingmains.com/q/kokomi-quickguide/`
- `https://keqingmains.com/q/furina-quickguide/`

- [ ] **Step 7: 更新打包和 credits**

确认 `electron-builder.json` 的 `resources/knowledge/**/*.json` 已覆盖新增文件，并在 `resources/credits.md` 记录 Enka 元数据、KQM 页面、访问日期、用途和改写政策。

- [ ] **Step 8: 运行资源测试**

Run:

```bash
npx vitest run tests/unit/knowledge/committed-bundles.spec.ts tests/unit/knowledge/source-policy.spec.ts
```

Expected: PASS，角色数与策略数相等，来源 host 固定，所有 citation 可解析。

- [ ] **Step 9: 提交可信知识资源**

```bash
git add resources/knowledge resources/credits.md electron-builder.json tests/unit/knowledge
git commit -m "feat: add versioned trusted team knowledge"
```

## Task 3: 实现 KnowledgeBundleStore 和当前 build 解释

**Files:**

- Create: `src/main/services/knowledge-bundle-store.ts`
- Create: `src/main/services/build-interpreter.ts`
- Modify: `src/main/services/advisor-profile-serializer.ts`
- Modify: `src/main/index.ts`
- Test: `tests/unit/services/knowledge-bundle-store.spec.ts`
- Test: `tests/unit/services/build-interpreter.spec.ts`
- Modify: `tests/unit/services/advisor-profile-serializer.spec.ts`

- [ ] **Step 1: 写 Store 和多流派解释的失败测试**

```ts
it.each([
  ['雷电将军', emRaiden, 'em-hyperbloom'],
  ['雷电将军', emblemRaiden, 'emblem-on-field'],
  ['久岐忍', emKuki, 'em-hyperbloom'],
  ['纳西妲', offFieldNahida, 'off-field-dendro'],
  ['珊瑚宫心海', bloomKokomi, 'bloom-trigger'],
  ['芙宁娜', erFurina, 'off-field-fanfare']
])('interprets %s build', (_name, character, expected) => {
  const result = interpreter.interpret(character);
  expect(result.archetypeId).toBe(expected);
  expect(result.currentBuildUsable).toBe(true);
  expect(result.matchedSignals.length).toBeGreaterThan(0);
});

it('returns an explicit low-confidence unknown instead of guessing', () => {
  expect(interpreter.interpret(basicOnlyCharacter)).toMatchObject({
    archetypeId: null,
    confidence: 'low',
    currentBuildUsable: false,
    adjustment: 'optional'
  });
});
```

Store 测试还要覆盖按角色、archetype、机制标签检索，以及对超期和 citation 丢失的拒绝。

- [ ] **Step 2: 运行失败测试**

Run:

```bash
npx vitest run tests/unit/services/knowledge-bundle-store.spec.ts tests/unit/services/build-interpreter.spec.ts tests/unit/services/advisor-profile-serializer.spec.ts
```

Expected: FAIL，服务不存在或 serializer 缺少解释所需字段。

- [ ] **Step 3: 实现 KnowledgeBundleStore**

服务一次性加载四份 bundle：source registry、catalog、character strategies、enemy mechanism strategies。公开接口：

```ts
export interface AdvisorKnowledgeReader {
  readonly version: string;
  getCharacterStrategy(characterId: string): CharacterStrategy | undefined;
  getArchetype(characterId: string, archetypeId: string): CharacterArchetype | undefined;
  queryMechanics(tags: string[]): EnemyMechanicStrategy[];
  citations(ids: string[]): SourceCitation[];
  coverageFor(input: {
    characterIds: string[];
    mechanicTags: string[];
    now: Date;
  }): TrustedKnowledgeCoverage;
}
```

加载时 fail fast；任何 schema、citation、目录 coverage 错误都阻止应用以“可信知识已加载”启动。生产路径改为 `resolveBundledKnowledgeDir()`，不再只解析 `characters.v1.json`。

- [ ] **Step 4: 扩充 build 安全序列化**

在 `AdvisorArtifactSummary` 中保留标准化 set ID/name、套装件数、沙/杯/冠主词条；weapon 增加可确认的 weapon ID/type（若 domain 有值），没有则保持 unknown。不得把 artifact 副词条原始数组无界塞入 prompt。

- [ ] **Step 5: 实现 BuildInterpreter**

实现确定性信号评分：

```ts
const score = matchedRequired * 4 + matchedOptional * 2 - conflicts * 5;
```

规则：

- required signal 冲突时该 archetype 不可选；
- 最高分并列时返回低置信度和冲突列表；
- build 缺失时不猜测；
- 当前 build 不匹配但存在 archetype 时返回 `adjustment: optional`；
- 只有用户显式允许换装且无当前 build 可行 archetype 时，才能返回 `adjustment: required`；
- 默认 `noBuildChange` 下，required adjustment 的角色不得作为推荐成立前提。

- [ ] **Step 6: 在 Main 启动时注入知识 Store**

`src/main/index.ts` 加载 `KnowledgeBundleStore`，把旧 `CharacterKnowledgeStore` 适配到新 Reader 或迁移调用方。先只把新 Store 注入深渊 advisor；剧诗和幽境继续使用旧兼容 reader，直到后续迁移。

- [ ] **Step 7: 运行局部测试和类型检查**

Run:

```bash
npx vitest run tests/unit/services/knowledge-bundle-store.spec.ts tests/unit/services/build-interpreter.spec.ts tests/unit/services/advisor-profile-serializer.spec.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 8: 提交 Store 与解释器**

```bash
git add src/main/services/knowledge-bundle-store.ts src/main/services/build-interpreter.ts src/main/services/advisor-profile-serializer.ts src/main/index.ts tests/unit/services/knowledge-bundle-store.spec.ts tests/unit/services/build-interpreter.spec.ts tests/unit/services/advisor-profile-serializer.spec.ts
git commit -m "feat: interpret roster builds against trusted knowledge"
```

## Task 4: 建立怪物机制策略和 KnowledgeContextPacket

**Files:**

- Create: `resources/knowledge/enemy-mechanic-strategies.v1.json`
- Create: `src/main/services/advisor-knowledge-service.ts`
- Create: `src/main/services/knowledge-coverage-gate.ts`
- Modify: `src/main/services/v2-agent-context.ts`
- Test: `tests/unit/services/advisor-knowledge-service.spec.ts`
- Test: `tests/unit/services/knowledge-coverage-gate.spec.ts`
- Modify: `tests/unit/services/v2-agent-context.spec.ts`

- [ ] **Step 1: 写机制映射与 coverage gate 的失败测试**

```ts
it.each([
  ['elemental-shield', 'shield-breaking'],
  ['high-resistance', 'resistance-avoidance'],
  ['multi-wave', 'wave-efficient-rotation'],
  ['groupable', 'grouping-value'],
  ['single-target', 'single-target-pressure'],
  ['survival-pressure', 'sustain-required']
])('maps %s to %s', (tag, strategyId) => {
  expect(service.buildPacket(inputWithMechanic(tag)).trustedMatches)
    .toContainEqual(expect.objectContaining({ strategyId }));
});

it('does not research when trusted knowledge is complete', () => {
  expect(gate.evaluate(completePacket)).toEqual({ required: false, tasks: [] });
});

it.each(['missing', 'stale', 'conflict', 'build-unmatched'] as const)(
  'requests anonymous research for %s coverage',
  (reason) => {
    const decision = gate.evaluate(packetWithGap(reason));
    expect(decision.required).toBe(true);
    expect(JSON.stringify(decision.tasks)).not.toContain('123456789');
  }
);
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run tests/unit/services/advisor-knowledge-service.spec.ts tests/unit/services/knowledge-coverage-gate.spec.ts tests/unit/services/v2-agent-context.spec.ts
```

Expected: FAIL。

- [ ] **Step 3: 写机制知识 bundle**

每条机制策略包含 `matchTags`、`avoidTags`、`requiredCapabilities`、`preferredArchetypes`、`teamSkeletonHints`、`facts` 和 citation。至少覆盖：

- 元素盾与破盾；
- 高抗性与免疫规避；
- 多波次与循环复位；
- 聚怪价值与不可聚怪；
- 单体压力；
- 生存压力和抗打断；
- 移动/钻地/短输出窗口；
- 元素附着或反应限制。

机制条目不硬编码具体四人队，只给队伍骨架和能力约束。

- [ ] **Step 4: 实现 AdvisorKnowledgeService**

输入只接受已校验 profile、scenario target、candidate IDs 和 preferences；输出严格解析的 `KnowledgeContextPacket`。流程：

1. 对候选角色调用 `BuildInterpreter`；
2. 按角色/archetype 查本地策略；
3. 将场景 mechanic tags 归一化后匹配机制策略；
4. 合并 citation 并去重；
5. 明确产生 `missing | stale | conflict | build-unmatched` gap；
6. 计算可信 coverage，临时 coverage 初始为 0。

- [ ] **Step 5: 实现 CoverageGate**

Research task schema：

```ts
export const guideResearchTaskSchema = z.object({
  key: z.string().trim().min(1).max(160),
  reason: z.enum(['missing', 'stale', 'conflict', 'build-unmatched']),
  character: z.object({
    name: z.string().trim().min(1).max(80),
    element: z.string().trim().min(1).max(24),
    weaponType: weaponTypeSchema.optional(),
    buildSignals: z.array(z.string().trim().min(1).max(120)).max(12)
  }).strict().optional(),
  scenarioTags: z.array(z.string().trim().min(1).max(80)).max(24)
}).strict();
```

构造任务时只拷贝白名单字段。单测使用 UID、昵称、Cookie 和 Authorization 哨兵，确认序列化任务中均不存在。

- [ ] **Step 6: 把完整 packet 放入 V2 context**

`buildV2PipelineContext` 接收 `knowledge: KnowledgeContextPacket`，按字节预算压缩但不得丢失：

- 已选 baseline 八人的 build interpretation；
- 当前目标房间机制；
- 所有引用到的 citation；
- unknown gap。

超预算时先裁剪未选候选角色，再裁剪低优先级 facts，且在 `unknowns` 加入 `payload-truncated`，不能静默截断。

- [ ] **Step 7: 运行测试**

Run:

```bash
npx vitest run tests/unit/services/advisor-knowledge-service.spec.ts tests/unit/services/knowledge-coverage-gate.spec.ts tests/unit/services/v2-agent-context.spec.ts tests/unit/knowledge/committed-bundles.spec.ts
```

Expected: PASS。

- [ ] **Step 8: 提交机制与 packet**

```bash
git add resources/knowledge/enemy-mechanic-strategies.v1.json src/main/services/advisor-knowledge-service.ts src/main/services/knowledge-coverage-gate.ts src/main/services/v2-agent-context.ts tests/unit/services/advisor-knowledge-service.spec.ts tests/unit/services/knowledge-coverage-gate.spec.ts tests/unit/services/v2-agent-context.spec.ts tests/unit/knowledge/committed-bundles.spec.ts
git commit -m "feat: build scenario-aware advisor knowledge packets"
```

## Task 5: 实现 24 小时临时攻略缓存

**Files:**

- Create: `src/main/services/guide-research-cache.ts`
- Modify: `src/main/services/data-management-service.ts`
- Test: `tests/unit/services/guide-research-cache.spec.ts`
- Modify: `tests/unit/services/data-management-service.spec.ts`

- [ ] **Step 1: 写缓存隔离的失败测试**

```ts
it('expires entries after 24 hours and never reports trusted coverage', async () => {
  const cache = await GuideResearchCache.open(file, { now: () => start });
  await cache.put(task, ephemeralPacket);
  expect((await cache.get(task))?.trust).toBe('ephemeral-web');
  clock.advanceBy(24 * 60 * 60 * 1000 + 1);
  expect(await cache.get(task)).toBeUndefined();
});

it('writes only under userData cache', async () => {
  await cache.put(task, ephemeralPacket);
  expect(writes).toEqual([path.join(userData, 'cache', 'guide-research.json')]);
  expect(writes.some((file) => file.includes('resources/knowledge'))).toBe(false);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run tests/unit/services/guide-research-cache.spec.ts tests/unit/services/data-management-service.spec.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现原子缓存**

Key 为 `sha256(canonicalJson({ task, knowledgeVersion }))`。文件格式含 `schemaVersion`、`entries`、`createdAt`、`expiresAt`，写临时文件后 rename。读取时：

- schema 错误返回空缓存并保留稳定错误日志；
- 自动丢弃过期条目；
- 每项显式 `trust: ephemeral-web`；
- 上限 100 项和 2 MiB，超限按最旧条目淘汰；
- 不缓存搜索原始 SDK message，只缓存已校验摘要和 URL。

- [ ] **Step 4: 接入数据清理**

`DataManagementService` 清理场景缓存时同步清理 `cache/guide-research.json`，summary 中显示临时攻略缓存的条目数和字节数，但不把内容返回 Renderer。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
npx vitest run tests/unit/services/guide-research-cache.spec.ts tests/unit/services/data-management-service.spec.ts
```

Expected: PASS。

```bash
git add src/main/services/guide-research-cache.ts src/main/services/data-management-service.ts tests/unit/services/guide-research-cache.spec.ts tests/unit/services/data-management-service.spec.ts
git commit -m "feat: add isolated ephemeral guide research cache"
```

## Task 6: 给 SDK 增加唯一、限额的 Web Search 研究阶段

**Files:**

- Create: `src/main/agents/research/prompt.ts`
- Create: `src/main/services/guide-research-agent.ts`
- Modify: `src/main/services/agent-sdk-adapter.ts`
- Modify: `src/main/services/agent-turn-audit.ts`
- Test: `tests/unit/services/guide-research-agent.spec.ts`
- Modify: `tests/unit/services/agent-sdk-adapter.spec.ts`
- Modify: `tests/unit/services/agent-turn-audit.spec.ts`

- [ ] **Step 1: 写 native tool 安全边界的失败测试**

```ts
it('allows WebSearch only for the explicit research policy', () => {
  const options = buildAgentSdkOptions(researchOptions());
  expect(options.allowedTools).toEqual(['WebSearch']);
  expect(options.disallowedTools).toContain('WebFetch');
  expect(options.disallowedTools).not.toContain('WebSearch');
});

it('keeps WebSearch denied for compose', () => {
  const options = buildAgentSdkOptions(composeOptions());
  expect(options.allowedTools).not.toContain('WebSearch');
  expect(options.disallowedTools).toContain('WebSearch');
});

it('denies the fourth WebSearch call', async () => {
  const gate = createResearchToolGate({ maxSearches: 3 });
  await expect(decision(gate, 1)).resolves.toBe('allow');
  await expect(decision(gate, 2)).resolves.toBe('allow');
  await expect(decision(gate, 3)).resolves.toBe('allow');
  await expect(decision(gate, 4)).resolves.toMatchObject({
    permissionDecision: 'deny',
    permissionDecisionReason: 'SEARCH_BUDGET_EXCEEDED'
  });
});
```

- [ ] **Step 2: 写研究输出验证的失败测试**

覆盖：

- 合法 KQM URL 被接受；
- 子域欺骗 `keqingmains.com.attacker.test` 被拒绝；
- 非 HTTPS 被拒绝；
- 缺少适用范围、时间线索或冲突字段被拒绝；
- 搜索 query 不包含输入的 UID/昵称/属性数字；
- Provider 不支持 WebSearch 映射 `SEARCH_UNAVAILABLE`；
- 搜索结果不会调用可信 bundle 的任何写方法。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
npx vitest run tests/unit/services/agent-sdk-adapter.spec.ts tests/unit/services/guide-research-agent.spec.ts tests/unit/services/agent-turn-audit.spec.ts
```

Expected: FAIL。

- [ ] **Step 4: 实现 purpose-scoped SDK policy**

`AgentSdkRunOptions` 增加：

```ts
nativeToolPolicy?: {
  purpose: 'research';
  allowed: ['WebSearch'];
  maxSearches: 3;
};
```

`buildAgentSdkOptions` 只在上述精确结构存在时：

- 从 `DENIED_NATIVE_TOOLS` 移除 `WebSearch`；
- 将 `allowedTools` 设为 `['WebSearch']`；
- 安装独立计数 hook；
- 仍使用 `permissionMode: 'dontAsk'`；
- 保持 `WebFetch`、Bash、Read、Write、Edit、Agent、Task 全部禁止。

业务 MCP tools 和 native WebSearch 不允许在同一阶段同时开启。

- [ ] **Step 5: 实现 Research prompt 和 Agent**

Prompt 明确只输出 JSON：

```ts
export const GUIDE_RESEARCH_PROMPT_V1 = `
你只补充给定的原神配队知识缺口。
只使用 WebSearch；不得臆测，不得请求玩家数据。
每条结论必须给出适用范围、来源 URL、页面时间线索和冲突。
输出严格 JSON，不输出 Markdown。
`;
```

Agent 先查 cache，再把剩余匿名任务合并成最多三个查询。输出通过 Zod 解析后逐 URL 检查：

```ts
const acceptedHosts = new Set(sourceRegistry.sources.map(({ host }) => host));
const url = new URL(candidate.url);
if (url.protocol !== 'https:' || !acceptedHosts.has(url.hostname)) reject();
```

成功项标记 `trust: ephemeral-web`；无合法项时返回 gap 和稳定错误码，不伪造事实。

- [ ] **Step 6: 扩展 turn audit 的原文与 SDK 错误捕获**

`runAuditedAgentTurn` 返回 `rawMessagesSummary`、最终原文、tools、usage；保留现在的 `result || assistantText` 解析行为。SDK 迭代或 result subtype 报错时抛出带稳定 code 的 `AgentTurnError`，不得只抛裸 `Error`。

- [ ] **Step 7: 运行测试与类型检查**

Run:

```bash
npx vitest run tests/unit/services/agent-sdk-adapter.spec.ts tests/unit/services/guide-research-agent.spec.ts tests/unit/services/agent-turn-audit.spec.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 8: 提交搜索阶段**

```bash
git add src/main/agents/research/prompt.ts src/main/services/guide-research-agent.ts src/main/services/agent-sdk-adapter.ts src/main/services/agent-turn-audit.ts tests/unit/services/guide-research-agent.spec.ts tests/unit/services/agent-sdk-adapter.spec.ts tests/unit/services/agent-turn-audit.spec.ts
git commit -m "feat: add bounded guide research fallback"
```

## Task 7: 实现仅存内存的最新 AgentRunTrace

**Files:**

- Create: `src/main/services/agent-run-trace-store.ts`
- Modify: `src/main/services/v2-agent-pipeline.ts`
- Modify: `src/main/services/abyss-plan-agent.ts`
- Test: `tests/unit/services/agent-run-trace-store.spec.ts`
- Modify: `tests/unit/services/v2-agent-pipeline.spec.ts`
- Modify: `tests/unit/services/abyss-plan-agent.spec.ts`

- [ ] **Step 1: 写 trace 生命周期和阶段原文的失败测试**

```ts
it('replaces the previous run and never calls disk persistence', () => {
  const store = new AgentRunTraceStore({ maxBytes: 128_000 });
  store.start(run('one'));
  store.finish('one', { finalSource: 'local-rules' });
  store.start(run('two'));
  expect(store.latest()?.correlationId).toBe('two');
  expect(JSON.stringify(store.latest())).not.toContain('one');
});

it('records compose raw output and terminal failure', async () => {
  const result = await runV2AgentPipeline(optionsWithInvalidComposer('model raw text'));
  expect(result.ok).toBe(false);
  expect(trace.latest()?.stages).toContainEqual(expect.objectContaining({
    name: 'compose',
    status: 'failed',
    rawOutput: expect.objectContaining({ text: 'model raw text' }),
    failure: expect.objectContaining({ code: 'AGENT_OUTPUT_INVALID' })
  }));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run tests/unit/services/agent-run-trace-store.spec.ts tests/unit/services/v2-agent-pipeline.spec.ts tests/unit/services/abyss-plan-agent.spec.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 Store**

公开接口：

```ts
export interface AgentRunTraceWriter {
  start(input: StartTraceInput): void;
  startStage(correlationId: string, input: StartStageInput): void;
  completeStage(correlationId: string, input: CompleteStageInput): void;
  failStage(correlationId: string, input: FailStageInput): void;
  skipStage(correlationId: string, input: SkipStageInput): void;
  finish(correlationId: string, input: FinishTraceInput): void;
  latest(): AgentRunTrace | null;
}
```

所有写入在 Store 边界脱敏；总预算默认 256 KiB，按阶段保留首尾并标记 `truncated`。`latest()` 返回 structured clone，防止 Renderer 或测试修改内部状态。类中不得导入 fs、electron-store 或 HistoryStore。

- [ ] **Step 4: 给 pipeline 加 stage observer**

在 compose/repair/critique/rotation/explain 的每次调用前后写阶段：

- 输入只写有界摘要；
- 原文取 `runAuditedAgentTurn` 的完整 text；
- tools 写名称、成功状态和脱敏 input；
- usage 写当前阶段增量；
- schema、validator、工具要求和 SDK 异常映射不同 failure code；
- 未运行阶段写 `skipped`，便于 UI 区分没有执行和执行失败。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
npx vitest run tests/unit/services/agent-run-trace-store.spec.ts tests/unit/services/v2-agent-pipeline.spec.ts tests/unit/services/abyss-plan-agent.spec.ts
npm run typecheck
```

Expected: PASS。

```bash
git add src/main/services/agent-run-trace-store.ts src/main/services/v2-agent-pipeline.ts src/main/services/abyss-plan-agent.ts tests/unit/services/agent-run-trace-store.spec.ts tests/unit/services/v2-agent-pipeline.spec.ts tests/unit/services/abyss-plan-agent.spec.ts
git commit -m "feat: retain an auditable latest agent run trace"
```

## Task 8: 把知识、搜索和 trace 接入深渊推荐，不再静默降级

**Files:**

- Modify: `src/main/services/abyss-advisor-service.ts`
- Modify: `src/main/services/abyss-business-tools.ts`
- Modify: `src/main/services/abyss-plan-agent.ts`
- Modify: `src/main/services/v2-agent-pipeline.ts`
- Modify: `src/main/agents/abyss-composer/prompt.ts`
- Modify: `src/main/agents/critique/prompt.ts`
- Modify: `src/main/agents/rotation-coach/prompt.ts`
- Modify: `src/main/agents/explain/prompt.ts`
- Modify: `src/main/index.ts`
- Modify: `tests/unit/services/abyss-advisor-service.spec.ts`
- Modify: `tests/unit/services/abyss-business-tools.spec.ts`
- Modify: `tests/unit/services/abyss-plan-agent.spec.ts`

- [ ] **Step 1: 写端到端 service 失败测试**

```ts
it('uses local trusted knowledge without search when coverage is complete', async () => {
  const result = await service(completeKnowledge).recommend(input);
  expect(research.run).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    source: 'smart-service',
    knowledgeSummary: { searched: false, unknown: 0 }
  });
  expect(trace.latest()?.usage.outputTokens).toBeGreaterThan(0);
});

it('researches only gaps and keeps the result ephemeral', async () => {
  const result = await service(missingKnowledge).recommend(input);
  expect(research.run).toHaveBeenCalledOnce();
  expect(result.knowledgeSummary).toMatchObject({ searched: true, ephemeral: 1 });
  expect(knowledgeWriter).not.toHaveBeenCalled();
});

it('exposes the model failure when falling back to local rules', async () => {
  const result = await serviceWithSdkFailure('upstream 500').recommend(input);
  expect(result.source).toBe('local-rules');
  expect(trace.latest()).toMatchObject({
    finalSource: 'local-rules',
    failure: { code: 'PROVIDER_ERROR' }
  });
});
```

增加 build-role 冲突、反应触发权冲突、站场时间冲突、能量闭环无事实、免疫和生存能力不足的 Critique fixture。

- [ ] **Step 2: 运行失败测试**

Run:

```bash
npx vitest run tests/unit/services/abyss-advisor-service.spec.ts tests/unit/services/abyss-business-tools.spec.ts tests/unit/services/abyss-plan-agent.spec.ts
```

Expected: FAIL。

- [ ] **Step 3: 按确定顺序接入前置知识流程**

`recommend()` 的顺序改为：

1. `reading-roster`
2. 读取并验证场景
3. 本地优化器证明可行
4. `interpreting-builds`
5. `checking-knowledge`
6. CoverageGate；需要时 `researching-guides`
7. 生成最终 `KnowledgeContextPacket`
8. `generating-teams`
9. critique/rotation/explain

新推荐开始时调用 `traceStore.start()`，所有 return 和 catch 都调用 `finish()`。取消映射 `AGENT_ABORTED`，超时映射 `AGENT_TIMEOUT`，Provider/SDK 异常保留脱敏 code/message。删除吞掉 Agent 根因的空 catch。

- [ ] **Step 4: 新增 query_team_knowledge 工具**

`ABYSS_MCP_TOOL_NAMES` 改为：

```ts
[
  'mcp__genshin__read_profile_cache',
  'mcp__genshin__query_enemy_data',
  'mcp__genshin__query_team_knowledge'
]
```

工具只返回当前运行已构建的 packet 子集，不在工具调用时重新搜索。输入要求 character IDs、floor/chamber/half；输出包含 build interpretation、角色策略、机制策略、unknown 和 citation IDs。

`validateRequiredTools` 必须确认：

- 最终八名角色已读取详细 profile；
- 每个目标房间已读取敌情；
- 最终八名角色和目标房间已通过 `query_team_knowledge` 读取；
- 计划中依赖知识的 `factRefs` citation ID 均存在。

- [ ] **Step 5: 更新四个阶段 prompt**

Composer：

- 每名角色输出 archetype ID 和职责；
- 标记 `current-build` 或 `requires-adjustment`；
- 当前 build 冲突不得当作可直接用；
- 只引用 packet citation。

Critique：

- 校验 build/职责、反应触发权、站场时间、能量循环、生存、抗性免疫、破盾、多波次和 citation；
- 不自行补写新事实。

Rotation 与 Explain：

- 只能使用 packet 和已验证 plan；
- Explain 分区写“适配原因 / 当前 build / 风险未知 / 可选换装 / 来源”；
- required adjustment 必须醒目标注。

提示词常量升版，并在测试中断言版本名和关键政策。

- [ ] **Step 6: 明确降级语义**

- Agent 成功且 usage > 0：`smart-service`；
- Agent 失败、本地方案可行：`local-rules`，warning 含稳定中文摘要，trace 含真实失败；
- 本地也不可行：`blocked`，`finalSource: blocked`；
- Web Search 失败但可信知识仍能生成：允许继续，unknown 和低置信度必须保留；
- 不得因“模型返回了文本”就标成 smart-service，必须通过 schema、tools、validator 和 critique。

- [ ] **Step 7: 运行服务、golden 与类型检查**

Run:

```bash
npx vitest run tests/unit/services/abyss-advisor-service.spec.ts tests/unit/services/abyss-business-tools.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/v2-agent-pipeline.spec.ts
npm run test:golden
npm run typecheck
```

Expected: PASS。

- [ ] **Step 8: 提交深渊管线**

```bash
git add src/main/services/abyss-advisor-service.ts src/main/services/abyss-business-tools.ts src/main/services/abyss-plan-agent.ts src/main/services/v2-agent-pipeline.ts src/main/agents/abyss-composer/prompt.ts src/main/agents/critique/prompt.ts src/main/agents/rotation-coach/prompt.ts src/main/agents/explain/prompt.ts src/main/index.ts tests/unit/services/abyss-advisor-service.spec.ts tests/unit/services/abyss-business-tools.spec.ts tests/unit/services/abyss-plan-agent.spec.ts tests/unit/services/v2-agent-pipeline.spec.ts
git commit -m "feat: ground abyss recommendations in build-aware knowledge"
```

## Task 9: 通过白名单 IPC 暴露最新模型原文

**Files:**

- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/abyss-advisor.ipc.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/main/index.ts`
- Modify: `tests/unit/ipc/abyss-advisor.ipc.spec.ts`
- Create: `tests/unit/ipc/agent-run-trace.ipc.spec.ts`

- [ ] **Step 1: 写 IPC 失败测试**

```ts
it('returns only the latest sanitized trace', async () => {
  registerAbyssAdvisorIpc(depsWithTrace(latestTrace));
  await expect(invoke('advisor-v2:abyss-latest-trace')).resolves.toEqual(latestTrace);
});

it('does not expose a trace event stream or history channel', () => {
  expect(ALL_IPC_CHANNELS).toContain('advisor-v2:abyss-latest-trace');
  expect(ALL_IPC_CHANNELS).not.toContain('advisor-v2:abyss-trace-history');
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```bash
npx vitest run tests/unit/ipc/abyss-advisor.ipc.spec.ts tests/unit/ipc/agent-run-trace.ipc.spec.ts
```

Expected: FAIL。

- [ ] **Step 3: 增加查询通道**

共享契约：

```ts
'advisor-v2:abyss-latest-trace': {
  req: void;
  res: AgentRunTrace | null;
};
```

`RendererApi.abyssAdvisor` 增加：

```ts
getLatestTrace: () => Promise<IpcResponse<'advisor-v2:abyss-latest-trace'>>;
```

preload 只暴露 invoke；不暴露任意 channel 名，不增加 trace push event。IPC handler 直接读取 `traceStore.latest()`。

- [ ] **Step 4: 运行测试和类型检查**

Run:

```bash
npx vitest run tests/unit/ipc/abyss-advisor.ipc.spec.ts tests/unit/ipc/agent-run-trace.ipc.spec.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 5: 提交 IPC**

```bash
git add src/shared/ipc-contract.ts src/main/ipc/abyss-advisor.ipc.ts src/main/preload.ts src/main/index.ts tests/unit/ipc/abyss-advisor.ipc.spec.ts tests/unit/ipc/agent-run-trace.ipc.spec.ts
git commit -m "feat: expose the latest sanitized agent trace"
```

## Task 10: 增加真实 SDK 和真实 Advisor 手动门禁

**Files:**

- Create: `src/main/gates/agent-saved-gate.ts`
- Create: `src/main/gates/advisor-saved-gate.ts`
- Modify: `tsup.config.ts`
- Modify: `package.json`
- Create: `tests/unit/gates/agent-saved-gate.spec.ts`
- Create: `tests/unit/gates/advisor-saved-gate.spec.ts`
- Modify: `docs/llm-provider.md`
- Modify: `docs/troubleshooting.md`

- [ ] **Step 1: 写门禁输出的失败测试**

```ts
it('fails when a real agent turn has no raw text or usage', () => {
  expect(evaluateAgentGate({
    rawText: '',
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  })).toMatchObject({ status: 'failed', code: 'EMPTY_AGENT_RESULT' });
});

it('requires smart-service for the advisor gate', () => {
  expect(evaluateAdvisorGate({
    source: 'local-rules',
    trace: fallbackTrace
  })).toMatchObject({ status: 'failed', code: 'ADVISOR_FELL_BACK' });
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```bash
npx vitest run tests/unit/gates/agent-saved-gate.spec.ts tests/unit/gates/advisor-saved-gate.spec.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 `gate:agent-saved`**

复用 ConfigService 的 dev userData 和 AgentSdkAdapter，运行无工具、单轮、固定小 prompt。stdout 只输出安全 JSON：

```json
{
  "gate": "agent-saved",
  "status": "passed",
  "model": "配置模型名",
  "rawText": "模型原文，经过 trace 脱敏和长度限制",
  "usage": {
    "inputTokens": 1,
    "outputTokens": 1
  },
  "latencyMs": 1
}
```

不输出 API Key、custom headers、上游 body。

- [ ] **Step 4: 实现 `gate:advisor-saved`**

读取 dev userData 中本地 active profile、正式 scenario 和可信知识，运行真实 `AbyssAdvisorService.recommend()`。要求：

- source 为 `smart-service`；
- trace 有 compose、critique、rotation、explain 原文；
- usage input/output 均大于 0；
- 最终八人都属于 owned roster；
- 知识摘要与 trace 一致。

若正式 scenario 当前不可用，输出 `SCENARIO_UNAVAILABLE` 并失败，不偷偷改用 development sample。

- [ ] **Step 5: 加入 build entry 和 scripts**

`tsup.config.ts`：

```ts
entry: {
  index: 'src/main/index.ts',
  'miyoushe-detail-gate': 'src/main/gates/miyoushe-detail-gate.ts',
  'provider-saved-gate': 'src/main/gates/provider-saved-gate.ts',
  'agent-saved-gate': 'src/main/gates/agent-saved-gate.ts',
  'advisor-saved-gate': 'src/main/gates/advisor-saved-gate.ts'
}
```

`package.json`：

```json
"gate:agent-saved": "npm run build:main && electron dist/main/agent-saved-gate.mjs",
"gate:advisor-saved": "npm run build:main && electron dist/main/advisor-saved-gate.mjs"
```

- [ ] **Step 6: 更新文档**

文档说明三层区别：

- `gate:provider-saved` 只证明 Messages Provider 可达；
- `gate:agent-saved` 证明 SDK 子进程真的返回模型原文；
- `gate:advisor-saved` 证明完整深渊 Agent 管线没有降级。

记录当前已知证据：Provider gate 通过，但历史推荐为 local-rules；新门禁用来定位 Agent 阶段根因。

- [ ] **Step 7: 运行单元测试和 build**

Run:

```bash
npx vitest run tests/unit/gates/agent-saved-gate.spec.ts tests/unit/gates/advisor-saved-gate.spec.ts tests/unit/dev/tsup-dev-readiness.spec.ts
npm run build:main
```

Expected: PASS。此步不消耗用户 Key。

- [ ] **Step 8: 提交门禁**

```bash
git add src/main/gates/agent-saved-gate.ts src/main/gates/advisor-saved-gate.ts tsup.config.ts package.json tests/unit/gates/agent-saved-gate.spec.ts tests/unit/gates/advisor-saved-gate.spec.ts tests/unit/dev/tsup-dev-readiness.spec.ts docs/llm-provider.md docs/troubleshooting.md
git commit -m "feat: add real agent and advisor verification gates"
```

## Task 11: 把深渊页重构为单视口工作台

**Files:**

- Create: `src/renderer/pages/Advisor/abyss/useAbyssWorkbench.ts`
- Create: `src/renderer/pages/Advisor/abyss/AbyssConstraintPanel.tsx`
- Create: `src/renderer/pages/Advisor/abyss/AbyssScenarioPanel.tsx`
- Create: `src/renderer/pages/Advisor/abyss/AbyssResultPanel.tsx`
- Create: `src/renderer/pages/Advisor/abyss/AgentTraceDrawer.tsx`
- Create: `src/renderer/pages/Advisor/abyss/abyss-workbench.css`
- Modify: `src/renderer/pages/Advisor/AbyssWorkspace.tsx`
- Modify: `src/renderer/pages/Advisor/abyss-presentation.ts`
- Modify: `tests/unit/renderer/abyss-presentation.spec.ts`
- Modify: `tests/e2e/app.spec.ts`

- [ ] **Step 1: 写首屏信息和 trace 展示的失败测试**

单元测试：

```ts
expect(progressLabel('interpreting-builds')).toBe('识别当前配装');
expect(progressLabel('checking-knowledge')).toBe('匹配本地攻略知识');
expect(progressLabel('researching-guides')).toBe('补充攻略上下文');
expect(sourceBadge('smart-service')).toBe('AI 已验证');
expect(sourceBadge('local-rules')).toBe('本地规则');
```

E2E 在 `1440×900` 和 `1280×800` 验证：

```ts
await expect(page.getByTestId('abyss-constraints')).toBeInViewport();
await expect(page.getByTestId('abyss-scenario')).toBeInViewport();
await expect(page.getByTestId('abyss-results')).toBeInViewport();
expect(await page.evaluate(() => document.documentElement.scrollHeight))
  .toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight + 2));
```

并验证打开“模型运行记录”后可见 model、原文、工具、引用、token、耗时、错误；Escape 关闭并恢复焦点。

- [ ] **Step 2: 运行失败测试**

Run:

```bash
npx vitest run tests/unit/renderer/abyss-presentation.spec.ts
npm run build
npx playwright test tests/e2e/app.spec.ts --grep "abyss workbench|agent trace"
```

Expected: FAIL，旧页面超高且没有 trace drawer。

- [ ] **Step 3: 抽离 workbench state hook**

`useAbyssWorkbench` 负责 scenario、preferences、locked/excluded、recommend/cancel、progress、result、trace drawer。保持业务状态不进入纯展示组件。打开 drawer 时才调用 `getLatestTrace()`；生成结束不主动拉 trace。

新建推荐的 `DEFAULT_PREFERENCES.noBuildChange` 改为 `true`，体现“默认尊重当前 build”。从历史重跑时仍使用历史中显式保存的值，不擅自覆盖玩家当时选择。

- [ ] **Step 4: 实现上方双栏**

布局：

```css
.abyss-workbench {
  height: calc(100dvh - var(--app-shell-offset));
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(260px, 42%) minmax(0, 1fr);
  overflow: hidden;
}

.abyss-workbench__inputs {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-height: 0;
}
```

左栏只放：

- 锁定/排除角色；
- 舒适度、生存、低练度、保持当前 build；
- 生成/取消主操作；
- 当前已选摘要。

右栏只放：

- 楼层/房间；
- 上下半敌人、机制标签和刷新状态；
- 场景不可用的明确阻断。

面板内容超高时各自内部滚动，禁止让 document 产生长滚动。

- [ ] **Step 5: 实现下方结果**

结果区固定占下半视口，默认展示上下半八个头像、队伍骨架、来源 badge、知识 coverage、搜索状态和主要风险。详情使用内部 tabs/expanders，不把所有解释一次性纵向展开。

三种来源必须视觉和文本都区分：

- `AI 已验证`；
- `本地规则`；
- `无法生成`。

- [ ] **Step 6: 实现 AgentTraceDrawer**

右侧 modal drawer：

- header：model、开始/结束、最终来源、usage；
- stage accordion：状态、耗时、原文、工具、citation、failure；
- raw output 使用 `<pre>` 和复制按钮；
- truncated 明确显示；
- 空 trace 显示“尚未运行模型”；
- `role="dialog"`、`aria-modal`、焦点陷阱、Escape、关闭后恢复焦点。

- [ ] **Step 7: 运行单元、E2E 和视觉记录**

Run:

```bash
npx vitest run tests/unit/renderer/abyss-presentation.spec.ts
npm run test:e2e:visual:record
```

检查新截图后，把确认的 visual signatures 写回 `tests/e2e/app.spec.ts`，再运行：

```bash
npm run test:e2e:visual
```

Expected: 两个目标视口核心区域同时可见，document 无长滚动，drawer 交互通过。

- [ ] **Step 8: 提交深渊 UI**

```bash
git add src/renderer/pages/Advisor/AbyssWorkspace.tsx src/renderer/pages/Advisor/abyss src/renderer/pages/Advisor/abyss-presentation.ts tests/unit/renderer/abyss-presentation.spec.ts tests/e2e/app.spec.ts
git commit -m "feat: redesign abyss advisor as a one-view workbench"
```

## Task 12: 把角色页改为全宽头像矩阵和右侧详情抽屉

**Files:**

- Create: `src/renderer/pages/Roster/CharacterTile.tsx`
- Create: `src/renderer/pages/Roster/CharacterDetailDrawer.tsx`
- Modify: `src/renderer/pages/Roster/RosterPage.tsx`
- Modify: `src/renderer/pages/Roster/CharacterCard.tsx`
- Modify: `src/renderer/pages/Roster/character-presentation.ts`
- Modify: `src/renderer/styles/roster.css`
- Modify: `tests/unit/renderer/character-card.spec.ts`
- Modify: `tests/unit/renderer/character-presentation.spec.ts`
- Modify: `tests/e2e/app.spec.ts`

- [ ] **Step 1: 写矩阵和抽屉的失败测试**

Tile 单元测试只允许首屏字段：

```ts
expect(renderTile(character)).toMatchObject({
  name: '雷电将军',
  level: 90,
  element: 'Electro',
  completeness: 'detailed'
});
expect(renderTile(character)).not.toHaveProperty('artifactDetails');
```

E2E 验证：

- 页面首屏出现至少 12 个 `character-tile`；
- 点击 tile 后右侧 drawer 显示等级、命座、天赋、武器、圣遗物、关键属性、来源完整度；
- Escape 关闭并恢复焦点；
- `1280×800` 页面 shell 不产生长滚动，矩阵自身滚动。

- [ ] **Step 2: 运行失败测试**

Run:

```bash
npx vitest run tests/unit/renderer/character-card.spec.ts tests/unit/renderer/character-presentation.spec.ts
npm run build
npx playwright test tests/e2e/app.spec.ts --grep "roster grid|character drawer"
```

Expected: FAIL。

- [ ] **Step 3: 实现 CharacterTile**

Tile 只展示：

- 头像；
- 名称；
- `Lv.90`；
- 元素图标；
- build 完整度小标记。

头像缺失时使用现有元素化 fallback。Tile 使用 button 语义、可键盘聚焦，选中态通过 `aria-pressed` 或对应 dialog relation 表达。

- [ ] **Step 4: 实现 CharacterDetailDrawer**

复用旧 `CharacterCard` 中的详情内容，但移入右侧抽屉。不要复制计算逻辑；先把展示模型留在 `character-presentation.ts`。抽屉宽度使用 `clamp(360px, 38vw, 560px)`，内部滚动，背景页面不滚动。

- [ ] **Step 5: 重排 RosterPage**

页面结构保持 toolbar/profile summary 紧凑固定，余下高度全部给 avatar grid：

```css
.roster-page {
  height: calc(100dvh - var(--app-shell-offset));
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  overflow: hidden;
}

.roster-grid {
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  align-content: start;
}
```

- [ ] **Step 6: 运行测试与视觉门禁**

Run:

```bash
npx vitest run tests/unit/renderer/character-card.spec.ts tests/unit/renderer/character-presentation.spec.ts
npm run test:e2e:visual:record
npm run test:e2e:visual
```

Expected: PASS。

- [ ] **Step 7: 提交角色 UI**

```bash
git add src/renderer/pages/Roster/CharacterTile.tsx src/renderer/pages/Roster/CharacterDetailDrawer.tsx src/renderer/pages/Roster/RosterPage.tsx src/renderer/pages/Roster/CharacterCard.tsx src/renderer/pages/Roster/character-presentation.ts src/renderer/styles/roster.css tests/unit/renderer/character-card.spec.ts tests/unit/renderer/character-presentation.spec.ts tests/e2e/app.spec.ts
git commit -m "feat: replace roster cards with an avatar grid and drawer"
```

## Task 13: 全量回归、真实门禁和完成证据

**Files:**

- Modify as required by failures only; do not broaden scope.
- Update: `docs/superpowers/specs/2026-07-24-knowledge-grounded-advisor-workbench-design.md` status section
- Create: `docs/verification/2026-07-24-knowledge-grounded-advisor-workbench.md`

- [ ] **Step 1: 运行格式化检查和静态门禁**

Run:

```bash
npm run lint
npm run typecheck
```

Expected: PASS with zero warnings.

- [ ] **Step 2: 运行全部单元和 golden tests**

Run:

```bash
npm run test
npm run test:golden
```

Expected: PASS。

- [ ] **Step 3: 运行 build、预算和视觉 E2E**

Run:

```bash
npm run build
npm run test:renderer-budget
npm run test:e2e:visual
```

Expected: PASS。

- [ ] **Step 4: 运行真实 Agent 门禁**

这些命令会使用玩家已保存的 Key，只在本地手动运行，不加入 CI：

```bash
npm run gate:provider-saved
npm run gate:agent-saved
npm run gate:advisor-saved
```

Expected:

- Provider：HTTP 200；
- Agent：有脱敏模型原文，input/output usage > 0；
- Advisor：`source: smart-service`，compose/critique/rotation/explain 均完成并有原文。

若 `gate:agent-saved` 失败，先修 SDK/Provider 层；若它通过但 advisor 失败，按 trace 的首个 failed stage 修知识、工具、schema 或 validator。不得以本地规则通过替代真实 Advisor 门禁。

- [ ] **Step 5: 人工检查数据边界**

在 dev app 检查：

- 最新 trace 中没有 API Key、Cookie、Authorization 或 custom header 值；
- Web Search query 没有 UID、昵称和完整面板；
- `resources/knowledge` 未在运行后发生修改；
- `userData/cache/guide-research.json` 只有 `ephemeral-web` 摘要；
- HistoryStore 没有 Agent 原文；
- 新一次生成替换上一次 trace。

- [ ] **Step 6: 写验证记录**

`docs/verification/2026-07-24-knowledge-grounded-advisor-workbench.md` 记录：

- commit SHA；
- 每条命令、时间、退出码；
- 三个真实门禁的安全摘要；
- `1440×900`、`1280×800` 截图路径；
- 知识目录/策略数量和 coverage；
- 仍存在的明确 unknown，不写“全部准确”之类无证据结论。

- [ ] **Step 7: 更新设计状态并提交**

把设计文档状态改为“Implemented and verified”，附验证记录链接。

```bash
git add docs/superpowers/specs/2026-07-24-knowledge-grounded-advisor-workbench-design.md docs/verification/2026-07-24-knowledge-grounded-advisor-workbench.md
git commit -m "docs: record advisor workbench verification"
```

## 最终验收清单

- [ ] 受支持角色目录与策略 bundle ID 一一对应，至少覆盖当前 112 个角色。
- [ ] 雷电将军、久岐忍、纳西妲、心海、芙宁娜能依据当前 build 选择不同职责。
- [ ] 怪物破盾、抗性、免疫、多波次、聚怪、单体和生存压力会改变能力约束。
- [ ] 知识完整时零 Web Search；缺失/过期/冲突时最多三次。
- [ ] Web Search 结果只进 24 小时临时缓存，不自动写入可信知识。
- [ ] Composer 最终八人已读取 profile、逐房敌情和 team knowledge。
- [ ] `smart-service` 必须同时满足真实 usage、原文、工具要求、schema 和 validator。
- [ ] 降级时 UI 显示本地规则，trace 显示真实失败阶段和原因。
- [ ] 最新模型原文可查看但不进入历史。
- [ ] 深渊页在 `1440×900` 和 `1280×800` 同时看见约束、场景和结果。
- [ ] 角色页为全宽头像矩阵，详情在右侧抽屉。
- [ ] lint、typecheck、unit、golden、build、renderer budget、visual E2E 全部通过。
- [ ] provider、agent、advisor 三个真实门禁均有可审计证据。
