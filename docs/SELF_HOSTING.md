# Self-hosting Guide (Advanced)

高级用户可自托管 Relay 服务与 Telegram Bot。

## 1. 启动 Relay

```bash
cd services/cloud-relay
npm install
npm run dev
```

## 2. 配置环境变量

- `TELEGRAM_BOT_TOKEN=<your bot token>`
- `RELAY_PUBLIC_BASE_URL=https://<your-domain>`
- `RELAY_BOT_USERNAME=<your bot username>`

## 3. 桌面端接入自托管 Relay

在桌面 App 设置页将 `relayBaseUrl` 改为你的 Relay 地址。

## 4. 生产建议

- 在反向代理层强制 HTTPS/WSS。
- 为 Relay 加入请求签名与速率限制。
- 将内存存储替换为 PostgreSQL + Redis。
