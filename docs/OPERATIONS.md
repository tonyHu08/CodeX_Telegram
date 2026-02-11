# 部署与运维

## 本地开发运行

### 1. 安装依赖

```bash
cd /Users/junweihu/clawd/codex-remote-bridge
npm install
npm run setup
```

### 2. 启动 Relay

```bash
npm run dev:relay
```

### 3. 构建并启动桌面端

```bash
npm run build:desktop
npm run start:desktop
```

## 后台服务（launchd）

桌面端 GUI 内置操作：

- Install
- Start
- Stop
- Restart
- Status
- Uninstall

底层 label：`com.codex-bridge.agent`

## 常见检查

1. Relay 健康：`GET /healthz`
2. 桌面端“运行状态 -> Relay 地址”中确认目标 URL 与期望一致
3. 桌面端状态页中 `Relay 已连接`
4. 线程是否已绑定
5. 审批是否回流到 Telegram

## 构建与校验

```bash
npm run typecheck
npm run build
```

## 打包（DMG）

```bash
npm run dist:desktop
```

> 注意：签名与公证需要额外 Apple Developer 凭据配置（首版文档未内置自动化证书管理）。

## 打包（ZIP，推荐用于本地验证）

```bash
npm run dist:desktop:zip
```
