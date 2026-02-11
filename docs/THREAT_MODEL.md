# Threat Model / 威胁模型

## English
### Assets
- `deviceAccessToken`
- Telegram session control
- Local Codex execution privileges

### Risks
1. Token leakage
2. Lost/stolen device
3. Message replay
4. Approval hijack
5. Relay outage

### Mitigations
- Keychain storage
- Re-pair and revoke flows
- Idempotency keys and dedup
- Approval scope validation
- Auto-reconnect and status reporting

## 中文
### 资产
- `deviceAccessToken`
- Telegram 会话控制权
- 本地 Codex 执行权限

### 风险
1. token 泄露
2. 设备丢失/被盗
3. 消息重放
4. 审批劫持
5. relay 中断

### 缓解
- Keychain 存储
- 重配对与撤销机制
- 幂等与去重
- 审批范围校验
- 自动重连与状态回报
