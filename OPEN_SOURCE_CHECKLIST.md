# Open Source Checklist

## 1. 本地仓库

- [x] 独立仓库已初始化（`git init`）
- [x] 分支默认设为 `main`
- [x] 敏感文件已忽略（`.env`、数据库、日志、运行时文件）
- [x] 开源基础文件已补齐（License / Contributing / Security / CoC）

## 2. 发布前自检

- [ ] 检查 `.env.example` 无真实 token/chat id
- [ ] `README.md` 与 `docs/*` 无本机绝对路径
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 3. 推送到 GitHub

1. 在 GitHub 创建空仓库（不要勾选 README / License 初始化）。
2. 绑定远端并推送：

```bash
git remote add origin <your-github-repo-url>
git add .
git commit -m "chore: initialize open-source repository"
git push -u origin main
```

## 4. 建议的仓库设置

- 开启 branch protection（`main`）
- 开启 Dependabot alerts
- 开启 secret scanning
- 配置 issue/pr 模板（可选）
- 配置 GitHub Actions CI（建议至少 typecheck + build）

## 5. 首次发布版本（可选）

```bash
git tag -a v0.1.0 -m "Initial open-source release"
git push origin v0.1.0
```
