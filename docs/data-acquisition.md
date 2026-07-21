# 数据获取 / Data acquisition

## 推荐路径：内置浏览器登录米游社

1. 打开“绑定”，选择“用内置浏览器登录米游社”。
2. 在隔离窗口中扫码或使用账号密码登录。
3. 应用检测到 `ltoken_v2`、`ltuid_v2`、`ltmid_v2` 后自动关闭窗口并列出账号下的 UID。
4. 选择 UID；应用从米游社战绩或养成计算器同步接口获取完整 owned roster，再用 Enka 展示柜补强精确面板。

如果战绩接口触发 5003，应用会自动使用养成计算器同步，不需要重复验证码。若用户尚未在米游社开启养成计算器同步，应用会明确提示并保留已有权威缓存，不会自动修改隐私设置。

登录 Cookie 保存在隔离的 Chromium 分区并由系统凭据保护，只能被 Main 进程读取。角色页可以随时退出并清除。

## 备选：手动 Cookie

在已登录 `https://www.miyoushe.com/ys/` 的浏览器中打开开发者工具 → Application → Cookies，复制以下三对值并用分号连接：

```text
ltoken_v2=...; ltuid_v2=...; ltmid_v2=...
```

手动 Cookie 通过一次 IPC 调用进入 Main 进程，不会写入 Profile 或历史。不要把 Cookie 粘贴到 issue、日志或聊天中。

## 无登录预览：Enka UID

Enka 只能读取游戏内公开展示柜中的角色；展示数量由当前游戏和展示柜配置决定，不代表账号完整角色池。关闭或清空展示柜不表示账号没有角色。应用尊重 Enka 的 TTL 与 429 限频，并将 Enka 作为精确补强而非全角色 ownership 来源。纯 Enka 档案始终标记为部分数据。

## English quick start

Open **Connect**, sign in through the isolated browser, choose a linked UID, and let the app fetch the full MiHoYo roster plus Enka showcase details. The sign-in cookie is protected by the operating-system credential store and never reaches the renderer. Manual cookie entry is available under **Advanced**, but never share that cookie in an issue, log, or chat. Enka without sign-in is a showcase-only preview and cannot prove the complete owned roster.
