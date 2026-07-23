# 隐私说明 / Privacy

## 中文

genshin-team-advisor 是本地优先的桌面应用，没有作者运营的后端、账号系统或遥测服务。

- 用户输入 LLM API Key 与自定义请求头时，明文会短暂存在于 Renderer 的表单状态中；保存后不会再回传 Renderer。Main 进程使用 Electron `safeStorage` 加密后将密文写入应用 `userData`，并只在发起 Provider/Agent SDK 请求时解密使用；历史记录与日志不会保存明文，Renderer 之后只能看到是否已配置以及已配置的请求头名称。
- 内置米游社登录使用独立的 `persist:miyoushe-login` Chromium 分区。Cookie 会保存在 Chromium 的 Cookie 数据库中，并由 macOS Keychain、Windows DPAPI 或 Linux keyring 派生的 OSCrypt 密钥保护。Cookie 只在 Main 进程读取，不进入 Renderer；“退出米游社登录”会清除此分区的 Cookie。
- UID、Profile、推荐历史和场景缓存保存在本机 `userData`。应用没有遥测，不会把这些数据发给作者。
- 生成推荐时，经过裁剪的 Profile 摘要会发送给用户自己配置的 LLM `baseUrl`。摘要包含角色、等级、命座、天赋、武器、圣遗物摘要和核心属性；不包含 Cookie、API Key、图标 URL、原始响应或完整圣遗物副词条。
- Enka、米游社、HoYoLAB 与用户选择的 LLM Provider 是独立第三方；请求受各自隐私政策约束。

卸载程序默认保留 `userData`，防止误删 Profile 和加密凭据。若要彻底删除，请先在应用内退出米游社并清除 Key，再删除系统中的应用数据目录。

## English

genshin-team-advisor is a local-first desktop application. It has no author-operated backend, account system, or telemetry service.

- While the user is typing an LLM API key or custom-header value, plaintext briefly exists in renderer form state. After saving, it is not returned to the renderer. The main process encrypts it with Electron `safeStorage`, stores only ciphertext under application `userData`, and decrypts it only for provider/Agent SDK requests. Plaintext is not written to history or logs; afterward the renderer can see only whether a key is configured and the configured header names.
- Built-in MiHoYo sign-in uses an isolated `persist:miyoushe-login` Chromium partition. Cookies are persisted in Chromium's cookie database and protected by OSCrypt using macOS Keychain, Windows DPAPI, or a Linux keyring. Only the main process can read them. “Sign out of MiHoYo” clears the partition cookies.
- UID profiles, recommendation history, and scenario caches stay in local `userData`. There is no telemetry and this data is not sent to the author.
- Recommendation generation sends a compact profile summary to the user-configured LLM `baseUrl`. It may include characters, levels, constellations, talents, weapons, artifact summaries, and core stats. It excludes cookies, API keys, icon URLs, raw responses, and complete artifact substats.
- Enka, MiHoYo/HoYoLAB, and the selected LLM provider are independent third parties governed by their own privacy policies.

The uninstaller preserves `userData` by default to prevent accidental profile or credential loss. For a complete removal, sign out and clear the API key in the application, then remove the application data directory.
