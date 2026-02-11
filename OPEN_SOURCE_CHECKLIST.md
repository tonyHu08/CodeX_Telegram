# Open Source Checklist / 开源检查清单

## English
### Repository hygiene
- [x] Git repo initialized
- [x] `main` as default branch
- [x] Sensitive files ignored (`.env`, db, logs, runtime files)
- [x] OSS basics present (`LICENSE`, `CONTRIBUTING`, `SECURITY`, `CODE_OF_CONDUCT`)

### Pre-publish checks
- [x] `.env.example` contains no real secrets
- [x] Docs/README reviewed
- [x] `npm run typecheck` passed
- [x] `npm run build` passed

### Publish steps
1. Create empty GitHub repo.
2. Set remote URL.
3. Push `main`.

## 中文
### 仓库准备
- [x] Git 仓库已初始化
- [x] 默认分支为 `main`
- [x] 已忽略敏感文件（`.env`、数据库、日志、运行时文件）
- [x] 已补齐开源基础文件（`LICENSE`、`CONTRIBUTING`、`SECURITY`、`CODE_OF_CONDUCT`）

### 发布前检查
- [x] `.env.example` 不含真实密钥
- [x] README/docs 已复核
- [x] `npm run typecheck` 通过
- [x] `npm run build` 通过

### 发布步骤
1. 在 GitHub 创建空仓库。
2. 配置远程地址。
3. 推送 `main`。
