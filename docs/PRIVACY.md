# Privacy Boundary / 隐私边界

## English
Default model: `Relay + local Codex execution`.

Data flow:
1. Telegram message reaches relay.
2. Relay routes to bound device.
3. Device calls local Codex App Server.
4. Result returns through relay to Telegram.

Stored data:
- Local: config, db, logs.
- Relay: pairing/binding metadata and operational logs.

Security notes:
- `deviceAccessToken` is stored in Keychain.
- Transport uses HTTPS/WSS when configured.
- Approvals require explicit allow/deny.

## 中文
默认模型：`Relay + 本地 Codex 执行`。

数据流：
1. Telegram 消息进入 relay。
2. Relay 路由到绑定设备。
3. 设备调用本地 Codex App Server。
4. 结果经 relay 返回 Telegram。

存储数据：
- 本地：配置、数据库、日志。
- Relay：配对/绑定元数据与运行日志。

安全说明：
- `deviceAccessToken` 存储在 Keychain。
- 传输层建议使用 HTTPS/WSS。
- 审批必须显式允许或拒绝。
