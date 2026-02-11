# Privacy Boundary

本项目默认采用“共享 Relay + 本地 Codex 执行”模型：

1. Telegram 消息先进入 Relay 服务。
2. Relay 将消息路由到绑定设备。
3. 设备在本机调用 Codex App Server 执行。
4. 执行结果回到 Relay，再转发 Telegram。

## 默认保留策略

- 本地：
  - `config.json`（设备配置）
  - `codex_bridge.db`（绑定与执行状态）
  - `agent.log`
- Relay：
  - 配对会话和设备绑定（内存实现，后续可接 PostgreSQL）
  - 运行日志（默认不持久化完整对话正文）

## 敏感信息处理

- `deviceAccessToken` 存储在 macOS Keychain，不落地明文配置文件。
- Relay 与设备通过 TLS（`https/wss`）通信。
- 审批操作需显式确认（/approve / /deny）。

## 首版限制

- 首版不提供端到端加密。
- 首版默认单 Telegram 账号绑定单设备。
