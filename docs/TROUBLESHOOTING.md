# Troubleshooting / 故障排查

## English
1. `CODEX_NOT_FOUND`
- Ensure `codex --version` works.
- Ensure Codex App/CLI is installed.

2. `CODEX_NOT_AUTHENTICATED`
- Open Codex App and sign in.
- Re-run environment check.

3. Pairing stays `pending`
- Check relay `/healthz`.
- Ensure QR is not expired.
- Verify bot token/username.

4. Telegram no response
- Check desktop status is online/partial.
- Check thread is bound.
- Check relay logs for offline errors.

## 中文
1. `CODEX_NOT_FOUND`
- 确认 `codex --version` 可执行。
- 确认 Codex App/CLI 已安装。

2. `CODEX_NOT_AUTHENTICATED`
- 打开 Codex App 完成登录。
- 重新执行环境检测。

3. 配对一直 `pending`
- 检查 relay `/healthz`。
- 确认二维码未过期。
- 检查 bot token/username 是否正确。

4. Telegram 无回包
- 检查桌面端状态是否在线/部分可用。
- 检查线程是否已绑定。
- 检查 relay 日志中的离线错误。
