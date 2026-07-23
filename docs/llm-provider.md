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

## English

The application has one provider path: the Anthropic Messages protocol. Use the default Anthropic URL or an explicitly compatible gateway by changing `baseUrl` (without `/v1/messages`). Enter a model identifier supported by that endpoint, save, and run **Test connection**. The one-token test does not include profile data. While the user is typing, API keys and custom-header values briefly exist in renderer form state. After saving, those values are not returned to the renderer: the main process encrypts them locally with `safeStorage`, decrypts them only for Provider / Agent SDK requests, and never displays the saved values again.
