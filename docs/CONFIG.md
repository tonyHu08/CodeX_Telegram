# Configuration / 配置

## English
### Desktop config
File: `$HOME/.codex-bridge/config.json`

Fields:
- `deviceId`
- `relayBaseUrl`
- `selectedThreadId`
- `autoStartAgent`
- `logLevel`
- `locale` (`zh` / `en`)

Sensitive token (`deviceAccessToken`) is stored in macOS Keychain.

### Relay env vars
| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Relay bind host |
| `PORT` | `8787` | Relay bind port |
| `RELAY_PUBLIC_BASE_URL` | `http://127.0.0.1:8787` | Public relay base URL |
| `RELAY_BOT_USERNAME` | `codex_bridge_bot` | Bot username for pairing link |
| `TELEGRAM_BOT_TOKEN` | empty | Enable Telegram routing |
| `BRIDGE_LOCALE` | `zh` | Telegram response locale (`zh`/`en`) |

## 中文
### 桌面端配置
文件：`$HOME/.codex-bridge/config.json`

字段：
- `deviceId`
- `relayBaseUrl`
- `selectedThreadId`
- `autoStartAgent`
- `logLevel`
- `locale`（`zh` / `en`）

敏感令牌（`deviceAccessToken`）保存在 macOS Keychain。

### Relay 环境变量
| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | Relay 监听地址 |
| `PORT` | `8787` | Relay 监听端口 |
| `RELAY_PUBLIC_BASE_URL` | `http://127.0.0.1:8787` | 对外可访问地址 |
| `RELAY_BOT_USERNAME` | `codex_bridge_bot` | 配对链接使用的 Bot 用户名 |
| `TELEGRAM_BOT_TOKEN` | 空 | 配置后启用 Telegram 路由 |
| `BRIDGE_LOCALE` | `zh` | Telegram 文案语言（`zh`/`en`） |
