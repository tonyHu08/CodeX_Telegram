# Codex Bridge Desktop

[English](#english) | [中文](#中文)

## 中文

把 Codex 从“只能坐在电脑前用”，变成“手机 Telegram 随时远程用”。

### 这个项目解决什么痛点
- 你离开电脑后，Codex 对话无法继续跟进。
- 你在手机上只能看消息，不能像在 Codex 里那样继续驱动任务。
- 需要远程审批、查看状态、切换线程时，缺少统一入口。

Codex Bridge Desktop 的目标是：**让你用 Telegram 像远程控制台一样操作本机 Codex**，并尽量保持与 Codex 线程一致。

### 你现在可以做到什么
- 在 Telegram 中发送文本/图片，转给已绑定的 Codex thread 执行。
- 在 Telegram 中查看最近线程、绑定线程、查看当前对话快照。
- 在 Telegram 中处理审批（`/approve` / `/deny`）。
- 查询 Codex 用量（`/usage` 或 `/limits`）。
- 使用 macOS 菜单栏快速查看状态、启停远程能力。
- 使用桌面 App 完成首次引导、机器人配置、日志排查。

## 2-3 分钟上手（普通用户）

### 1) 下载并打开 App
1. 打开 Releases 页面下载最新版：  
   `https://github.com/tonyHu08/CodeX_Bridge/releases`
2. 安装并打开 `Codex Bridge Desktop`。
3. 保证本机已安装并登录 Codex App。

### 2) 配置 Telegram 机器人
1. 在 Telegram 打开 `@BotFather`。
2. 用 `/newbot` 创建机器人，拿到 Bot Token。
3. 在桌面 App 中粘贴 Token，保存并启用。

### 3) 手机配对
1. 在桌面 App 点击“开始配对”。
2. 用 Telegram 打开配对链接（或扫码）。
3. 配对成功后，机器人会回复已绑定。

### 4) 绑定要操作的 Codex 会话
1. 在 Telegram 里发送 `/threads`。
2. 选择线程按钮，或用 `/bind <编号>`、`/bind latest`。
3. 之后直接发消息即可远程驱动该线程。

### 5) 日常使用
- 直接发送文本任务（可附图）。
- 随时用 `/status`、`/current`、`/usage` 查看状态。
- 需要停止当前任务时用 `/cancel`。

## 常用 Telegram 命令
- `/threads`：查看最近线程并快速绑定
- `/bind latest`：绑定最新线程
- `/bind <index|threadId>`：绑定指定线程
- `/current`：查看当前绑定线程快照
- `/detail <index|threadId>`：查看线程详细信息
- `/usage` / `/limits`：查询 Codex 用量
- `/status`：查看桥接状态
- `/cancel`：终止当前运行并清空排队
- `/unbind`：解绑当前线程
- `/help`：帮助

## 技术实现（面向开发者）

### Monorepo 结构
- `apps/desktop`: Electron + React 桌面端（引导、主页、菜单栏）
- `packages/bridge-core`: 线程编排、审批、状态管理、Codex App Server 客户端
- `services/cloud-relay`: Relay 服务（可选，自托管场景）
- `src` (legacy): 历史实现

### 核心机制
- 使用 `codex app-server`（JSON-RPC）控制本机 thread：
  - `thread/list`、`thread/read`、`thread/resume`、`turn/start`
- Telegram 侧做消息接入、命令路由、审批回传。
- SQLite 持久化绑定、去重和审批状态。
- macOS 菜单栏常驻，桌面窗口用于配置与诊断。

### 本地开发
```bash
cd /path/to/codex-remote-bridge
npm install
npm run setup
npm run dev:relay
npm run build:desktop
npm run start:desktop
```

### 构建校验
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

### 文档
- [Configuration](./docs/CONFIG.md)
- [Commands](./docs/COMMANDS.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Operations](./docs/OPERATIONS.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Privacy](./docs/PRIVACY.md)
- [Self-hosting](./docs/SELF_HOSTING.md)
- [Threat model](./docs/THREAT_MODEL.md)

---

## English

Turn Codex from a desktop-only experience into a Telegram-based remote workflow.

### What this project solves
- You cannot continue Codex tasks when you are away from your computer.
- You need a mobile control surface for thread operations, status, and approvals.
- You want a practical remote bridge without changing your existing Codex workflow.

Codex Bridge Desktop lets you control local Codex threads from Telegram, with thread binding, status, approvals, and usage visibility.

### What you can do
- Send text/image messages from Telegram to a bound Codex thread.
- List and bind recent threads from Telegram.
- Handle approvals remotely (`/approve`, `/deny`).
- Check Codex rate limits (`/usage`, `/limits`).
- Use macOS tray/menu bar for quick status and remote on/off.

### Quick start (2-3 minutes)
1. Download the desktop app from Releases:  
   `https://github.com/tonyHu08/CodeX_Bridge/releases`
2. Open the app and complete the onboarding wizard.
3. Create a Telegram bot via `@BotFather` and paste the Bot Token.
4. Start pairing in the app, then open the pairing link in Telegram.
5. In Telegram, run `/threads` and bind a thread.
6. Send your message to start remote Codex execution.

### Development quick start
```bash
cd /path/to/codex-remote-bridge
npm install
npm run setup
npm run dev:relay
npm run build:desktop
npm run start:desktop
```
