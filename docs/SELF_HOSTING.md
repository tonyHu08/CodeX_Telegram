# Self-hosting / 自托管

## English
You can run your own relay and bot.

### Start relay
```bash
cd /path/to/codex-remote-bridge/services/cloud-relay
npm install
npm run dev
```

### Required env
- `TELEGRAM_BOT_TOKEN`
- `RELAY_PUBLIC_BASE_URL`
- `RELAY_BOT_USERNAME`

### Desktop side
Set desktop relay URL to your hosted relay endpoint.

## 中文
可以自托管 relay 和 bot。

### 启动 relay
```bash
cd /path/to/codex-remote-bridge/services/cloud-relay
npm install
npm run dev
```

### 必填环境变量
- `TELEGRAM_BOT_TOKEN`
- `RELAY_PUBLIC_BASE_URL`
- `RELAY_BOT_USERNAME`

### 桌面端接入
在桌面端将 relay 地址改为你的自托管地址。
