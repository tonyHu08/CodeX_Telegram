# Telegram 命令（共享 Bot）

本页描述 Relay 接入 Telegram Bot 后支持的核心命令。

## 配对命令

- `/start pair_<pairingSessionId>_<code>`
  - 由桌面端二维码自动生成。
  - 成功后 chat 与设备绑定。

## 审批命令

- `/approve <approvalId>`
- `/deny <approvalId>`

审批命令会路由回当前绑定设备，用于处理 Codex 执行审批请求。

## 普通文本

- 默认将文本作为远程执行输入，发送到当前绑定设备。
- 如果未绑定，Bot 会提示先配对。

## 说明

首版不再要求用户自行创建 Bot（共享 Bot 模式）。
