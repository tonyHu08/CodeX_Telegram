# 架构与数据流（Desktop + Relay）

## 三层架构

1. `packages/bridge-core`
   - `BridgeAgent`：Codex 执行编排
   - `runHealthChecks`：环境检测
   - `ConfigStore`：本地配置
   - `LaunchdServiceManager`：后台常驻控制
2. `apps/desktop`
   - Electron 主进程：IPC、配对、Relay 连接、服务控制
   - React 渲染层：向导、状态页、线程绑定
3. `services/cloud-relay`
   - 配对会话 API
   - 设备 WebSocket 通道
   - Telegram Bot 消息入口/出口

## 首次配对流

1. 桌面端 `startPairing` 调用 `POST /v1/pairing/sessions`。
2. Relay 返回 `pairingSessionId + qrPayload + expiresAt`。
3. 用户在 Telegram 扫码（`/start pair_<id>_<code>`）。
4. Relay 确认配对并生成 `deviceAccessToken`。
5. 桌面端轮询 `GET /v1/pairing/sessions/:id`，拿到 token 后写入 Keychain。
6. 桌面端通过 `wss://.../v1/devices/stream?token=...` 建连。

## 远程执行流

1. Telegram 用户发送文本给共享 Bot。
2. Relay 根据 chat 绑定关系将消息推送给对应设备。
3. 设备收到 `incomingUserMessage`，调用 `BridgeAgent.handleIncomingMessage`。
4. `BridgeAgent` 使用 `codex app-server` 执行 turn。
5. 设备回传 `executionStatus/finalResponse`。
6. Relay 转发到 Telegram。

## 审批流

1. Codex 发出审批请求。
2. 设备向 Relay 回传 `approvalRequest`。
3. Relay 发送 Telegram 审批提示（`/approve` / `/deny`）。
4. 用户回复命令后，Relay 向设备下发 `approvalDecision`。
5. 设备调用 `BridgeAgent.applyApprovalDecision`。

## 关键本地路径

- `$HOME/.codex-bridge/config.json`
- `$HOME/.codex-bridge/data/codex_bridge.db`
- `$HOME/.codex-bridge/logs/agent.log`

## 关键接口

### 本地 IPC

- `ipc.getHealth()`
- `ipc.startPairing()`
- `ipc.bindThread(threadId)`
- `ipc.getCurrentStatus()`
- `ipc.serviceControl(action)`

### Relay API

- `POST /v1/pairing/sessions`
- `GET /v1/pairing/sessions/:id`
- `POST /v1/pairing/sessions/:id/confirm`
- `GET /v1/devices/me`
- `WS /v1/devices/stream`
