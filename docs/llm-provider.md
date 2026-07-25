# LLM Provider 配置 / LLM provider setup

应用只实现 Anthropic Messages 协议这一条调用路径；不维护多 Provider 抽象。兼容网关通过修改 `baseUrl` 接入。

| 字段           | 说明                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| API Key        | 必填；由系统钥匙串加密                                                                                |
| Base URL       | 默认 `https://api.anthropic.com`，不要包含 `/v1/messages`                                             |
| Model          | Provider 实际支持的模型标识                                                                           |
| Custom headers | Settings 中每行 `Header-Name: value`；值与 API Key 同样加密且保存后不回显，换行注入和非法名称会被拒绝 |

用户输入 API Key 或 Custom header 值时，明文会短暂存在于 Renderer 的设置表单状态中。保存后这些值不会再回传 Renderer；Main 进程使用 `safeStorage` 加密落盘，并只在发起 Provider / Agent SDK 请求时解密使用。

保存后使用“测试连接”。测试只发送一个 `max_tokens: 1` 的 `ping`，不会上传 Profile。HTTP 错误不会把上游响应 body 回显到 UI 或日志。

Agent SDK 每次推荐会启动隔离子进程，并通过单次 `Options.env` 注入 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 和模型。应用默认禁用 Bash、文件读写、WebFetch、原生 Agent/Task 等工具，只运行代码定义的五阶段结构化编排。

## 保存配置的三层手动门禁

以下命令是维护者手动诊断，不属于 `test`、`build` 或 `gate:local`。后面两层会真实调用用户保存的模型并产生用量；CI 和常规构建不会读取、解密或消耗用户 Key。

| 命令                          | 证明范围                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run gate:provider-saved` | 只证明保存的 Messages Provider 配置可达；不启动 Agent SDK，也不读取 Profile。                                                 |
| `npm run gate:agent-saved`    | 通过真实 `AgentSdkAdapter` 子进程运行固定、无工具、单轮 prompt，并要求非空模型原文和正数 input/output usage。                 |
| `npm run gate:advisor-saved`  | 使用 active 本地 Profile、正式场景发布、内置可信知识和同一份运行 trace 执行真实深渊管线；必须得到 `smart-service`，不能降级。 |

每个新门禁的 stdout 都只有一行 JSON，`status: "passed"` 时退出码为 0，`status: "failed"` 时为 1。`gate:agent-saved` 的 `rawText` 使用与 trace 相同的敏感值脱敏并限制为 4096 UTF-8 字节；两层都不会输出 API Key、custom-header 值、Provider 响应 body 或完整 Profile。Provider/SDK 异常只保留稳定的 gate code，以及可安全解析时的 SDK code / HTTP status。

`gate:advisor-saved` 还会检查 compose、critique、rotation、explain 四阶段都有脱敏后的模型原文和正数 usage，trace 汇总 usage 为正数，最终两队恰好八名不重复 owned 角色，且结果的 knowledge summary 与同一 trace 完全一致。Web Search 只在可信知识有缺口时运行，结果仍只写入 24 小时 `ephemeral-web` 缓存；门禁没有可信知识 writer。正式场景未配置、不可验证、过期或刷新不可用时会以 `SCENARIO_UNAVAILABLE` 失败，绝不改用 development sample。

稳定失败码：

- Agent gate：`MISSING_SAVED_API_KEY`、`SAVED_KEY_DECRYPT_FAILED`、`SAFE_STORAGE_UNAVAILABLE`、`AGENT_TIMEOUT`、`PROVIDER_ERROR`、`EMPTY_AGENT_RESULT`、`AGENT_INPUT_USAGE_MISSING`、`AGENT_OUTPUT_USAGE_MISSING`、`AGENT_MODEL_MISSING`、`AGENT_LATENCY_INVALID`。
- Advisor gate：除保存配置和 `PROVIDER_ERROR` 外，还可能返回 `ACTIVE_PROFILE_UNAVAILABLE`、`ROSTER_INSUFFICIENT`、`SCENARIO_UNAVAILABLE`、`ADVISOR_NOT_PLANNED`、`ADVISOR_FELL_BACK`、trace / stage / usage 缺失类 code、`TEAM_SIZE_INVALID`、`CHARACTER_NOT_OWNED`、`KNOWLEDGE_SUMMARY_MISMATCH` 或 `ADVISOR_LATENCY_INVALID`。

已知的历史证据是 `gate:provider-saved` 可以通过，但此前保存的推荐历史仍显示 `local-rules`。这只证明 Provider 可达，不能证明 Agent SDK 或完整 Advisor 管线成功；新增的第二、第三层正是用于隔离这两个阶段。

## English

The application has one provider path: the Anthropic Messages protocol. Use the default Anthropic URL or an explicitly compatible gateway by changing `baseUrl` (without `/v1/messages`). Enter a model identifier supported by that endpoint, save, and run **Test connection**. The one-token test does not include profile data. While the user is typing, API keys and custom-header values briefly exist in renderer form state. After saving, those values are not returned to the renderer: the main process encrypts them locally with `safeStorage`, decrypts them only for Provider / Agent SDK requests, and never displays the saved values again.

Maintainers have three manual saved-state gates. `gate:provider-saved` checks only Messages reachability, `gate:agent-saved` checks one real tool-free SDK child-process turn, and `gate:advisor-saved` checks the complete production-scenario Abyss pipeline without fallback. The latter two consume saved-provider usage and are intentionally excluded from tests and builds. Their stdout is one privacy-safe JSON line; they never print keys, custom-header values, provider bodies, or a full profile. The advisor gate never substitutes a development fixture and reports `SCENARIO_UNAVAILABLE` when a verified production publication cannot be used.
