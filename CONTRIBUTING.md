# Contributing

感谢你参与 `codex-remote-bridge`。

## 开发环境

1. Node.js 20+
2. 安装依赖

```bash
npm install
cp .env.example .env
```

## 本地验证

```bash
npm run typecheck
npm run build
```

## 提交流程

1. Fork 并创建功能分支（示例：`feat/thread-list-ui`）。
2. 保持改动聚焦：一个 PR 解决一个问题。
3. 更新相关文档（`README.md` / `docs/*`）。
4. 提交前完成本地验证（typecheck + build）。
5. 在 PR 描述中写清楚：
   - 变更动机
   - 关键实现
   - 回归风险
   - 验证方式

## 代码约定

- 优先可读性和可观测性（日志、错误信息明确）。
- 不提交敏感信息（token、chat id、私钥、`.env`）。
- 新增配置必须同步更新：
  - `.env.example`
  - `docs/CONFIG.md`

## 问题反馈

- 功能建议与缺陷：使用 GitHub Issues。
- 安全问题：请遵循 `SECURITY.md`。
