# 故障排查

## 1) 桌面端显示 `CODEX_NOT_FOUND`

- 确认本机可执行 `codex --version`。
- 确认 Codex App/CLI 已安装。

## 2) `CODEX_NOT_AUTHENTICATED`

- 打开 Codex App 完成登录。
- 重新点击桌面端“重新检测”。

## 3) 配对一直 pending

- 检查 Relay 是否可访问（`/healthz`）。
- 检查二维码是否过期（默认 5 分钟）。
- 检查 Telegram Bot token / username 是否正确。

## 4) 请求发到了错误后端地址

- 在桌面端“运行状态 -> Relay 地址”确认当前 URL。
- 点击“检测 Relay”，检查目标地址与服务返回地址是否一致。
- 如本地调试，切换到 `http://127.0.0.1:8787` 后重新配对。

## 5) Telegram 发消息无响应

- 桌面端是否显示 `Relay 已连接`。
- 线程是否已绑定。
- 查看 Relay 日志是否有设备离线提示。

## 6) 审批无法生效

- 确认 `approvalId` 未过期。
- 确认消息发往了当前绑定设备。
- 检查设备 websocket 连接状态。

## 7) 重启电脑后离线

- 在桌面端执行服务 Install + Start。
- 检查 launchd 状态是否 running。

## 8) DMG 打包失败（`hdiutil ... 35`）

- 这是 macOS 磁盘镜像工具临时占用导致，可先用 `npm run dist:desktop:zip` 验证构建链路。
- 关闭可能占用 DMG 的 Finder/磁盘工具窗口后重试 `npm run dist:desktop`。
