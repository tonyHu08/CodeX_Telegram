# Codex Bridge Desktop

零配置远程能力（桌面 App + 共享 Relay + Codex 本地执行）。

目标体验：普通用户下载安装 DMG 后，打开 App 按向导点击即可完成配对和使用，不需要手动安装 Node/Homebrew，不需要命令行。

## Monorepo 结构

- `packages/bridge-core`
  - Codex 会话执行引擎、健康检测、配置存储、launchd 管理。
- `apps/desktop`
  - Electron + React GUI；负责向导、状态面板、线程绑定、服务控制。
- `services/cloud-relay`
  - Fastify + WebSocket Relay；负责共享 Bot 配对与消息路由。
- `src`（legacy）
  - 原 Telegram 本地桥接实现，保留用于兼容和迁移。

## 已实现能力（当前版本）

- 桌面 GUI（向导 + 主面板）
  - Codex 健康检测
  - Relay 地址管理与连通性检测（避免误连其它后端）
  - Telegram 配对二维码生成与轮询
  - 线程加载与绑定
  - Agent 状态查看
  - launchd 服务控制（install/start/stop/restart/uninstall）
- 共享 Relay 服务
  - `POST /v1/pairing/sessions`
  - `GET /v1/pairing/sessions/:id`
  - `POST /v1/pairing/sessions/:id/confirm`
  - `GET /v1/devices/me`
  - `WS /v1/devices/stream`
  - 可选 Telegram Bot 长轮询接入（配置 `TELEGRAM_BOT_TOKEN`）
- 本地 Agent 核心
  - 线程绑定后接收远程消息执行 turn
  - 回传执行状态与最终回复
  - 审批请求透传与审批决策回传

## 快速开发（开发者）

> 这一节是开发调试流程，不是最终用户安装流程。

### 1) 安装依赖

```bash
cd /Users/junweihu/clawd/codex-remote-bridge
npm install
npm run setup
```

### 2) 启动 relay

```bash
npm run dev:relay
```

默认监听 `http://127.0.0.1:8787`。

### 3) 启动桌面端（先构建再启动）

```bash
npm run build:desktop
npm run start:desktop
```

### 4) 质量检查

```bash
npm run typecheck
npm run build
```

## 云端 Relay 环境变量

- `PORT`（默认 `8787`）
- `HOST`（默认 `127.0.0.1`）
- `RELAY_PUBLIC_BASE_URL`（默认 `http://127.0.0.1:8787`）
- `RELAY_BOT_USERNAME`（默认 `codex_bridge_bot`）
- `TELEGRAM_BOT_TOKEN`（可选，配置后启用真实 Telegram Bot 路由）

## 本地数据目录（桌面端）

- `$HOME/.codex-bridge/config.json`
- `$HOME/.codex-bridge/data/codex_bridge.db`
- `$HOME/.codex-bridge/logs/agent.log`

## 发布目标（后续）

- macOS 签名 + 公证 DMG
- 自动更新（electron-updater）
- Homebrew cask（可选分发镜像，不作为前置依赖）

当前可用打包命令（开发验证）：

- `npm run dist:desktop:zip`（稳定）
- `npm run dist:desktop`（DMG，受本机 `hdiutil` 状态影响）

## 文档

- [配置说明](./docs/CONFIG.md)
- [命令与交互](./docs/COMMANDS.md)
- [架构与数据流](./docs/ARCHITECTURE.md)
- [部署与运维](./docs/OPERATIONS.md)
- [故障排查](./docs/TROUBLESHOOTING.md)
- [隐私边界](./docs/PRIVACY.md)
- [自托管指南](./docs/SELF_HOSTING.md)
- [威胁模型](./docs/THREAT_MODEL.md)
- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [行为准则](./CODE_OF_CONDUCT.md)
- [开源发布清单](./OPEN_SOURCE_CHECKLIST.md)
