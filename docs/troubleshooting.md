# 故障排查 / Troubleshooting

## 米游社登录或全角色拉取失败

- 先在角色页运行“测试米游社连接”。登录过期时重新登录。
- Battle Chronicle 返回 5003 时，应用会自动改用米游社养成计算器同步接口获取完整角色池，不要求用户重复验证码。
- 5003 不是可强制转成 1034 的验证码类型；实测官方 verify 会返回 10306。遇到 10306 时不要循环点选。
- 自然 1034 是不同状态：应用会打开米游社官方 GeeTest，并且只在官方 verify 接受后携带 `x-rpc-challenge` 重放原请求；取消或超时则保留 calculator/Enka 降级数据。
- 若提示“养成计算器角色同步未开启”，应用不会擅自修改该隐私设置；请在米游社养成计算器中开启同步后刷新，或继续使用已保留的权威缓存。
- 米游社刷新失败时，应用会保留已有的权威角色池并标记为 stale；新鲜 Enka 数据只补强展示角色，不会再把完整缓存缩减为展示柜子集。
- 如果页面只有 Enka 角色且显示“部分数据”，说明当前没有可用的米游社 ownership；需重新登录后拉取全部角色。
- 风控、限频或 schema 变化会显示 partial；应用不会把缺失字段伪装成 0，也不会把计算器同步失败伪装成空角色池。
- 维护者可运行 `npm run gate:miyoushe-detail`。无持久登录态时该命令会明确 skip，不会读取环境变量中的 Cookie。

## Enka 没有角色或返回 429

- 确认游戏内展示柜公开且已等待约 5 分钟。
- 展示柜为空/关闭只影响 Enka，不影响米游社 owned roster。
- 429 时等待响应 TTL 后重试；反复刷新会延长限频。

## LLM 连接失败或回退到本地算法

- 检查 Key、Base URL、Model 是否属于同一个 Messages-compatible Provider。
- 企业代理或自建网关需要的 header 必须配置为合法的单行 KV。
- 任一 Agent 阶段超时、结构校验失败或返回未知角色 ID 时，整条编排会终止并回退；不会保存半条 LLM 历史。
- 维护者应按层运行保存态门禁：先 `npm run gate:provider-saved`，再 `npm run gate:agent-saved`，最后 `npm run gate:advisor-saved`。后两条是真实模型请求，会产生用量；不要在 CI、自动测试或普通构建中执行。
- Provider 通过而 Agent 返回 `EMPTY_AGENT_RESULT` / usage 缺失，说明 Messages 端点可达但 SDK 子进程没有形成完整成功 turn；`AGENT_TIMEOUT` / `PROVIDER_ERROR` 只提供稳定 code/status，不回显上游 body。
- Agent 通过而 Advisor 返回 `ADVISOR_FELL_BACK`，说明单轮 SDK 正常，但完整 compose → critique → rotation → explain 中至少一个阶段失败或本地校验拒绝了结果。检查最新 trace 的稳定 stage failure code。
- `SCENARIO_UNAVAILABLE` 表示没有可用于推荐的正式、已验证且当前有效的深渊发布。门禁不会用 development sample 掩盖这个问题。
- `ACTIVE_PROFILE_UNAVAILABLE` / `ROSTER_INSUFFICIENT` 要求先在应用内选择本地 active UID，并保证 ownership 角色池至少八人；门禁不会从 Enka 展示柜或 fixture 临时拼出 roster。
- `REQUIRED_STAGE_*`、`STAGE_*_USAGE_MISSING`、`TRACE_*_USAGE_MISSING`、`TEAM_SIZE_INVALID`、`CHARACTER_NOT_OWNED`、`KNOWLEDGE_SUMMARY_MISMATCH` 都是终态证据不完整，不能当作“模型大致可用”放行。
- 已知曾出现 `gate:provider-saved` 通过而推荐历史仍为 `local-rules`；这不是矛盾：Provider gate 不经过 Agent SDK 和 Advisor 管线。必须以后两层分别定位。

## macOS / Windows 安装

- macOS 正式产物必须通过 Developer ID 签名和 Apple 公证。若 RC 未公证，不应绕过 Gatekeeper 当作 Release 验收。
- Windows 1.0 暂不签名，SmartScreen 可能提示“未知发布者”。从 GitHub Release 下载并比对发布页 SHA-256 后再继续。
- 卸载默认保留用户数据。覆盖安装与自动更新也应保留 Profile、历史和加密 Key。

## English summary

Re-authenticate when the MiHoYo session expires. Battle Chronicle 5003 responses fall back to MiHoYo's calculator-sync roster; do not loop on a 10306 captcha. If calculator sync is disabled, enable it explicitly in MiHoYo or keep the preserved authoritative cache. Enka-only profiles are always partial and never define the full owned roster. An empty Enka showcase is not an empty account, and 429 responses require waiting for the advertised TTL. Provider failures or invalid agent output trigger a complete local fallback. Official macOS releases must be signed and notarized; Windows 1.0 is unsigned and may show a SmartScreen warning. Verify SHA-256 checksums from the GitHub Release before installing.
