# Architecture / 架构

## English
### Layers
1. `packages/bridge-core`
   - `BridgeAgent`: turn orchestration
   - `runHealthChecks`: environment checks
   - `ConfigStore`: local config
   - `LaunchdServiceManager`: background service control
2. `apps/desktop`
   - Electron main process: IPC, pairing, relay connection, tray/menu, service control
   - React renderer: setup wizard + advanced settings
3. `services/cloud-relay`
   - pairing API
   - device WebSocket stream
   - Telegram bot ingress/egress

### First-time pairing flow
1. Desktop calls `POST /v1/pairing/sessions`.
2. Relay returns `pairingSessionId + qrPayload + expiresAt`.
3. User scans QR in Telegram (`/start pair_<id>_<code>`).
4. Relay confirms pairing and issues `deviceAccessToken`.
5. Desktop polls `GET /v1/pairing/sessions/:id` and stores token in Keychain.
6. Desktop connects to `wss://.../v1/devices/stream?token=...`.

### Remote execution flow
1. Telegram message arrives.
2. Relay routes message to bound device.
3. Device invokes `BridgeAgent.handleIncomingMessage`.
4. `BridgeAgent` executes turn via `codex app-server`.
5. Device emits `executionStatus/finalResponse`.
6. Relay forwards results back to Telegram.

## 中文
### 分层结构
1. `packages/bridge-core`
   - `BridgeAgent`：turn 执行编排
   - `runHealthChecks`：环境检测
   - `ConfigStore`：本地配置
   - `LaunchdServiceManager`：后台服务控制
2. `apps/desktop`
   - Electron 主进程：IPC、配对、relay 连接、菜单栏、服务控制
   - React 渲染层：初始化向导 + 高级配置
3. `services/cloud-relay`
   - 配对 API
   - 设备 WebSocket 通道
   - Telegram 入口与回包

### 首次配对流程
1. 桌面端调用 `POST /v1/pairing/sessions`。
2. Relay 返回 `pairingSessionId + qrPayload + expiresAt`。
3. 用户在 Telegram 扫码（`/start pair_<id>_<code>`）。
4. Relay 确认配对并签发 `deviceAccessToken`。
5. 桌面端轮询 `GET /v1/pairing/sessions/:id`，并写入 Keychain。
6. 桌面端通过 `wss://.../v1/devices/stream?token=...` 建连。

### 远程执行流程
1. Telegram 消息到达 relay。
2. Relay 按绑定关系路由到设备。
3. 设备调用 `BridgeAgent.handleIncomingMessage`。
4. `BridgeAgent` 通过 `codex app-server` 执行 turn。
5. 设备回传 `executionStatus/finalResponse`。
6. Relay 转发回 Telegram。
