# 配置说明

## 1) 桌面端（本地）配置

桌面端配置文件：`$HOME/.codex-bridge/config.json`

字段：

- `deviceId`
- `relayBaseUrl`（可在桌面端 GUI 中直接修改与检测连通性）
- `selectedThreadId`
- `autoStartAgent`
- `logLevel`

常用 `relayBaseUrl`：

- 官方共享 relay：`https://relay.codex-bridge.dev`
- 本地开发 relay：`http://127.0.0.1:8787`

敏感字段（`deviceAccessToken`）不在该文件中，存储在 macOS Keychain。

## 2) Cloud Relay 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | Relay 监听地址 |
| `PORT` | `8787` | Relay 监听端口 |
| `RELAY_PUBLIC_BASE_URL` | `http://127.0.0.1:8787` | 对外可访问地址 |
| `RELAY_BOT_USERNAME` | `codex_bridge_bot` | Telegram bot username（生成二维码链接） |
| `TELEGRAM_BOT_TOKEN` | 空 | 配置后启用真实 Telegram Bot 路由 |

## 3) Bridge Core 执行参数（由桌面端注入）

- `codexBin`（默认 `codex`）
- `fallbackModel`（默认 `gpt-5.2-codex`）
- `requestTimeoutMs`
- `turnTimeoutMs`
- `dbPath`（默认 `$HOME/.codex-bridge/data/codex_bridge.db`）

## 4) 运行时关键目录

- `$HOME/.codex-bridge/config.json`
- `$HOME/.codex-bridge/data/codex_bridge.db`
- `$HOME/.codex-bridge/logs/agent.log`
