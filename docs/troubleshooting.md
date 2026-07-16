# 故障排查 / Troubleshooting

## 米游社登录或全角色拉取失败

- 先在角色页运行“测试米游社连接”。登录过期时重新登录。
- 出现验证码/5003 时，在弹出的可见窗口进入“原神战绩”完成验证后再试。
- 风控、限频或 schema 变化会显示 partial；应用不会把缺失字段伪装成 0。
- 维护者可运行 `npm run gate:miyoushe-detail`。无持久登录态时该命令会明确 skip，不会读取环境变量中的 Cookie。

## Enka 没有角色或返回 429

- 确认游戏内展示柜公开且已等待约 5 分钟。
- 展示柜为空/关闭只影响 Enka，不影响米游社 owned roster。
- 429 时等待响应 TTL 后重试；反复刷新会延长限频。

## LLM 连接失败或回退到本地算法

- 检查 Key、Base URL、Model 是否属于同一个 Messages-compatible Provider。
- 企业代理或自建网关需要的 header 必须配置为合法的单行 KV。
- 任一 Agent 阶段超时、结构校验失败或返回未知角色 ID 时，整条编排会终止并回退；不会保存半条 LLM 历史。

## macOS / Windows 安装

- macOS 正式产物必须通过 Developer ID 签名和 Apple 公证。若 RC 未公证，不应绕过 Gatekeeper 当作 Release 验收。
- Windows 1.0 暂不签名，SmartScreen 可能提示“未知发布者”。从 GitHub Release 下载并比对发布页 SHA-256 后再继续。
- 卸载默认保留用户数据。覆盖安装与自动更新也应保留 Profile、历史和加密 Key。

## English summary

Re-authenticate when the MiHoYo session expires; complete verification in the visible Battle Chronicle window for captcha/5003 responses. An empty Enka showcase is not an empty account, and 429 responses require waiting for the advertised TTL. Provider failures or invalid agent output trigger a complete local fallback. Official macOS releases must be signed and notarized; Windows 1.0 is unsigned and may show a SmartScreen warning. Verify SHA-256 checksums from the GitHub Release before installing.
