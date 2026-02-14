# Codex Bridge Desktop

[English](#english) | [中文](#中文)

## English
Zero-configuration remote control for Codex (`Desktop App + Relay + local Codex execution`).

Goal: users download the app, complete setup in the wizard, and control Codex from Telegram without command-line steps.

### Monorepo
- `packages/bridge-core`: execution orchestration, health checks, config, launchd manager.
- `apps/desktop`: Electron + React desktop app (wizard + advanced settings + menu bar entry).
- `services/cloud-relay`: Fastify + WebSocket relay service.
- `src` (legacy): previous bridge implementation kept for compatibility.

### Current capabilities
- Desktop setup wizard + app home (Current Status / Advanced Settings / Logs & Feedback).
- Telegram bot pairing via QR code.
- Bound-thread remote turns with status + final response.
- Telegram usage query (`/usage`, alias `/limits`).
- Thread list with live per-thread task state in `/threads`.
- Approval routing (`/approve` / `/deny`).
- Menu bar control (status, remote on/off, open settings).
- i18n support for **English + Chinese** (`en`/`zh`) across desktop UI, tray, and Telegram responses.

### Dev quick start
```bash
cd /Users/junweihu/clawd/codex-remote-bridge
npm install
npm run setup
npm run dev:relay
npm run build:desktop
npm run start:desktop
```

### Quality checks
```bash
npm run typecheck
npm run build
```

### Key environment variables
- `HOST` (default `127.0.0.1`)
- `PORT` (default `8787`)
- `RELAY_PUBLIC_BASE_URL` (default `http://127.0.0.1:8787`)
- `RELAY_BOT_USERNAME`
- `TELEGRAM_BOT_TOKEN`
- `BRIDGE_LOCALE` (`zh` or `en`)

### Local data paths
- `$HOME/.codex-bridge/config.json`
- `$HOME/.codex-bridge/data/codex_bridge.db`
- `$HOME/.codex-bridge/logs/agent.log`

### Documents
- [Configuration](./docs/CONFIG.md)
- [Commands](./docs/COMMANDS.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Operations](./docs/OPERATIONS.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Privacy](./docs/PRIVACY.md)
- [Self-hosting](./docs/SELF_HOSTING.md)
- [Threat model](./docs/THREAT_MODEL.md)
- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Open Source Checklist](./OPEN_SOURCE_CHECKLIST.md)

---

## 中文
零配置远程控制能力（`桌面 App + Relay + 本地 Codex 执行`）。

目标体验：用户下载安装后，通过向导完成配对，即可用 Telegram 远程操作 Codex，无需命令行。

### Monorepo 结构
- `packages/bridge-core`：执行编排、健康检测、配置与 launchd 管理。
- `apps/desktop`：Electron + React 桌面端（向导、设置、菜单栏入口）。
- `services/cloud-relay`：Fastify + WebSocket Relay 服务。
- `src`（legacy）：历史桥接实现，保留兼容用途。

### 当前能力
- 桌面端向导 + 应用主页（当前状态 / 高级设置 / 日志与反馈）。
- Telegram 二维码配对。
- 绑定线程后的远程执行（状态 + 最终回包）。
- Telegram 用量查询（`/usage`，兼容 `/limits`）。
- `/threads` 中展示每个会话的实时任务状态。
- 审批流转（`/approve` / `/deny`）。
- 菜单栏控制（状态、远程开关、打开设置）。
- 国际化：桌面 UI、菜单栏、Telegram 回包支持 **中英文**（`zh`/`en`）。

### 开发快速开始
```bash
cd /Users/junweihu/clawd/codex-remote-bridge
npm install
npm run setup
npm run dev:relay
npm run build:desktop
npm run start:desktop
```

### 质量检查
```bash
npm run typecheck
npm run build
```

### 关键环境变量
- `HOST`（默认 `127.0.0.1`）
- `PORT`（默认 `8787`）
- `RELAY_PUBLIC_BASE_URL`（默认 `http://127.0.0.1:8787`）
- `RELAY_BOT_USERNAME`
- `TELEGRAM_BOT_TOKEN`
- `BRIDGE_LOCALE`（`zh` 或 `en`）

### 本地数据路径
- `$HOME/.codex-bridge/config.json`
- `$HOME/.codex-bridge/data/codex_bridge.db`
- `$HOME/.codex-bridge/logs/agent.log`
